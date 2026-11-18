# Private Jet Emissions Tracker

PJET is an authenticated API and browser frontend for exploring private-jet
flights and estimating their emissions. You choose airports, a time range and an
aircraft class; PJET lists the matching flights, airport operation counts and
per-flight emissions estimates.

PJET does not process ADS-B data itself. It reads the movement ledger built by
[adsbfi-proxy](https://github.com/kylemcdonald/adsbfi-proxy), which turns the
public [adsb.fi](https://adsb.fi) heatmap archive into SQLite records of aircraft
takeoffs and landings. PJET only reads these records. A separate adsbfi-proxy
worker downloads each new 30-minute heatmap file and keeps the ledger current.
Run adsbfi-proxy on the same machine; see its README for installation,
reference-data imports, accuracy measurements and known limitations.

Generated data is intentionally ignored by Git. Do not commit or publish an
adsbfi-proxy database, the PJET auth database, or screenshots. In particular,
`aircraft.sqlite` can contain FAA registrant fields, and `auth.sqlite` contains
credential hashes and session-signing material.

## Requirements

- Node.js 20 or newer
- A running [adsbfi-proxy](https://github.com/kylemcdonald/adsbfi-proxy)
  installation and its database directory

Install the application dependencies:

```sh
npm ci
```

## Configuration

PJET keeps two directories apart:

| Variable | Default | Contents |
| --- | --- | --- |
| `PJET_ADSBFI_DB_DIR` | `$ADSBFI_DB_DIR`, else `../adsbfi-proxy/data/db` | adsbfi-proxy's `events.sqlite`, `airports.sqlite`, `aircraft.sqlite`, `build_state.sqlite` and `proxy-status.json`; read only |
| `PJET_DB_DIR` | `$PJET_DATA_DIR/pjet` | PJET's own `auth.sqlite` |
| `PJET_DATA_DIR` | `data/` | root for PJET's own ignored files, including the default `eurocontrol.csv` |

The defaults suit an adsbfi-proxy checkout next to this repository. The server
also accepts `--adsbfi-db-dir` and `--db-dir`. PJET needs read access to the
adsbfi-proxy databases; running it as the same user as the adsbfi-proxy worker
is simplest.

## Flights

adsbfi-proxy records each takeoff and landing as a separate movement and never
pairs them itself. PJET pairs them when it runs a query. A flight is a takeoff
followed directly by a landing of the same aircraft, with no other movement in
between, and the landing comes at most 20 hours after the takeoff. Movements
without such a partner are not flights and are left out of results, airport
counts and emissions, because an estimate needs both airports. A longer gap
means intermediate movements went unobserved.

A flight matches a query when its takeoff is at a selected airport within the
time range, or its landing is. A flight's ID is its takeoff movement's
`endpoint_id` in the adsbfi-proxy ledger.

## Emissions models

PJET offers two emissions models, both computed in the Node server and described
in [docs/emissions-models.md](docs/emissions-models.md):

- **Combined Model** (the default): the EUROCONTROL SET fuel curve for the
  aircraft's ICAO type plus a well-to-tank component, falling back to a
  per-aircraft profile from published fuel-burn and speed figures when the type
  has no curve.
- **EUROCONTROL Fast Model**: the SET fuel curve alone, CO2 from fuel burn only.

## Optional EUROCONTROL SET curves

PJET does not redistribute EUROCONTROL Small Emitters Tool workbooks or derived
fuel-curve data. EUROCONTROL states that SET equations are subject to a specific
[data-use agreement](https://www.eurocontrol.int/publication/small-emitters-tool-set-2023).
If you have obtained the workbook under terms that allow your use, export an ignored
local CSV and configure it before starting the server (the export needs Python and
[uv](https://docs.astral.sh/uv/)):

```sh
uv run --with openpyxl python scripts/export-eurocontrol-set-csv.py \
  /path/to/authorized-set-workbook.xlsx \
  data/eurocontrol.csv
export PJET_EUROCONTROL_CURVES="$PWD/data/eurocontrol.csv"
```

`data/eurocontrol.csv` is also the default local path, so the export command works
without the environment variable when run from the repository root. Without an
available local curve file, the Combined Model estimates every flight from its
aircraft profile and the EUROCONTROL Fast Model is not offered.

## Third-party data and privacy

The adsbfi-proxy databases combine several public datasets, each with its own
provenance and licensing; see adsbfi-proxy's README. Review their current terms
before distributing a generated database or offering it through a public API.

The FAA import can include registrant names and location fields. Even when a source is
public, decide deliberately whether exposing those fields is appropriate for your
deployment and jurisdiction.

## Run locally

Create the initial admin password in the environment and start the API. A new
`auth.sqlite` refuses to start without `PJET_PASSWORD`; there is no default
credential. The password is stored as a salted hash on first start, so later changes
to the environment variable do not replace it.

```sh
export PJET_PASSWORD="$(openssl rand -base64 32)"
HOST=127.0.0.1 PORT=8080 npm run serve
```

Open `http://127.0.0.1:8080/`. `/info` shows the ledger's time range and the
adsbfi-proxy worker's status. Use `/admin` to create or revoke journalist
vouchers. A voucher value is displayed only when it is created, so save it securely.
For an internet-facing deployment, keep the Node process behind HTTPS and add
network-level request limits in the reverse proxy or edge service. PJET also applies
a small in-memory login-failure limit, but that is not a replacement for perimeter
protection.

## Storage and server sizing

The PJET server itself needs little storage. Its working set is the adsbfi-proxy
ledger: `events.sqlite` was about **17 GB** in November 2026, covering movements
since January 2023, and it grows as the worker adds new files. Plan for fast SSD
storage with room for the ledger's growth and WAL files. A DigitalOcean Basic
Droplet with 2 vCPUs, 4 GB RAM and 120 GB disk serves PJET and runs the
adsbfi-proxy worker.

## Checks

```sh
npm run check
npm test
```

## API

All API routes except login and session status require an authenticated admin or
voucher session.

`GET /api/airports?minLat=&minLon=&maxLat=&maxLon=&type=` returns airports inside a
rectangular bounding box. `type` is optional and matches an airport type label such
as `heliport`, `small_airport`, or `large_airport`.

`GET /api/events/range` returns the ledger's movement count and time range.

`POST /api/events` accepts:

```json
{
  "start": "2026-05-01T00:00:00Z",
  "end": "2026-05-06T00:00:00Z",
  "airportIds": [123, 456],
  "aircraftType": "business_jet"
}
```

It returns matching flights, airport operation counts, and emissions estimates.
`POST /api/events/stream` returns the same results as newline-delimited JSON chunks.
`GET /api/events/:eventId` returns one flight with a detailed emissions breakdown.
