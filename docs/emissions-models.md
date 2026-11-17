# Emissions Models

This document describes the per-flight emissions models implemented in
`server/index.js`: the **Adapted Travel Impact Model (ATIM)**, the optional
**EUROCONTROL Fast Model**, and the **Combined Model**. It is written so that each
model can be reimplemented from the description alone, and each section ends with a
fully worked example for a single flight.

(A fourth methodology, the "EUROCONTROL Slow Model", delegates to the vendored
`flight-emissions` Python package via `server/ghgc_bridge.py` and is not covered here.)

## Shared inputs and constants

Every model works from a flight event row with these fields:

- Takeoff and landing coordinates, stored as integer degrees × 10⁷
  (`takeoff_lat_e7`, `takeoff_lon_e7`, `landing_lat_e7`, `landing_lon_e7`). Divide by
  10⁷ to get decimal degrees. These are the coordinates of the **matched airports**,
  not the raw track endpoints, so all model distances are airport-to-airport great
  circles. If any coordinate is missing or non-finite, the flight cannot be estimated.
- Aircraft `manufacturer` and `model` text (free-form strings; provenance below).
- An `aircraft_type` classification string (e.g. `business_jet`, `turboprop`).

### Where the metadata comes from

The event rows are assembled at query time by joining three SQLite databases
that [adsbfi-proxy](https://github.com/kylemcdonald/adsbfi-proxy) builds and keeps
current (`server/flight-sql.js` `LEFT JOIN`s them on `icao_id` and airport ids):

- **`events.sqlite`** — individual takeoff and landing movements inferred from the
  public [adsb.fi](https://adsb.fi) heatmap archive. Each movement carries the
  aircraft's 24-bit ICAO (Mode S) transponder address — the hex code broadcast over
  ADS-B, parsed as an integer `icao_id` — plus a timestamp and the matched airport
  id. PJET pairs a takeoff with the directly following landing of the same aircraft
  (within 20 hours) to form a flight; see the README. No aircraft identity beyond
  the ICAO address is stored on a movement.
- **`airports.sqlite`** — airport codes, names, and coordinates imported from the
  [OurAirports](https://ourairports.com/data/) open dataset. This is where the
  `*_lat_e7`/`*_lon_e7` values above come from.
- **`aircraft.sqlite`** — the source of `manufacturer`, `model`, `icao_type` (the
  registry-reported ICAO Doc 8643 type designator, e.g. `GLF6`), and
  `aircraft_type`. adsbfi-proxy's `import-aircraft` merges the FAA aircraft
  registry with several public aircraft databases keyed by the same ICAO address,
  and computes `aircraft_type` (`business_jet`, `commercial_jet`, `turboprop`,
  `piston`, `helicopter`, and so on) from the merged registry fields, ICAO type
  designators and airframe descriptors. Its README lists the sources and the
  classification. Because the FAA registry takes precedence, US-registered
  aircraft usually carry FAA-style strings such as `TEXTRON AVIATION INC` / `700`,
  which is why the profile aliases and regex patterns in the models must match
  registry codes (`525C`, `680A`) as well as marketing names (`Citation CJ4`).

If an event's ICAO address has no row in `aircraft.sqlite`, the join leaves
`manufacturer`/`model` null and `aircraft_type` reported as `unknown`, and none of the
models below can produce an estimate for it.

Aircraft text matching always uses a normalized form: uppercase the string, replace
every run of non-alphanumeric characters with a single space, and trim. So
`"Cessna 525C / CJ4"` normalizes to `"CESSNA 525C CJ4"`.

Great-circle distance is the haversine formula:

```
a  = sin²(Δlat/2) + cos(lat₁)·cos(lat₂)·sin²(Δlon/2)
d  = R · 2·asin(√a)
```

with `R = 3440.065 NM` when the result is wanted in nautical miles and `R = 6371 km`
when wanted in kilometers (1 NM = 1.852 km).

Shared constants:

| Constant | Value | Meaning |
| --- | ---: | --- |
| `JET_A_KG_PER_GALLON` | 3.03 | Jet A fuel density, kg per US gallon |
| `TANK_TO_WAKE_CO2E_KG_PER_KG_FUEL` | 3.1894 | kg CO₂e emitted per kg of fuel burned (combustion) |
| `WELL_TO_TANK_CO2E_KG_PER_KG_FUEL` | 0.6465 | kg CO₂e per kg of fuel from producing and delivering the fuel |
| `LATERAL_INEFFICIENCY_FACTOR` | 1.052 | ATIM route-distance uplift (flights don't fly perfect great circles) |
| `EUROCONTROL_GCD_CORRECTION_KM` | 95 | EUROCONTROL's fixed great-circle-distance correction, km |
| `EUROCONTROL_MAX_DISTANCE_NM` | 999,999 | Sentinel used as the last breakpoint of every fuel curve |
| `EUROCONTROL_JET_TURBOPROP_CO2_COEFF` | 3.16 | EU ETS kg CO₂ per kg fuel, applied to SET jet/turboprop rows |

All reported CO₂e/fuel outputs are rounded to 2 decimal places at the end;
intermediate arithmetic is done at full floating-point precision.

Models that support a well-to-tank toggle (`includeWellToTank`, default **on**) always
compute both components; the toggle only controls which total is reported as
`totalCo2eKg`.

---

## 1. Adapted Travel Impact Model (ATIM, `adapted_tim`)

ATIM estimates fuel burn from a per-aircraft-model cruise fuel rate and cruise speed,
sourced from public specifications. Profiles and their citations are listed in
[`emissions_profiles.md`](emissions_profiles.md).

### Step 1 — Select an aircraft profile

1. The flight's `aircraft_type` must be one of: `business_jet`, `commercial_jet`,
   `military`, `turboprop`, `commercial_turboprop`. Anything else → no estimate.
2. Candidate profiles: if the type is `turboprop` or `commercial_turboprop`, only the
   turboprop profiles are considered; otherwise every profile is considered.
3. Each profile carries a list of match aliases (e.g. `"Citation CJ4"`, or
   `{ value: "525C", manufacturers: ["Cessna", "Textron"] }`). An alias matches when
   its normalized text appears as a whole-word substring of the flight's normalized
   `model` text (or of `manufacturer + " " + model` when the alias is flagged
   `includeManufacturer`). Aliases that specify `manufacturers` additionally require
   one of those manufacturer strings to appear in the flight's manufacturer or
   combined text.
4. A matching alias scores the length of its normalized text; the profile with the
   highest score wins (longer, more specific aliases beat shorter ones; ties go to the
   earlier profile in the list). A winning match is recorded with
   `profileSource: "model_match"`.
5. If nothing matches and the type is exactly `business_jet`, a generic fallback
   profile is used — the Citation CJ4's numbers relabeled
   "Generic business jet (CJ4 assumptions)" with `profileSource:
   "business_jet_fallback"` — **unless** the combined manufacturer+model text is empty
   or matches any of the fallback-exclusion patterns (airliners, regional jets, piston
   aircraft, trainers, military types, etc.; see `BUSINESS_JET_FALLBACK_EXCLUSIONS`).
6. No profile → no ATIM estimate for the flight.

Each profile provides two numbers: `burnGph` (cruise fuel burn, US gallons/hour) and
`speedKts` (cruise speed, knots).

### Step 2 — Distance and time

```
greatCircleNm      = haversine(takeoff, landing) in NM
adjustedDistanceNm = greatCircleNm × 1.052
flightTimeHours    = adjustedDistanceNm / speedKts
```

### Step 3 — Fuel

```
ltoGallons    = 0.1 × burnGph            # fixed landing/takeoff-cycle allowance:
                                         # 6 minutes of cruise-rate burn
cruiseGallons = flightTimeHours × burnGph
totalGallons  = cruiseGallons + ltoGallons
totalFuelKg   = totalGallons × 3.03
```

### Step 4 — Emissions

```
tankToWakeCo2eKg = totalFuelKg × 3.1894
wellToTankCo2eKg = totalFuelKg × 0.6465
totalCo2eKg      = tankToWakeCo2eKg (+ wellToTankCo2eKg if includeWellToTank)
```

### Worked example

Flight: a Cessna Citation CJ4 (`manufacturer = "CESSNA"`, `model = "525C"`,
`aircraft_type = "business_jet"`) from Teterboro, NJ (40.8501, −74.0608) to
West Palm Beach, FL (26.6832, −80.0956).

1. Profile: the alias `525C` (with manufacturer constraint "Cessna") matches →
   **Citation CJ4**, `burnGph = 209`, `speedKts = 451`.
2. Distance: `greatCircleNm = 901.73`; adjusted `= 901.73 × 1.052 = 948.62 NM`.
3. Time: `948.62 / 451 = 2.1034 h`.
4. Fuel: LTO `= 0.1 × 209 = 20.9 gal`; cruise `= 2.1034 × 209 = 439.60 gal`;
   total `= 460.50 gal`; in kg `= 460.50 × 3.03 = 1395.33 kg`.
5. Emissions: tank-to-wake `= 1395.33 × 3.1894 = 4450.25 kg CO₂e`;
   well-to-tank `= 1395.33 × 0.6465 = 902.08 kg CO₂e`.
6. Reported total (well-to-tank included): **5352.33 kg CO₂e** (≈ 5.35 t);
   without well-to-tank: 4450.25 kg.

---

## 2. EUROCONTROL Fast Model (`eurocontrol_fast`)

This model reimplements EUROCONTROL's Small Emitters Tool (SET, 2025 release —
workbook v5.15, November 2025) fuel curves directly in the Node server (hence "fast" —
no Python round-trip). Each ICAO aircraft type has a piecewise-linear
fuel-vs-distance curve; fuel converts to CO₂ with a per-type coefficient. It reports
**CO₂ from fuel burn only** — the well-to-tank toggle has no effect (both totals are
set to the same tank-to-wake value).

### Step 1 — Resolve the ICAO aircraft type code

Resolution is **registry-designator-first**. The aircraft registries merged into
`aircraft.sqlite` report each airframe's ICAO Doc 8643 type designator; the import stores it as `icao_type` (normalized to 2–4
uppercase alphanumerics; `ZZZZ`, "type not assigned", becomes null). When a flight's
aircraft has an `icao_type`, that designator is the type code, after two small
correction layers:

- `EUROCONTROL_REGISTRY_TYPE_ALIASES` maps designators without a SET curve to a
  close variant that has one (currently `E45X` → `E145`).
- `EUROCONTROL_DISTRUSTED_REGISTRY_TYPES` lists designators the registries commonly
  misassign; when the model-text pattern (below) disagrees with one, the pattern
  wins. Currently just `G200`: some registries tag Gulfstream G200s with the Giles
  G-200 kit plane's designator.

Only when the aircraft has **no** registry designator does the resolver fall back to
text matching: the normalized `manufacturer + " " + model` text is tested against an
ordered list of regular expressions (`EUROCONTROL_AIRCRAFT_CODE_PATTERNS`); the
**first** matching pattern yields the code. Examples: `CITATION CJ4` or `525C` →
`C25C`; `CITATION LONGITUDE` → `C700`; `GULFSTREAM G650` → `GLF6`. Neither source →
unsupported (`aircraft_not_supported`). Estimates report which source resolved the
code in `eurocontrolCurveBasis` (`registry ICAO type designator` or
`model text pattern`).

Registry designators cover ~97% of observed flights (and ~96% carry a SET curve),
versus ~7% for the pattern list, so the patterns are effectively a curated fallback
for aircraft the registries haven't typed. They are kept 8643-correct: beware
marketing names that differ from designators — the Gulfstream G200/Galaxy is `GALX`
(SET's `G200` row is the Giles G-200, a single-seat piston kit plane), the Citation
S/II (`S550`) shares `C550` with the Citation II while the Citation II/SP (`551`) is
`C551`, the Bravo is `C55B`, the M2 is `C25M`, and within the BD-700 family the
Global 5000/6000/6500 are `GLEX` but the Global 5500 is `GL5T` and the 7000/7500/8000
are `GL7T` (FAA registers the 7500 as model `BD-700-2A12`).

### Step 2 — Look up the fuel curve

When an operator has obtained the SET workbook under the applicable data-use
agreement, curves can be exported to the local, untracked `data/eurocontrol.csv`
path or supplied through `PJET_EUROCONTROL_CURVES`. PJET deliberately does not
redistribute the workbook or its derived curve table. The optional CSV is keyed by
`ICAO_TYPE_CODE`, with columns:

| Column | Meaning |
| --- | --- |
| `CO2_COEFF` | kg CO₂ per kg fuel as shipped (3.15 jet/turboprop, 3.10 piston) |
| `CORR_FACTOR` | multiplicative fuel correction (default 1 when blank) |
| `BreakPoint_1`, `BreakPoint_2` | segment boundaries in NM (blank when unused) |
| `Slope_1..3` | segment slopes, kg fuel per NM |
| `Intercept_1..3` | segment intercepts, kg fuel |

The CSV is exported from the official SET workbook's hidden `Data` sheet by
`scripts/export-eurocontrol-set-csv.py`. At load time the server replaces any
`CO2_COEFF ≥ 3.15` with **3.16** — the EU/EEA/Swiss ETS Jet A conversion factor in
force since January 2024 — mirroring the SET v5.15 calculator, which substitutes the
selected jet/turboprop factor and leaves the 3.10 piston factor untouched. (The
vendored Python package behind the Slow Model reads the same configured CSV, but it
applies the per-row coefficients without this override.)

A resolved ICAO code with no CSV row → unsupported (`aircraft_not_in_method_dataset`).

### Step 3 — Corrected distance

```
greatCircleKm       = haversine(takeoff, landing) in km
correctedDistanceKm = greatCircleKm + 95
correctedDistanceNm = correctedDistanceKm / 1.852
```

Missing coordinates → unsupported (`missing_route_coordinates`).

### Step 4 — Interpolate fuel

Build up to four polyline knots, evaluating each segment's own line at its end
boundary:

```
xp = [0,            BP₁,             BP₂ or 999999,      999999]
yp = [I₁,           I₁ + S₁·BP₁,     I₂ + S₂·(BP₂ or 999999),  I₃ + S₃·999999]
```

Truncate both arrays at the first knot whose x or y is missing/non-finite, keeping at
least the first two. Then linearly interpolate `correctedDistanceNm` on the resulting
polyline: find the first knot with `x > distance` and interpolate between it and the
previous knot (distances below BP₁ therefore evaluate to `I₁ + S₁·d`; distances past
the last knot extrapolate along the final segment). Finally:

```
fuelKg           = interpolatedFuelKg × CORR_FACTOR
tankToWakeCo2Kg  = fuelKg × CO2_COEFF     # 3.16 jet/turboprop, 3.10 piston
totalCo2eKg      = tankToWakeCo2Kg        # no well-to-tank component, ever
```

### Worked example

Same flight: Citation CJ4, Teterboro → West Palm Beach.

1. ICAO code: `525C` matches the pattern for **C25C**.
2. Curve row for C25C: `CO2_COEFF = 3.15` (replaced with 3.16 at load),
   `CORR_FACTOR = 1`, breakpoints `[215, 999999]`, slopes
   `[2.084906471, 1.102501925]`, intercepts `[88.17755327, 299.3945306]` (third
   segment unused). Since SET 2025 the CJ4 has its own operator-sample curve instead
   of the corrected Citation II proxy it used in SET 2022.
3. Distance: `greatCircleKm = 1670.00`; corrected `= 1765.00 km = 953.02 NM`.
4. Knots: `(0, 88.18)`, `(215, 88.17755327 + 2.084906471×215 = 536.43)`,
   `(999999, 299.3945306 + 1.102501925×999999 = 1,102,800.22)`. 953.02 NM falls in
   the second segment:
   `raw = 536.43 + 1.102501925 × (953.02 − 215) = 1350.11 kg`.
5. Correction: `fuelKg = 1350.11 × 1 = 1350.11 kg`.
6. CO₂: `1350.11 × 3.16 =` **4266.33 kg CO₂** (≈ 4.27 t). The well-to-tank toggle
   does not change this number.

---

## 3. Combined Model (`combined`)

The Combined Model prefers the EUROCONTROL SET curve for fuel burn (it is
distance-sensitive and empirically fitted), adds ATIM's well-to-tank component on top,
and falls back to an ATIM-derived curve when the aircraft has no usable SET curve.
This gives EUROCONTROL-quality fuel numbers where available with ATIM's broader
aircraft coverage everywhere else.

### Primary branch — EUROCONTROL curve plus well-to-tank

Used when the flight resolves to an ICAO type code that has a curve **and** the code
is not on the suspicious list (`EUROCONTROL_SUSPICIOUS_ICAO_CODES`, currently empty —
it previously held `G200`, which turned out to be a designator mix-up rather than a
bad curve: the Gulfstream G200 is `GALX`, while SET's `G200` is the Giles G-200
piston kit plane) **and** route coordinates exist.

Fuel is computed exactly as in the EUROCONTROL Fast Model (steps 3–4 above:
great-circle km + 95 km, piecewise interpolation, correction factor). Then:

```
tankToWakeCo2eKg = fuelKg × CO2_COEFF          # per-type, 3.16 for jets/turboprops
wellToTankCo2eKg = fuelKg × 0.6465             # ATIM's well-to-tank factor
totalCo2eKg      = tankToWake (+ wellToTank if includeWellToTank, default on)
```

The result is tagged `calculationSource: "eurocontrol_curve"`. The flight's ATIM
profile (if any) is still attached for display purposes (profile name, burn rate,
sources), but does not affect the numbers.

### Fallback branch — ATIM-derived one-segment curve

Used when there is no usable curve. The ATIM profile is re-expressed as a
single-segment EUROCONTROL-style curve:

```
interceptKg  = 0.1 × burnGph × 3.03            # ATIM's LTO allowance, in kg
slopeKgPerNm = (burnGph × 3.03) / speedKts     # kg of fuel per NM at cruise
distanceNm   = greatCircleNm × 1.052           # ATIM's lateral inefficiency (no +95 km)
fuelKg       = interceptKg + slopeKgPerNm × distanceNm
tankToWakeCo2eKg = fuelKg × 3.1894
wellToTankCo2eKg = fuelKg × 0.6465
```

This is algebraically identical to the ATIM estimate — same fuel mass, same factors —
just reshaped into intercept/slope form. It is tagged
`calculationSource: "atim_derived_curve"` with a `fallbackReason` of
`aircraft_not_supported_by_eurocontrol` (no ICAO code), `eurocontrol_curve_missing`
(code but no CSV row), or `suspicious_eurocontrol_curve_<code>`.

If neither branch can produce a number (no curve and no ATIM profile, or no
coordinates), the estimate is unsupported with reason `combined_inputs_unavailable`.

### Worked example

Same flight: Citation CJ4, Teterboro → West Palm Beach.

1. The C25C curve exists and is not suspicious → primary branch.
2. Fuel, exactly as in the EUROCONTROL example: `fuelKg = 1350.11`.
3. Tank-to-wake: `1350.11 × 3.16 = 4266.33 kg`.
4. Well-to-tank: `1350.11 × 0.6465 = 872.84 kg`.
5. Reported total (well-to-tank on): **5139.18 kg CO₂e** (≈ 5.14 t); with the toggle
   off: 4266.33 kg.

For contrast, if this aircraft had *not* had a SET curve, the fallback would compute
`intercept = 0.1 × 209 × 3.03 = 63.33 kg`, `slope = 209 × 3.03 / 451 = 1.40415 kg/NM`,
`fuel = 63.33 + 1.40415 × 948.62 = 1395.33 kg`, and a well-to-tank-inclusive total of
5352.33 kg — identical to the ATIM example.

---

## Comparing the three models

| | ATIM | EUROCONTROL Fast | Combined |
| --- | --- | --- | --- |
| Fuel basis | cruise gph × time + LTO allowance | SET piecewise distance curve | SET curve, else ATIM fallback |
| Distance uplift | GC × 1.052 | GC + 95 km | matches whichever branch is used |
| Combustion factor | 3.1894 kg CO₂e/kg fuel | per-type `CO2_COEFF` (3.16 jet/turboprop, 3.10 piston) | branch-dependent (3.16 curve / 3.1894 fallback) |
| Well-to-tank | optional, default on | never | optional, default on |
| Coverage | profiles + business-jet fallback | registry designator (or regex fallback) → SET row | union of the other two |

Two consequences worth noting when interpreting outputs. First, ATIM's 3.1894 factor
is CO₂-equivalent (it includes non-CO₂ combustion gases), while the SET coefficient is
CO₂ only, so ATIM runs slightly "hotter" per kg of fuel. Second, within the Combined
Model a fleet can mix `eurocontrol_curve` and `atim_derived_curve` flights; the
`calculationSource` field on each estimate says which path produced it.

For the example flight the three models land at 5352 kg (ATIM, with well-to-tank),
4266 kg (EUROCONTROL, combustion only), and 5139 kg (Combined, with well-to-tank) —
differences driven almost entirely by the well-to-tank component and the two distance
corrections, with the SET 2025 curve estimating about 3% less fuel burn than the
CJ4's flat cruise-rate profile on this route.
