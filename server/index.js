import express from "express";
import Database from "better-sqlite3";
import { createHmac, timingSafeEqual } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ADMIN_ROLE, VOUCHER_ROLE, openAuthStore } from "./auth-store.js";
import {
  AIRPORT_COUNTS_SQL,
  EVENT_COUNT_SQL,
  EVENT_DETAIL_SQL,
  EVENT_ROWS_SQL,
  MAX_FLIGHT_SECONDS,
} from "./flight-sql.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT_DIR = path.resolve(__dirname, "..");
const DOCS_DIR = path.join(ROOT_DIR, "docs");
const APP_VERSION = readPackageVersion();
const DEFAULT_DATA_DIR = process.env.PJET_DATA_DIR || path.join(ROOT_DIR, "data");
const DEFAULT_DB_DIR = path.join(DEFAULT_DATA_DIR, "pjet");
// The flight ledger is produced and kept current by a separate adsbfi-proxy
// installation; PJET only reads it.
const DEFAULT_ADSBFI_DB_DIR = path.resolve(ROOT_DIR, "..", "adsbfi-proxy", "data", "db");
const COOKIE_NAME = "pjet_session";
const SESSION_TTL_SECONDS = 60 * 60 * 24 * 14;
const LOGIN_WINDOW_MS = 15 * 60 * 1000;
const LOGIN_MAX_FAILURES = 10;
const LOGIN_ATTEMPTS = new Map();
const DEFAULT_SQLITE_CACHE_KIB = 262_144;
const DEFAULT_SQLITE_MMAP_BYTES = 2_147_418_112;
const DEFAULT_EMISSIONS_CACHE_MAX = 100_000;
const INGEST_SLOT_MINUTES = 30;
const EUROCONTROL_FAST_METHODOLOGY = "eurocontrol_fast";
const COMBINED_METHODOLOGY = "combined";
const EUROCONTROL_FAST_LABEL = "EUROCONTROL Fast Model";
const COMBINED_LABEL = "Combined Model";
function environment(name, fallback = "") {
  return process.env[name] || fallback;
}

const parsedEmissionsCacheMax = Number(
  environment("PJET_EMISSIONS_CACHE_MAX", DEFAULT_EMISSIONS_CACHE_MAX)
);
const EMISSIONS_CACHE_MAX = Number.isFinite(parsedEmissionsCacheMax) ? Math.max(0, parsedEmissionsCacheMax) : DEFAULT_EMISSIONS_CACHE_MAX;
const MODEL_DISPLAY_CACHE = new Map();
const ADAPTED_TIM_PROFILE_CACHE = new Map();
const ADAPTED_TIM_ROUTE_CACHE = new Map();
const ADAPTED_TIM_ESTIMATE_CACHE = new Map();
const EUROCONTROL_ICAO_CACHE = new Map();
const EUROCONTROL_ROUTE_CACHE = new Map();
const EUROCONTROL_FAST_ESTIMATE_CACHE = new Map();
const COMBINED_ESTIMATE_CACHE = new Map();

function readPackageVersion() {
  try {
    const manifest = JSON.parse(fs.readFileSync(path.join(ROOT_DIR, "package.json"), "utf8"));
    return typeof manifest.version === "string" && manifest.version ? manifest.version : "0.0.0";
  } catch {
    return "0.0.0";
  }
}

const JET_A_KG_PER_GALLON = 3.03;
const TANK_TO_WAKE_CO2E_KG_PER_KG_FUEL = 3.1894;
const WELL_TO_TANK_CO2E_KG_PER_KG_FUEL = 0.6465;
const LATERAL_INEFFICIENCY_FACTOR = 1.052;
const EARTH_RADIUS_NM = 3440.065;
const EARTH_RADIUS_KM = 6371;
const KM_PER_NM = 1.852;
const EUROCONTROL_GCD_CORRECTION_KM = 95;
const EUROCONTROL_MAX_DISTANCE_NM = 999_999;
// EU/EEA/Swiss ETS Jet A/A-1 factor in force since 2024-01-01; the SET 2025
// (v5.15) workbook applies it to every row whose own CO2_COEFF is >= 3.15
// (jets and turboprops), leaving the 3.10 piston factor untouched.
const EUROCONTROL_JET_TURBOPROP_CO2_COEFF = 3.16;
const EUROCONTROL_CURVES_PATH = path.resolve(process.env.PJET_EUROCONTROL_CURVES || path.join(DEFAULT_DATA_DIR, "eurocontrol.csv"));
const EUROCONTROL_CURVES = loadEurocontrolCurves(EUROCONTROL_CURVES_PATH);
const EMISSIONS_METHODOLOGIES = [
  { value: COMBINED_METHODOLOGY, label: COMBINED_LABEL },
  ...(EUROCONTROL_CURVES.size ? [{ value: EUROCONTROL_FAST_METHODOLOGY, label: EUROCONTROL_FAST_LABEL }] : []),
  { value: "none", label: "None" },
];
const EMISSIONS_METHODOLOGY_LABELS = new Map(
  EMISSIONS_METHODOLOGIES.flatMap((methodology) => [
    [methodology.value, methodology],
    [methodology.label, methodology],
  ])
);

const AIRCRAFT_PROFILES = [
  {
    key: "citation_longitude",
    name: "Citation Longitude",
    burnGph: 302,
    speedKts: 483,
    matchAliases: [
      "Citation Longitude",
      "Cessna Citation Longitude",
      "Cessna 700",
      "Textron 700",
      { value: "700", manufacturers: ["Cessna", "Textron"] },
    ],
    fuelSource: {
      label: "Jet Advisors, Cessna Citation Longitude",
      url: "https://jetadvisors.com/jet/cessna-citation-longitude/",
      notes: "Reports 302 US gallons per hour fuel consumption.",
    },
    speedSource: {
      label: "Textron Aviation, Cessna Citation Longitude specifications",
      url: "https://cessna.txtav.com/en/citation/longitude",
      notes: "Reports 483 ktas maximum cruise speed.",
    },
  },
  {
    key: "citation_latitude",
    name: "Citation Latitude",
    burnGph: 246,
    speedKts: 446,
    matchAliases: [
      "Citation Latitude",
      "Cessna Citation Latitude",
      "Cessna 680A",
      "Textron 680A",
      "680A",
      { value: "680A", manufacturers: ["Cessna", "Textron"] },
    ],
    fuelSource: {
      label: "Jetcraft, Cessna Citation Latitude overview",
      url: "https://www.jetcraft.com/jetstream/2022/11/cessna-citation-latitude-overview-2014-present/",
      notes: "Reports combined fuel use of 246 gallons per hour.",
    },
    speedSource: {
      label: "Textron Aviation, Citation Latitude specifications",
      url: "https://cessna.txtav.com/en/citation/latitude",
      notes: "Reports 446 ktas maximum cruise speed.",
    },
  },
  {
    key: "phenom_300",
    name: "Phenom 300",
    burnGph: 183,
    speedKts: 450,
    matchAliases: [
      "Phenom 300",
      "Phenom 300E",
      "EMB 505",
      "Embraer 505",
      { value: "505", manufacturers: ["Embraer"] },
    ],
    fuelSource: {
      label: "Guardian Jet, Embraer Phenom 300/300E",
      url: "https://www.guardianjet.com/jet-aircraft-online-tools/aircraft-brochure.cfm?m=Embraer-Phenom-300-300E-107",
      notes: "Reports 183 gallons per hour fuel consumption.",
    },
    speedSource: {
      label: "Aviation Week, 20/Twenty: Embraer Phenom 300",
      url: "https://aviationweek.com/business-aviation/aircraft-propulsion/20twenty-embraer-phenom-300",
      notes: "Describes 450 ktas as a realistic Phenom 300 cruise speed in the mid-30s.",
    },
  },
  {
    key: "phenom_100",
    name: "Phenom 100",
    burnGph: 113,
    speedKts: 406,
    matchAliases: [
      "Phenom 100",
      "Phenom 100E",
      "Phenom 100EV",
      "EMB 500",
    ],
    fuelSource: {
      label: "Guardian Jet, Embraer Phenom 100 family",
      url: "https://www.guardianjet.com/jet-aircraft-online-tools/aircraft-brochure.cfm?m=Embraer-Phenom-100-106",
      notes: "Reports 113 gallons per hour fuel consumption.",
    },
    speedSource: {
      label: "Guardian Jet, Embraer Phenom 100 family",
      url: "https://www.guardianjet.com/jet-aircraft-online-tools/aircraft-brochure.cfm?m=Embraer-Phenom-100-106",
      notes: "Reports 406 ktas maximum cruise speed.",
    },
  },
  {
    key: "pilatus_pc24",
    name: "Pilatus PC-24",
    burnGph: 191,
    speedKts: 440,
    matchAliases: ["PC 24", "Pilatus PC 24"],
    fuelSource: {
      label: "Guardian Jet, Pilatus PC-24",
      url: "https://www.guardianjet.com/jet-aircraft-online-tools/aircraft-brochure.cfm?m=Pilatus-PC-24-215",
      notes: "Reports 191 gallons per hour fuel consumption.",
    },
    speedSource: {
      label: "Pilatus Aircraft, PC-24 technical data",
      url: "https://www.pilatus-aircraft.com/en/pc-24/technical-data",
      notes: "Reports 440 ktas maximum cruise speed.",
    },
  },
  {
    key: "legacy_450_praetor_500",
    name: "Legacy 450 / Praetor 500",
    burnGph: 284,
    speedKts: 424,
    matchAliases: ["Legacy 450", "Praetor 500", "EMB 545", { value: "545", manufacturers: ["Embraer"] }],
    fuelSource: {
      label: "Guardian Jet, Embraer Praetor 500",
      url: "https://www.guardianjet.com/jet-aircraft-online-tools/aircraft-brochure.cfm?m=Embraer-Praetor-500-200",
      notes: "Reports 284 gallons per hour fuel consumption.",
    },
    speedSource: {
      label: "Guardian Jet, Embraer Praetor 500",
      url: "https://www.guardianjet.com/jet-aircraft-online-tools/aircraft-brochure.cfm?m=Embraer-Praetor-500-200",
      notes: "Reports 424 ktas long-range cruise speed.",
    },
  },
  {
    key: "premier_ia",
    name: "Beechcraft Premier I/IA",
    burnGph: 159,
    speedKts: 430,
    matchAliases: [
      "Premier",
      "Premier I",
      "Premier IA",
      "Beech Premier",
      "Raytheon Premier",
      "390",
      { value: "390", manufacturers: ["Raytheon", "Beech", "Hawker"] },
    ],
    fuelSource: {
      label: "Guardian Jet, Beech Premier IA",
      url: "https://www.guardianjet.com/jet-aircraft-online-tools/aircraft-brochure.cfm?m=Beech-Premier-IA-15",
      notes: "Reports 159 gallons per hour fuel consumption.",
    },
    speedSource: {
      label: "Aviacost, Beechcraft Hawker Premier IA",
      url: "https://aviacost.com/aircraft-operating-cost-calculator/beechcraft-hawker-premier-ia",
      notes: "Reports 430 knot normal cruise speed.",
    },
  },
  {
    key: "beechjet_400a",
    name: "Beechjet / Hawker 400A",
    burnGph: 222,
    speedKts: 458,
    matchAliases: [
      "Beechjet",
      "Beechjet 400",
      "Beechjet 400A",
      "Beech 400",
      "Hawker 400",
      "400A",
      "400XP",
      "400 XP",
      { value: "400", manufacturers: ["Beech", "Beechcraft", "Hawker", "Raytheon"] },
    ],
    fuelSource: {
      label: "Guardian Jet, Beechjet 400A",
      url: "https://www.guardianjet.com/jet-aircraft-online-tools/aircraft-brochure.cfm?m=Beech-Beechjet-400A-13",
      notes: "Reports 222 gallons per hour fuel consumption.",
    },
    speedSource: {
      label: "Guardian Jet, Beechjet 400A",
      url: "https://www.guardianjet.com/jet-aircraft-online-tools/aircraft-brochure.cfm?m=Beech-Beechjet-400A-13",
      notes: "Reports 458 ktas maximum cruise speed.",
    },
  },
  {
    key: "mitsubishi_mu300",
    name: "Mitsubishi MU-300 Diamond",
    burnGph: 206.8,
    speedKts: 422,
    matchAliases: ["Mitsubishi MU-300", "Mitsubishi MU 300", "MU-300", "MU 300", "Diamond 1A", "Diamond IA"],
    fuelSource: {
      label: "Planephd, Mitsubishi Diamond 1A",
      url: "https://planephd.com/wizard/details/914/MITSUBISHI-DIAMOND-1A-specifications-performance-operating-cost-valuation",
      notes: "Reports 206.8 gallons per hour fuel burn.",
    },
    speedSource: {
      label: "Planephd, Mitsubishi Diamond 1A",
      url: "https://planephd.com/wizard/details/914/MITSUBISHI-DIAMOND-1A-specifications-performance-operating-cost-valuation",
      notes: "Reports 422 KIAS best cruise speed.",
    },
  },
  {
    key: "nextant_400xti",
    name: "Nextant 400XTi",
    burnGph: 151,
    speedKts: 447,
    matchAliases: ["Nextant 400XT", "Nextant 400XTi", "400XT", "400XTi", "Beech 400XTi", "Beechjet 400XTi"],
    fuelSource: {
      label: "Guardian Jet, Nextant 400XTi",
      url: "https://www.guardianjet.com/jet-aircraft-online-tools/aircraft-brochure.cfm?m=Nextant-Aerospace-Nextant-400XTi-209",
      notes: "Reports 151 gallons per hour fuel consumption.",
    },
    speedSource: {
      label: "Guardian Jet, Nextant 400XTi",
      url: "https://www.guardianjet.com/jet-aircraft-online-tools/aircraft-brochure.cfm?m=Nextant-Aerospace-Nextant-400XTi-209",
      notes: "Reports 447 ktas maximum cruise speed.",
    },
  },
  {
    key: "hawker_1000a",
    name: "Hawker 1000A",
    burnGph: 232,
    speedKts: 453,
    matchAliases: ["Hawker 1000A", "BAE 125 1000A", "BAE 125 Series 1000A", "125 1000A"],
    fuelSource: {
      label: "JetAv, Hawker Beechcraft 1000 specs",
      url: "https://jetav.com/hawker-beechcraft-1000-specs-and-description/",
      notes: "Reports average fuel burn of 232 gallons per hour.",
    },
    speedSource: {
      label: "JetAv, Hawker Beechcraft 1000 specs",
      url: "https://jetav.com/hawker-beechcraft-1000-specs-and-description/",
      notes: "Reports cruise up to 453 knots.",
    },
  },
  {
    key: "hawker_1000",
    name: "Hawker 1000",
    burnGph: 228,
    speedKts: 453,
    matchAliases: [
      "Hawker 1000",
      "Hawker 1000B",
      "BAE 125 1000",
      "BAE 125 Series 1000",
      "British Aerospace 125-1000B",
      "125 1000",
      "125 1000B",
    ],
    fuelSource: {
      label: "Jetcraft, Hawker 1000B overview",
      url: "https://www.jetcraft.com/jetstream/2014/11/hawker-1000b-overview-1991-2000/",
      notes: "Reports 228 gallons per hour fuel consumption.",
    },
    speedSource: {
      label: "JetAv, Hawker Beechcraft 1000 specs",
      url: "https://jetav.com/hawker-beechcraft-1000-specs-and-description/",
      notes: "Reports cruise up to 453 knots.",
    },
  },
  {
    key: "hawker_900xp",
    name: "Hawker 900XP",
    burnGph: 265,
    speedKts: 446,
    matchAliases: ["Hawker 900XP", "900XP"],
    fuelSource: {
      label: "Guardian Jet, Hawker/Textron 900XP",
      url: "https://www.guardianjet.com/jet-aircraft-online-tools/aircraft-brochure.cfm?m=Hawker%2FTextron-900XP-146",
      notes: "Reports 265 gallons per hour fuel consumption.",
    },
    speedSource: {
      label: "Jetcraft, Hawker 900XP overview",
      url: "https://www.jetcraft.com/jetstream/2024/11/beechcraft-hawker-900xp-overview-2007-2013/",
      notes: "Reports 446 ktas maximum cruise speed.",
    },
  },
  {
    key: "hawker_850xp",
    name: "Hawker 850XP",
    burnGph: 298,
    speedKts: 452,
    matchAliases: ["Hawker 850XP", "850XP"],
    fuelSource: {
      label: "Guardian Jet, Hawker/Textron 850XP",
      url: "https://www.guardianjet.com/jet-aircraft-online-tools/aircraft-brochure.cfm?m=Hawker%2FTextron-850XP-145",
      notes: "Reports 298 gallons per hour fuel consumption.",
    },
    speedSource: {
      label: "Guardian Jet, Hawker/Textron 850XP",
      url: "https://www.guardianjet.com/jet-aircraft-online-tools/aircraft-brochure.cfm?m=Hawker%2FTextron-850XP-145",
      notes: "Reports 452 ktas maximum cruise speed.",
    },
  },
  {
    key: "hawker_750",
    name: "Hawker 750",
    burnGph: 291,
    speedKts: 447,
    matchAliases: ["Hawker 750", "Hawker 750/850", "750/850"],
    fuelSource: {
      label: "Guardian Jet, Hawker/Textron 750",
      url: "https://www.guardianjet.com/jet-aircraft-online-tools/aircraft-brochure.cfm?m=Hawker%2FTextron-750-32",
      notes: "Reports 291 gallons per hour fuel consumption.",
    },
    speedSource: {
      label: "Guardian Jet, Hawker/Textron 750",
      url: "https://www.guardianjet.com/jet-aircraft-online-tools/aircraft-brochure.cfm?m=Hawker%2FTextron-750-32",
      notes: "Reports 447 ktas maximum cruise speed.",
    },
  },
  {
    key: "hawker_700a",
    name: "Hawker 700A",
    burnGph: 245.6,
    speedKts: 435,
    matchAliases: [
      "Hawker 700A",
      "HS 125 700A",
      "HS 125 Series 700A",
      "BAE 125 700A",
      "British Aerospace 125-700A",
      "125 700A",
    ],
    fuelSource: {
      label: "Planephd, Hawker 700A",
      url: "https://www.planephd.com/wizard/details/968/HAWKER-700A-specifications-performance-operating-cost-valuation",
      notes: "Reports 245.6 gallons per hour fuel burn.",
    },
    speedSource: {
      label: "Planephd, Hawker 700A",
      url: "https://www.planephd.com/wizard/details/968/HAWKER-700A-specifications-performance-operating-cost-valuation",
      notes: "Reports 435 KIAS best cruise speed.",
    },
  },
  {
    key: "hawker_800",
    name: "Hawker 800A",
    burnGph: 245.9,
    speedKts: 429,
    matchAliases: [
      "Hawker 800",
      "Hawker 800A",
      "BAE 125 Series 800",
      "BAE 125 Series 800A",
      "British Aerospace 125-800B",
      "British Aerospace 125-800SP",
      "125 800",
      "125 800A",
      "125 800B",
      "125 800SP",
      "HS 125 800",
    ],
    fuelSource: {
      label: "Planephd, Hawker 800A",
      url: "https://planephd.com/wizard/details/970/HAWKER-800A--specifications-performance-operating-cost-valuation",
      notes: "Reports 245.9 gallons per hour fuel burn.",
    },
    speedSource: {
      label: "GlobalAir, Hawker 800A specifications",
      url: "https://www.globalair.com/aircraft-specifications/hawker-aircraft/hawker-800a-specifications/759",
      notes: "Reports 429 knot cruise speed.",
    },
  },
  {
    key: "hawker_800xp",
    name: "Hawker 800XP",
    burnGph: 291,
    speedKts: 449,
    matchAliases: ["Hawker 800XP", "Hawker 800XPi", "British Aerospace 125-800XP2", "125 800XP2", "800XP", "800XPi", "800XP2"],
    fuelSource: {
      label: "Guardian Jet, Hawker/Textron 800XP",
      url: "https://www.guardianjet.com/jet-aircraft-online-tools/aircraft-brochure.cfm?m=Hawker%2FTextron-800XP-143",
      notes: "Reports 291 gallons per hour fuel consumption.",
    },
    speedSource: {
      label: "Guardian Jet, Hawker/Textron 800XP",
      url: "https://www.guardianjet.com/jet-aircraft-online-tools/aircraft-brochure.cfm?m=Hawker%2FTextron-800XP-143",
      notes: "Reports 449 ktas maximum cruise speed.",
    },
  },
  {
    key: "hawker_4000",
    name: "Hawker 4000",
    burnGph: 321,
    speedKts: 489,
    matchAliases: ["Hawker 4000", "Hawker Beechcraft 4000", "4000", { value: "4000", manufacturers: ["Hawker", "Beechcraft"] }],
    fuelSource: {
      label: "Guardian Jet, Hawker/Textron 4000",
      url: "https://www.guardianjet.com/jet-aircraft-online-tools/aircraft-brochure.cfm?m=Hawker%2FTextron-4000-138",
      notes: "Reports 321 gallons per hour fuel consumption.",
    },
    speedSource: {
      label: "Guardian Jet, Hawker/Textron 4000",
      url: "https://www.guardianjet.com/jet-aircraft-online-tools/aircraft-brochure.cfm?m=Hawker%2FTextron-4000-138",
      notes: "Reports 489 ktas maximum cruise speed.",
    },
  },
  {
    key: "westwind_1124",
    name: "IAI Westwind 1124",
    burnGph: 217,
    speedKts: 455,
    matchAliases: ["Westwind", "Westwind 1124", "IAI 1124", "Israel 1124", { value: "1124", manufacturers: ["IAI", "Israel"] }],
    fuelSource: {
      label: "Jet Advisors, IAI Westwind 1124",
      url: "https://jetadvisors.com/jet/iai-westwind-1124/",
      notes: "Reports 217 US gallons per hour fuel consumption.",
    },
    speedSource: {
      label: "Jet Advisors, IAI Westwind 1124",
      url: "https://jetadvisors.com/jet/iai-westwind-1124/",
      notes: "Reports 455 knot maximum cruise speed.",
    },
  },
  {
    key: "westwind_1124a",
    name: "IAI Westwind II 1124A",
    burnGph: 242.5,
    speedKts: 436,
    matchAliases: [
      "Westwind II",
      "Westwind 2",
      "Westwind 1124A",
      "IAI 1124A",
      "Israel 1124A",
      "WW1124A",
      "1124A",
      { value: "1124A", manufacturers: ["IAI", "Israel"] },
    ],
    fuelSource: {
      label: "Planephd, Westwind 1124A",
      url: "https://planephd.com/wizard/details/918/WESTWIND-1124A--WESTWIND-II--specifications-performance-operating-cost-valuation",
      notes: "Reports 242.5 gallons per hour fuel burn.",
    },
    speedSource: {
      label: "Planephd, Westwind 1124A",
      url: "https://planephd.com/wizard/details/918/WESTWIND-1124A--WESTWIND-II--specifications-performance-operating-cost-valuation",
      notes: "Reports 436 KIAS best cruise speed.",
    },
  },
  {
    key: "astra_1125",
    name: "IAI Astra 1125",
    burnGph: 232,
    speedKts: 424,
    matchAliases: ["Astra", "Astra 1125", "IAI 1125", "Israel 1125", { value: "1125", manufacturers: ["IAI", "Israel"] }],
    fuelSource: {
      label: "Jet Advisors, Astra 1125",
      url: "https://jetadvisors.com/jet/astra-1125/",
      notes: "Reports 232 US gallons per hour fuel consumption.",
    },
    speedSource: {
      label: "GlobalAir, Astra 1125 specifications",
      url: "https://www.globalair.com/aircraft-specifications/iai/astra-1125-specifications/1108",
      notes: "Reports 424 knot normal cruise speed.",
    },
  },
  {
    key: "gulfstream_g150",
    name: "Gulfstream G150",
    burnGph: 288,
    speedKts: 470,
    matchAliases: ["Gulfstream G150", "G150", "IAI G150", "Israel G150"],
    fuelSource: {
      label: "Guardian Jet, Gulfstream G150",
      url: "https://www.guardianjet.com/jet-aircraft-online-tools/aircraft-brochure.cfm?m=Gulfstream-G150-126",
      notes: "Reports 288 gallons per hour fuel consumption.",
    },
    speedSource: {
      label: "Guardian Jet, Gulfstream G150",
      url: "https://www.guardianjet.com/jet-aircraft-online-tools/aircraft-brochure.cfm?m=Gulfstream-G150-126",
      notes: "Reports 470 ktas maximum cruise speed.",
    },
  },
  {
    key: "gulfstream_g100",
    name: "Gulfstream G100 / Astra SPX",
    burnGph: 207,
    speedKts: 470,
    matchAliases: ["Gulfstream G100", "Gulfstream 100", "G100", "G 100", "Astra SPX", "1125SPX", "1125 SPX"],
    fuelSource: {
      label: "Guardian Jet, Gulfstream G100",
      url: "https://www.guardianjet.com/jet-aircraft-online-tools/aircraft-brochure.cfm?m=Gulfstream-G100-176",
      notes: "Reports 207 gallons per hour fuel consumption.",
    },
    speedSource: {
      label: "Guardian Jet, Gulfstream G100",
      url: "https://www.guardianjet.com/jet-aircraft-online-tools/aircraft-brochure.cfm?m=Gulfstream-G100-176",
      notes: "Reports 470 ktas maximum cruise speed.",
    },
  },
  {
    key: "gulfstream_g200",
    name: "Gulfstream G200 / Galaxy",
    burnGph: 278,
    speedKts: 430,
    matchAliases: ["G200", "Gulfstream G200", "Gulfstream 200", "Galaxy", "IAI G200", "Israel G200"],
    fuelSource: {
      label: "Guardian Jet, Gulfstream G200",
      url: "https://www.guardianjet.com/jet-aircraft-online-tools/aircraft-brochure.cfm?m=Gulfstream-G200-127",
      notes: "Reports 278 gallons per hour fuel consumption.",
    },
    speedSource: {
      label: "Jetcraft, Gulfstream G200 overview",
      url: "https://www.jetcraft.com/jetstream/2020/06/gulfstream-g200-overview-1997-2011/",
      notes: "Reports 430 knot long-range speed.",
    },
  },
  {
    key: "gulfstream_gii",
    name: "Gulfstream GII / G-IIB",
    burnGph: 579,
    speedKts: 475,
    matchAliases: [
      "Gulfstream II",
      "Gulfstream IIB",
      "Gulfstream GII",
      "Gulfstream G-IIB",
      "Gulfstream GII SP",
      "Grumman GII SP",
      "G1159B",
      "G 1159B",
      "GII",
      "GII SP",
    ],
    fuelSource: {
      label: "Craft, Gulfstream GII ownership costs",
      url: "https://flycraft.com/ownership-cost/gulfstream-gii-ownership-operating-costs/",
      notes: "Reports 579 gallons per hour average hourly fuel burn.",
    },
    speedSource: {
      label: "GlobalAir, Gulfstream II specifications",
      url: "https://www.globalair.com/aircraft-specifications/gulfstream-aerospace/gulfstream-ii-specifications/232",
      notes: "Reports typical cruise of 450 to 475 knots.",
    },
  },
  {
    key: "gulfstream_g280",
    name: "Gulfstream G280",
    burnGph: 286,
    speedKts: 488,
    matchAliases: ["Gulfstream G280", "G280"],
    fuelSource: {
      label: "Guardian Jet, Gulfstream G280",
      url: "https://www.guardianjet.com/jet-aircraft-online-tools/aircraft-brochure.cfm?m=Gulfstream-G280-30",
      notes: "Reports 286 gallons per hour fuel consumption.",
    },
    speedSource: {
      label: "Guardian Jet, Gulfstream G280",
      url: "https://www.guardianjet.com/jet-aircraft-online-tools/aircraft-brochure.cfm?m=Gulfstream-G280-30",
      notes: "Reports 488 ktas maximum cruise speed.",
    },
  },
  {
    key: "vision_jet_sf50",
    name: "Cirrus Vision Jet SF50",
    burnGph: 60,
    speedKts: 317,
    matchAliases: ["Vision Jet", "Vision SF50", "SF50", "SF 50", "Cirrus SF50", "Cirrus Jet", "Cirrus Jet SJX", "SJX"],
    fuelSource: {
      label: "Jet Advisors, Cirrus Vision SF50 G2",
      url: "https://jetadvisors.com/jet/cirrus-vision-sf50-g2/",
      notes: "Reports 60 US gallons per hour fuel consumption.",
    },
    speedSource: {
      label: "Cirrus Aircraft, Vision Jet specifications",
      url: "https://cirrusaircraft.com/aircraft/vision-jet/",
      notes: "Reports 317 ktas maximum cruise speed.",
    },
  },
  {
    key: "hondajet_ha420",
    name: "HondaJet HA-420",
    burnGph: 120,
    speedKts: 422,
    matchAliases: ["HondaJet", "Honda Jet", "HA 420", "HA420"],
    fuelSource: {
      label: "Guardian Jet, HondaJet",
      url: "https://www.guardianjet.com/jet-aircraft-online-tools/aircraft-brochure.cfm?m=Honda-Aircraft-Company-Honda-Jet-216",
      notes: "Reports 120 gallons per hour fuel consumption.",
    },
    speedSource: {
      label: "Honda Aircraft Company, HondaJet Elite II",
      url: "https://www.hondajet.com/en/Products/HondaJet-Elite-II",
      notes: "Reports 422 ktas maximum cruise speed.",
    },
  },
  {
    key: "eclipse_500",
    name: "Eclipse 500",
    burnGph: 76,
    speedKts: 370,
    matchAliases: ["Eclipse 500", "EA500", "EA 500", { value: "500", manufacturers: ["Eclipse"] }],
    fuelSource: {
      label: "Guardian Jet, Eclipse 500",
      url: "https://www.guardianjet.com/jet-aircraft-online-tools/aircraft-brochure.cfm?m=Eclipse-Aerospace-Eclipse-500-220",
      notes: "Reports 76 gallons per hour fuel consumption.",
    },
    speedSource: {
      label: "Eclipse Aerospace, Eclipse Jet specifications",
      url: "https://www.eclipse.aero/eclipse/specifications/",
      notes: "Describes cruise near 400 mph; profile uses 370 ktas.",
    },
  },
  {
    key: "eclipse_550",
    name: "Eclipse 550",
    burnGph: 55,
    speedKts: 375,
    matchAliases: ["Eclipse 550", "EA550", "EA 550", "One Aviation EA550"],
    fuelSource: {
      label: "Eclipse Aerospace, Eclipse 550 specifications",
      url: "https://www.eclipse.aero/550-specs/",
      notes: "Reports 48-59 gallons per hour in cruise; profile uses 55 gph midpoint.",
    },
    speedSource: {
      label: "Eclipse Aerospace, Eclipse 550 specifications",
      url: "https://www.eclipse.aero/550-specs/",
      notes: "Reports 375 ktas maximum cruise speed.",
    },
  },
  {
    key: "citation_mustang",
    name: "Citation Mustang",
    burnGph: 90,
    speedKts: 340,
    matchAliases: ["Citation Mustang", "Mustang", "Cessna 510", "Textron 510", "510", { value: "510", manufacturers: ["Cessna", "Textron"] }],
    fuelSource: {
      label: "Guardian Jet, Cessna/Textron Mustang",
      url: "https://www.guardianjet.com/jet-aircraft-online-tools/aircraft-brochure.cfm?m=Cessna-Mustang-81",
      notes: "Reports 90 gallons per hour fuel consumption.",
    },
    speedSource: {
      label: "Guardian Jet, Cessna/Textron Mustang",
      url: "https://www.guardianjet.com/jet-aircraft-online-tools/aircraft-brochure.cfm?m=Cessna-Mustang-81",
      notes: "Reports 340 ktas maximum cruise speed.",
    },
  },
  {
    key: "citation_isp_501",
    name: "Citation I/SP 501",
    burnGph: 162,
    speedKts: 349,
    matchAliases: ["Citation I SP", "Citation ISP", "Citation 501", "Cessna 501", "Textron 501", "501", { value: "501", manufacturers: ["Cessna", "Textron"] }],
    fuelSource: {
      label: "Liberty Jet, Citation ISP",
      url: "https://www.libertyjet.com/private_jets/CE-501SP",
      notes: "Reports 162 gph fuel burn.",
    },
    speedSource: {
      label: "Liberty Jet, Citation ISP",
      url: "https://www.libertyjet.com/private_jets/CE-501SP",
      notes: "Reports 402 mph maximum speed; profile stores 349 ktas.",
    },
  },
  {
    key: "citation_i_500",
    name: "Citation I 500",
    burnGph: 166.1,
    speedKts: 348,
    matchAliases: [
      "Citation I",
      "Citation 500",
      "Citation I 500",
      "Cessna 500",
      "Textron 500",
      { value: "500", manufacturers: ["Cessna", "Textron"] },
    ],
    fuelSource: {
      label: "Planephd, Cessna Citation 500",
      url: "https://planephd.com/wizard/details/644/CESSNA-Citation-500-specifications-performance-operating-cost-valuation",
      notes: "Reports 166.1 gallons per hour fuel burn.",
    },
    speedSource: {
      label: "Planephd, Cessna Citation 500",
      url: "https://planephd.com/wizard/details/644/CESSNA-Citation-500-specifications-performance-operating-cost-valuation",
      notes: "Reports 348 KIAS best cruise speed.",
    },
  },
  {
    key: "citation_m2",
    name: "Citation M2",
    burnGph: 134,
    speedKts: 404,
    matchAliases: ["Citation M2", "M2 Gen2"],
    fuelSource: {
      label: "Guardian Jet, Cessna/Textron Citation M2",
      url: "https://www.guardianjet.com/jet-aircraft-online-tools/aircraft-brochure.cfm?m=Cessna%2FTextron-Citation-M2-182",
      notes: "Reports 134 gallons per hour fuel consumption.",
    },
    speedSource: {
      label: "Guardian Jet, Cessna/Textron Citation M2",
      url: "https://www.guardianjet.com/jet-aircraft-online-tools/aircraft-brochure.cfm?m=Cessna%2FTextron-Citation-M2-182",
      notes: "Reports 404 ktas maximum cruise speed.",
    },
  },
  {
    key: "citation_cj1",
    name: "CitationJet / CJ1",
    burnGph: 134,
    speedKts: 381,
    matchAliases: [
      "CitationJet",
      "Citation Jet",
      "Citation CJ",
      "Citation CJ1",
      "CJ1",
      "Cessna 525",
      "Textron 525",
      "525",
      { value: "525", manufacturers: ["Cessna", "Textron"] },
    ],
    fuelSource: {
      label: "Guardian Jet, Cessna/Textron CJ1",
      url: "https://www.guardianjet.com/jet-aircraft-online-tools/aircraft-brochure.cfm?m=Cessna%2FTextron-CJ1-72",
      notes: "Reports 134 gallons per hour fuel consumption.",
    },
    speedSource: {
      label: "Guardian Jet, Cessna/Textron CJ1",
      url: "https://www.guardianjet.com/jet-aircraft-online-tools/aircraft-brochure.cfm?m=Cessna%2FTextron-CJ1-72",
      notes: "Reports 381 ktas maximum cruise speed.",
    },
  },
  {
    key: "citation_cj2",
    name: "Citation CJ2",
    burnGph: 141,
    speedKts: 413,
    matchAliases: ["Citation CJ2", "CJ2", "Cessna 525A", "Textron 525A", "525A", { value: "525A", manufacturers: ["Cessna", "Textron"] }],
    fuelSource: {
      label: "Guardian Jet, Cessna/Textron CJ2",
      url: "https://www.guardianjet.com/jet-aircraft-online-tools/aircraft-brochure.cfm?m=Cessna%2FTextron-CJ2-74",
      notes: "Reports 141 gallons per hour fuel consumption.",
    },
    speedSource: {
      label: "Guardian Jet, Cessna/Textron CJ2",
      url: "https://www.guardianjet.com/jet-aircraft-online-tools/aircraft-brochure.cfm?m=Cessna%2FTextron-CJ2-74",
      notes: "Reports 413 ktas maximum cruise speed.",
    },
  },
  {
    key: "citation_cj3",
    name: "Citation CJ3",
    burnGph: 149,
    speedKts: 416,
    matchAliases: ["Citation CJ3", "CJ3", "Cessna 525B", "Textron 525B", "525B", { value: "525B", manufacturers: ["Cessna", "Textron"] }],
    fuelSource: {
      label: "Guardian Jet, Cessna/Textron CJ3",
      url: "https://www.guardianjet.com/jet-aircraft-online-tools/aircraft-brochure.cfm?m=Cessna%2FTextron-CJ3-76",
      notes: "Reports 149 gallons per hour fuel consumption.",
    },
    speedSource: {
      label: "Guardian Jet, Cessna/Textron CJ3",
      url: "https://www.guardianjet.com/jet-aircraft-online-tools/aircraft-brochure.cfm?m=Cessna%2FTextron-CJ3-76",
      notes: "Reports 416 ktas maximum cruise speed.",
    },
  },
  {
    key: "citation_excel_560xl",
    name: "Citation Excel 560XL",
    burnGph: 250,
    speedKts: 433,
    matchAliases: ["Citation Excel", "Citation XL", "Cessna 560XL", "Textron 560XL", "560XL", { value: "560XL", manufacturers: ["Cessna", "Textron"] }],
    fuelSource: {
      label: "Guardian Jet, Cessna/Textron Excel",
      url: "https://www.guardianjet.com/jet-aircraft-online-tools/aircraft-brochure.cfm?m=Cessna%2FTextron-Excel-80",
      notes: "Reports 250 gallons per hour fuel consumption.",
    },
    speedSource: {
      label: "Guardian Jet, Cessna/Textron Excel",
      url: "https://www.guardianjet.com/jet-aircraft-online-tools/aircraft-brochure.cfm?m=Cessna%2FTextron-Excel-80",
      notes: "Reports 433 ktas maximum cruise speed.",
    },
  },
  {
    key: "citation_excel_xls",
    name: "Citation XLS / XLS+",
    burnGph: 239,
    speedKts: 433,
    matchAliases: ["Citation XLS", "Citation XLS+", "Cessna 560XLS", "Textron 560XLS", "560XLS", "XLS", "XLS+"],
    fuelSource: {
      label: "Guardian Jet, Cessna/Textron XLS",
      url: "https://www.guardianjet.com/jet-aircraft-online-tools/aircraft-brochure.cfm?m=Cessna%2FTextron-XLS-87",
      notes: "Reports 239 gallons per hour fuel consumption.",
    },
    speedSource: {
      label: "Guardian Jet, Cessna/Textron XLS",
      url: "https://www.guardianjet.com/jet-aircraft-online-tools/aircraft-brochure.cfm?m=Cessna%2FTextron-XLS-87",
      notes: "Reports 433 ktas maximum cruise speed.",
    },
  },
  {
    key: "citation_v_560",
    name: "Citation V 560",
    burnGph: 210,
    speedKts: 430,
    matchAliases: ["Citation V", "Cessna 560", "Textron 560", "560", { value: "560", manufacturers: ["Cessna", "Textron"] }],
    fuelSource: {
      label: "Liberty Jet, Citation V",
      url: "https://www.libertyjet.com/private_jets/CE-560",
      notes: "Reports 210 gph fuel burn.",
    },
    speedSource: {
      label: "Liberty Jet, Citation V",
      url: "https://www.libertyjet.com/private_jets/CE-560",
      notes: "Reports 495 mph maximum speed; profile stores 430 ktas.",
    },
  },
  {
    key: "citation_ultra_encore",
    name: "Citation Ultra / Encore",
    burnGph: 223,
    speedKts: 430,
    matchAliases: [
      "Citation Ultra",
      "Citation Encore",
      "Citation Encore+",
      "Ultra",
      "Encore",
    ],
    fuelSource: {
      label: "Guardian Jet, Cessna/Textron Ultra",
      url: "https://www.guardianjet.com/jet-aircraft-online-tools/aircraft-brochure.cfm?m=Cessna%2FTextron-Ultra-83",
      notes: "Reports 223 gallons per hour fuel consumption.",
    },
    speedSource: {
      label: "Guardian Jet, Cessna/Textron Ultra",
      url: "https://www.guardianjet.com/jet-aircraft-online-tools/aircraft-brochure.cfm?m=Cessna%2FTextron-Ultra-83",
      notes: "Reports 430 ktas maximum cruise speed.",
    },
  },
  {
    key: "citation_ii_550",
    name: "Citation II 550",
    burnGph: 181,
    speedKts: 375,
    matchAliases: ["Citation II", "Citation II SP", "Citation IISP", "Cessna 550", "Cessna 551", "Textron 550", "Textron 551", { value: "550", manufacturers: ["Cessna", "Textron"] }, { value: "551", manufacturers: ["Cessna", "Textron"] }],
    fuelSource: {
      label: "Liberty Jet, Citation II",
      url: "https://www.libertyjet.com/private_jets/CE-550",
      notes: "Reports 181 gph fuel burn.",
    },
    speedSource: {
      label: "Liberty Jet, Citation II",
      url: "https://www.libertyjet.com/private_jets/CE-550",
      notes: "Reports 432 mph maximum speed; profile stores 375 ktas.",
    },
  },
  {
    key: "citation_sii_s550",
    name: "Citation S/II S550",
    burnGph: 201,
    speedKts: 402,
    matchAliases: [
      "Citation S II",
      "Citation SII",
      "Citation S/II",
      "Cessna S550",
      "Textron S550",
      "S550",
      { value: "S550", manufacturers: ["Cessna", "Textron"] },
    ],
    fuelSource: {
      label: "Jet Advisors, Citation S/II",
      url: "https://jetadvisors.com/jet/citation-s-ii/",
      notes: "Reports 201 US gallons per hour fuel consumption.",
    },
    speedSource: {
      label: "Jet Advisors, Citation S/II",
      url: "https://jetadvisors.com/jet/citation-s-ii/",
      notes: "Reports 402 ktas maximum cruise speed.",
    },
  },
  {
    key: "citation_bravo_ii",
    name: "Citation Bravo",
    burnGph: 170,
    speedKts: 402,
    matchAliases: ["Citation Bravo", "Bravo"],
    fuelSource: {
      label: "Guardian Jet, Cessna/Textron Bravo",
      url: "https://www.guardianjet.com/jet-aircraft-online-tools/aircraft-brochure.cfm?m=Cessna%2FTextron-Bravo-62",
      notes: "Reports 170 gallons per hour fuel consumption.",
    },
    speedSource: {
      label: "Guardian Jet, Cessna/Textron Bravo",
      url: "https://www.guardianjet.com/jet-aircraft-online-tools/aircraft-brochure.cfm?m=Cessna%2FTextron-Bravo-62",
      notes: "Reports 402 ktas maximum cruise speed.",
    },
  },
  {
    key: "citation_sovereign",
    name: "Citation Sovereign",
    burnGph: 281,
    speedKts: 459,
    matchAliases: ["Citation Sovereign", "Sovereign", "Cessna 680", "Textron 680", "680", { value: "680", manufacturers: ["Cessna", "Textron"] }],
    fuelSource: {
      label: "Guardian Jet, Cessna/Textron Sovereign",
      url: "https://www.guardianjet.com/jet-aircraft-online-tools/aircraft-brochure.cfm?m=Cessna%2FTextron-Sovereign-82",
      notes: "Reports 281 gallons per hour fuel consumption.",
    },
    speedSource: {
      label: "Guardian Jet, Cessna/Textron Sovereign",
      url: "https://www.guardianjet.com/jet-aircraft-online-tools/aircraft-brochure.cfm?m=Cessna%2FTextron-Sovereign-82",
      notes: "Reports 459 ktas maximum cruise speed.",
    },
  },
  {
    key: "citation_x",
    name: "Citation X",
    burnGph: 386,
    speedKts: 525,
    matchAliases: ["Citation X", "Citation X+", "Cessna 750", "Textron 750", "750", { value: "750", manufacturers: ["Cessna", "Textron"] }],
    fuelSource: {
      label: "Guardian Jet, Cessna/Textron Citation X",
      url: "https://www.guardianjet.com/jet-aircraft-online-tools/aircraft-brochure.cfm?m=Cessna%2FTextron-Citation-X-86",
      notes: "Reports 386 gallons per hour fuel consumption.",
    },
    speedSource: {
      label: "Guardian Jet, Cessna/Textron Citation X",
      url: "https://www.guardianjet.com/jet-aircraft-online-tools/aircraft-brochure.cfm?m=Cessna%2FTextron-Citation-X-86",
      notes: "Reports 525 ktas maximum cruise speed.",
    },
  },
  {
    key: "citation_iii_650",
    name: "Citation III 650",
    burnGph: 241,
    speedKts: 470,
    matchAliases: ["Citation III", "Citation VI", "Cessna 650", "Textron 650", { value: "650", manufacturers: ["Cessna", "Textron"] }],
    fuelSource: {
      label: "Jetcraft, Cessna Citation III overview",
      url: "https://www.jetcraft.com/jetstream/2018/07/cessna-citation-iii-overview-1983-1991/",
      notes: "Reports combined fuel use of 241 gallons per hour.",
    },
    speedSource: {
      label: "Planephd, Cessna Citation III",
      url: "https://www.planephd.com/wizard/details/650/CESSNA-Citation-III-650-specifications-performance-operating-cost-valuation?annual_hrs=100&min_speed=120&min_year=1940&modeltype=Jet&ownership_cost_p_year_max=5000000&purchase_price_max=100000000&required_seats_min=4&selected_yearmfr=1983",
      notes: "Reports 470 KIAS best cruise speed.",
    },
  },
  {
    key: "citation_vii_650",
    name: "Citation VII",
    burnGph: 273,
    speedKts: 452,
    matchAliases: ["Citation VII"],
    fuelSource: {
      label: "Aviacost, Cessna Citation VII",
      url: "https://aviacost.com/aircraft-operating-cost-calculator/cessna-citation-vii",
      notes: "Reports 273 gallons per hour average fuel burn.",
    },
    speedSource: {
      label: "GlobalAir, Citation VII specifications",
      url: "https://www.globalair.com/aircraft-specifications/cessna/citation-vii-specifications/190",
      notes: "Reports 452 knot normal cruise speed.",
    },
  },
  {
    key: "learjet_25",
    name: "Learjet 25",
    burnGph: 273.2,
    speedKts: 464,
    matchAliases: [
      "Learjet 25",
      "Learjet 25B",
      "Learjet 25D",
      "Lear 25",
      "Lear 25B",
      "Lear 25D",
      { value: "25", manufacturers: ["Learjet", "Lear Jet", "Gates Learjet", "Gates Lear Jet", "Bombardier"] },
      { value: "25B", manufacturers: ["Learjet", "Lear Jet", "Gates Learjet", "Gates Lear Jet", "Bombardier"] },
      { value: "25D", manufacturers: ["Learjet", "Lear Jet", "Gates Learjet", "Gates Lear Jet", "Bombardier"] },
    ],
    fuelSource: {
      label: "Planephd, Learjet 25",
      url: "https://planephd.com/wizard/details/908/LEARJET-25-specifications-performance-operating-cost-valuation",
      notes: "Reports 273.2 gallons per hour fuel burn.",
    },
    speedSource: {
      label: "Planephd, Learjet 25",
      url: "https://planephd.com/wizard/details/908/LEARJET-25-specifications-performance-operating-cost-valuation",
      notes: "Reports 464 KIAS best cruise speed.",
    },
  },
  {
    key: "learjet_31",
    name: "Learjet 31",
    burnGph: 173,
    speedKts: 441,
    matchAliases: ["Learjet 31", "Lear 31", { value: "31", manufacturers: ["Learjet", "Bombardier"] }],
    fuelSource: {
      label: "Jet Advisors, Learjet 31",
      url: "https://jetadvisors.com/jet/learjet-31/",
      notes: "Reports 173 US gallons per hour fuel consumption.",
    },
    speedSource: {
      label: "GlobalAir, Learjet 31 specifications",
      url: "https://www.globalair.com/aircraft-specifications/learjet/learjet-31-specifications/21",
      notes: "Reports 441 knot normal cruise speed.",
    },
  },
  {
    key: "learjet_31a",
    name: "Learjet 31A",
    burnGph: 202,
    speedKts: 460,
    matchAliases: ["Learjet 31A", "Lear 31A", "31A"],
    fuelSource: {
      label: "Guardian Jet, Bombardier Learjet 31A",
      url: "https://www.guardianjet.com/jet-aircraft-online-tools/aircraft-brochure.cfm?m=Bombardier-Learjet-31A-3",
      notes: "Reports 202 gallons per hour fuel consumption.",
    },
    speedSource: {
      label: "Guardian Jet, Bombardier Learjet 31A",
      url: "https://www.guardianjet.com/jet-aircraft-online-tools/aircraft-brochure.cfm?m=Bombardier-Learjet-31A-3",
      notes: "Reports 460 ktas maximum cruise speed.",
    },
  },
  {
    key: "learjet_35a",
    name: "Learjet 35A",
    burnGph: 225,
    speedKts: 451,
    matchAliases: [
      "Learjet 35",
      "Learjet 35A",
      "Lear 35",
      "Lear 35A",
      "35A",
      { value: "35", manufacturers: ["Learjet", "Lear Jet", "Gates Learjet", "Gates Lear Jet", "Bombardier"] },
    ],
    fuelSource: {
      label: "Jet Advisors, Learjet 35A",
      url: "https://jetadvisors.com/jet/learjet-35a/",
      notes: "Reports 225 US gallons per hour fuel consumption.",
    },
    speedSource: {
      label: "Jet Advisors, Learjet 35A",
      url: "https://jetadvisors.com/jet/learjet-35a/",
      notes: "Reports 451 ktas maximum cruise speed.",
    },
  },
  {
    key: "learjet_36a",
    name: "Learjet 36A",
    burnGph: 173.8,
    speedKts: 450,
    matchAliases: [
      "Learjet 36",
      "Learjet 36A",
      "Lear 36",
      "Lear 36A",
      "36A",
      { value: "36", manufacturers: ["Learjet", "Lear Jet", "Gates Learjet", "Gates Lear Jet", "Bombardier"] },
    ],
    fuelSource: {
      label: "Planephd, Learjet 36A",
      url: "https://planephd.com/wizard/details/903/LEARJET-36A-specifications-performance-operating-cost-valuation",
      notes: "Reports 173.8 gallons per hour fuel burn.",
    },
    speedSource: {
      label: "Planephd, Learjet 36A",
      url: "https://planephd.com/wizard/details/903/LEARJET-36A-specifications-performance-operating-cost-valuation",
      notes: "Reports 450 KIAS best cruise speed.",
    },
  },
  {
    key: "learjet_40xr",
    name: "Learjet 40XR",
    burnGph: 224,
    speedKts: 460,
    matchAliases: [
      "Learjet 40",
      "Learjet 40XR",
      "Lear 40",
      "Lear 40XR",
      "40XR",
      { value: "40", manufacturers: ["Learjet", "Lear Jet", "Gates Learjet", "Gates Lear Jet", "Bombardier"] },
    ],
    fuelSource: {
      label: "Guardian Jet, Bombardier Learjet 40XR",
      url: "https://www.guardianjet.com/jet-aircraft-online-tools/aircraft-brochure.cfm?m=Bombardier-Learjet-40XR-55",
      notes: "Reports 224 gallons per hour fuel consumption.",
    },
    speedSource: {
      label: "Guardian Jet, Bombardier Learjet 40XR",
      url: "https://www.guardianjet.com/jet-aircraft-online-tools/aircraft-brochure.cfm?m=Bombardier-Learjet-40XR-55",
      notes: "Reports 460 ktas maximum cruise speed.",
    },
  },
  {
    key: "learjet_45",
    name: "Learjet 45",
    burnGph: 205,
    speedKts: 460,
    matchAliases: ["Learjet 45", "Learjet 45XR", "Lear 45", "Lear 45XR", "45", { value: "45", manufacturers: ["Learjet", "Bombardier"] }],
    fuelSource: {
      label: "Guardian Jet, Bombardier Learjet 45",
      url: "https://www.guardianjet.com/jet-aircraft-online-tools/aircraft-brochure.cfm?m=Bombardier-Learjet-45-56",
      notes: "Reports 205 gallons per hour fuel consumption.",
    },
    speedSource: {
      label: "Guardian Jet, Bombardier Learjet 45",
      url: "https://www.guardianjet.com/jet-aircraft-online-tools/aircraft-brochure.cfm?m=Bombardier-Learjet-45-56",
      notes: "Reports 460 ktas maximum cruise speed.",
    },
  },
  {
    key: "learjet_60",
    name: "Learjet 60",
    burnGph: 239,
    speedKts: 460,
    matchAliases: ["Learjet 60", "Learjet 60XR", "Lear 60", "Lear 60XR", "60", { value: "60", manufacturers: ["Learjet", "Bombardier"] }],
    fuelSource: {
      label: "Guardian Jet, Bombardier Learjet 60",
      url: "https://www.guardianjet.com/jet-aircraft-online-tools/aircraft-brochure.cfm?m=Bombardier-Learjet-60-59",
      notes: "Reports 239 gallons per hour fuel consumption.",
    },
    speedSource: {
      label: "Guardian Jet, Bombardier Learjet 60",
      url: "https://www.guardianjet.com/jet-aircraft-online-tools/aircraft-brochure.cfm?m=Bombardier-Learjet-60-59",
      notes: "Reports 460 ktas maximum cruise speed.",
    },
  },
  {
    key: "learjet_55",
    name: "Learjet 55",
    burnGph: 244,
    speedKts: 458,
    matchAliases: [
      "Learjet 55",
      "Lear 55",
      { value: "55", manufacturers: ["Learjet", "Gates Learjet", "Gates Lear Jet", "Bombardier"] },
      { value: "55B", manufacturers: ["Learjet", "Gates Learjet", "Gates Lear Jet", "Bombardier"] },
      { value: "55C", manufacturers: ["Learjet", "Gates Learjet", "Gates Lear Jet", "Bombardier"] },
    ],
    fuelSource: {
      label: "Jet Advisors, Learjet 55",
      url: "https://jetadvisors.com/jet/learjet-55-cost-to-operate/",
      notes: "Reports 244 US gallons per hour fuel consumption.",
    },
    speedSource: {
      label: "Jet Advisors, Learjet 55",
      url: "https://jetadvisors.com/jet/learjet-55-cost-to-operate/",
      notes: "Reports 458 ktas maximum cruise speed.",
    },
  },
  {
    key: "learjet_75",
    name: "Learjet 75",
    burnGph: 214,
    speedKts: 451,
    matchAliases: ["Learjet 75", "Lear 75", { value: "75", manufacturers: ["Learjet", "Bombardier"] }],
    fuelSource: {
      label: "Jetcraft, Learjet 75 overview",
      url: "https://www.jetcraft.com/jetstream/2022/07/learjet-75-overview-from-2013-to-present-2023/",
      notes: "Reports combined fuel use of 214 gallons per hour.",
    },
    speedSource: {
      label: "Jetcraft, Learjet 75 overview",
      url: "https://www.jetcraft.com/jetstream/2022/07/learjet-75-overview-from-2013-to-present-2023/",
      notes: "Reports 451 ktas maximum cruise speed.",
    },
  },
  {
    key: "gulfstream_g450",
    name: "Gulfstream G450",
    burnGph: 517,
    speedKts: 500,
    matchAliases: ["Gulfstream G450", "G450", "G 450", "GIV X G450", "G IV G450"],
    fuelSource: {
      label: "Guardian Jet, Gulfstream G450",
      url: "https://www.guardianjet.com/jet-aircraft-online-tools/aircraft-brochure.cfm?m=Gulfstream-G450-131",
      notes: "Reports 517 gallons per hour fuel consumption.",
    },
    speedSource: {
      label: "Guardian Jet, Gulfstream G450",
      url: "https://www.guardianjet.com/jet-aircraft-online-tools/aircraft-brochure.cfm?m=Gulfstream-G450-131",
      notes: "Reports 500 ktas maximum cruise speed.",
    },
  },
  {
    key: "gulfstream_g400_heritage",
    name: "Gulfstream G400 (Heritage)",
    burnGph: 540,
    speedKts: 500,
    matchAliases: ["Gulfstream G400", "G400 Heritage", "G400", "G 400", "GIV X G400", "G IV G400"],
    fuelSource: {
      label: "Guardian Jet, Gulfstream G400 (Heritage)",
      url: "https://www.guardianjet.com/jet-aircraft-online-tools/aircraft-brochure.cfm?m=Gulfstream-G400-%28Heritage%29-130",
      notes: "Reports 540 gallons per hour fuel consumption.",
    },
    speedSource: {
      label: "Guardian Jet, Gulfstream G400 (Heritage)",
      url: "https://www.guardianjet.com/jet-aircraft-online-tools/aircraft-brochure.cfm?m=Gulfstream-G400-%28Heritage%29-130",
      notes: "Reports 500 ktas maximum cruise speed.",
    },
  },
  {
    key: "gulfstream_giv",
    name: "Gulfstream GIV / GIV-SP",
    burnGph: 540,
    speedKts: 500,
    matchAliases: [
      "Gulfstream GIV",
      "Gulfstream GIVSP",
      "Gulfstream 4",
      "Gulfstream IV",
      "G IV",
      "G IVSP",
      "GIV",
      "GIV SP",
      "G4",
      "G4 SP",
      "G4-SP",
      { value: "4", manufacturers: ["Gulfstream"] },
      { value: "IV", manufacturers: ["Gulfstream"] },
    ],
    fuelSource: {
      label: "Guardian Jet, Gulfstream GIV",
      url: "https://www.guardianjet.com/jet-aircraft-online-tools/aircraft-brochure.cfm?m=Gulfstream-GIV-135",
      notes: "Reports 540 gallons per hour fuel consumption.",
    },
    speedSource: {
      label: "Guardian Jet, Gulfstream GIV",
      url: "https://www.guardianjet.com/jet-aircraft-online-tools/aircraft-brochure.cfm?m=Gulfstream-GIV-135",
      notes: "Reports 500 ktas maximum cruise speed.",
    },
  },
  {
    key: "gulfstream_giii",
    name: "Gulfstream III",
    burnGph: 576,
    speedKts: 488,
    matchAliases: ["Gulfstream III", "Gulfstream GIII", "G III", "GIII", "G-1159A", "G1159A", "C-20A", "C20A"],
    fuelSource: {
      label: "Jet Advisors, Gulfstream G-III",
      url: "https://jetadvisors.com/jet/gulfstream-g-iii-operating-costs/",
      notes: "Reports 576 US gallons per hour fuel consumption.",
    },
    speedSource: {
      label: "Jet Advisors, Gulfstream G-III",
      url: "https://jetadvisors.com/jet/gulfstream-g-iii-operating-costs/",
      notes: "Reports 488 ktas high-speed cruise.",
    },
  },
  {
    key: "gulfstream_gv_g550",
    name: "Gulfstream GV / G550",
    burnGph: 438,
    speedKts: 488,
    matchAliases: [
      "Gulfstream GV",
      "Gulfstream G550",
      "Gulfstream 550",
      "G V",
      "GV",
      "GV SP",
      "GVSP",
      "G550",
      "G 550",
      "Gulfstream 5",
      "C-37A",
      "C37A",
      { value: "5", manufacturers: ["Gulfstream"] },
    ],
    fuelSource: {
      label: "Guardian Jet, Gulfstream G550",
      url: "https://www.guardianjet.com/jet-aircraft-online-tools/aircraft-brochure.cfm?m=Gulfstream-G550-132",
      notes: "Reports 438 gallons per hour fuel consumption.",
    },
    speedSource: {
      label: "Guardian Jet, Gulfstream G550",
      url: "https://www.guardianjet.com/jet-aircraft-online-tools/aircraft-brochure.cfm?m=Gulfstream-G550-132",
      notes: "Reports 488 ktas maximum cruise speed.",
    },
  },
  {
    key: "gulfstream_g500",
    name: "Gulfstream G500",
    burnGph: 455,
    speedKts: 530,
    matchAliases: ["Gulfstream G500", "GVII G500", "G500", "G 500"],
    fuelSource: {
      label: "Guardian Jet, Gulfstream G500",
      url: "https://www.guardianjet.com/jet-aircraft-online-tools/aircraft-brochure.cfm?m=Gulfstream-G500-211",
      notes: "Reports 455 gallons per hour fuel consumption.",
    },
    speedSource: {
      label: "Guardian Jet, Gulfstream G500",
      url: "https://www.guardianjet.com/jet-aircraft-online-tools/aircraft-brochure.cfm?m=Gulfstream-G500-211",
      notes: "Reports 530 ktas maximum cruise speed.",
    },
  },
  {
    key: "gulfstream_g600",
    name: "Gulfstream G600",
    burnGph: 500,
    speedKts: 530,
    matchAliases: ["Gulfstream G600", "GVII G600", "G600", "G 600"],
    fuelSource: {
      label: "Guardian Jet, Gulfstream G600",
      url: "https://www.guardianjet.com/jet-aircraft-online-tools/aircraft-brochure.cfm?m=Gulfstream-G600-202",
      notes: "Reports 500 gallons per hour fuel consumption.",
    },
    speedSource: {
      label: "Guardian Jet, Gulfstream G600",
      url: "https://www.guardianjet.com/jet-aircraft-online-tools/aircraft-brochure.cfm?m=Gulfstream-G600-202",
      notes: "Reports 530 ktas maximum cruise speed.",
    },
  },
  {
    key: "gulfstream_g700",
    name: "Gulfstream G700",
    burnGph: 509,
    speedKts: 530,
    matchAliases: ["Gulfstream G700", "Gulfstream 7", "GVIII G700", "G700", "G 700"],
    fuelSource: {
      label: "Guardian Jet, Gulfstream G700",
      url: "https://www.guardianjet.com/jet-aircraft-online-tools/aircraft-brochure.cfm?m=Gulfstream-G700-208",
      notes: "Reports 509 gallons per hour fuel consumption.",
    },
    speedSource: {
      label: "Guardian Jet, Gulfstream G700",
      url: "https://www.guardianjet.com/jet-aircraft-online-tools/aircraft-brochure.cfm?m=Gulfstream-G700-208",
      notes: "Reports 530 ktas maximum cruise speed.",
    },
  },
  {
    key: "gulfstream_g800",
    name: "Gulfstream G800",
    burnGph: 462,
    speedKts: 530,
    matchAliases: ["Gulfstream G800", "GVIII G800", "G800", "G 800"],
    fuelSource: {
      label: "Jet Advisors, Gulfstream G800",
      url: "https://jetadvisors.com/jet/gulfstream-g800-gviii/",
      notes: "Reports 462 US gallons per hour fuel consumption.",
    },
    speedSource: {
      label: "Gulfstream Aerospace, G800",
      url: "https://www.gulfstream.com/en/aircraft/gulfstream-g800/",
      notes: "Reports Mach 0.90 high-speed cruise; profile uses 530 ktas.",
    },
  },
  {
    key: "falcon_10",
    name: "Falcon 10",
    burnGph: 212,
    speedKts: 454,
    matchAliases: ["Falcon 10", "Mystere Falcon 10"],
    fuelSource: {
      label: "Liberty Jet, Falcon 10",
      url: "https://www.libertyjet.com/private_jets/DA-10",
      notes: "Reports 212 gph fuel burn.",
    },
    speedSource: {
      label: "Jet Advisors, Falcon 10",
      url: "https://jetadvisors.com/jet/falcon-10/",
      notes: "Reports 454 ktas high-speed cruise.",
    },
  },
  {
    key: "falcon_20f",
    name: "Falcon 20F",
    burnGph: 319,
    speedKts: 399,
    matchAliases: [
      "Falcon 20",
      "Falcon 20C",
      "Falcon 20F",
      "Falcon 20DC",
      "Fan Jet Falcon",
      "Mystere Falcon 20",
      "Mystere-Falcon 20",
      "Dassault/Sud Fan Jet Falcon",
    ],
    fuelSource: {
      label: "Jet Advisors, Falcon 20F",
      url: "https://jetadvisors.com/jet/falcon-20f/",
      notes: "Reports 319 US gallons per hour fuel consumption.",
    },
    speedSource: {
      label: "Jet Advisors, Falcon 20F",
      url: "https://jetadvisors.com/jet/falcon-20f/",
      notes: "Reports 399 ktas long-range cruise speed.",
    },
  },
  {
    key: "falcon_20e",
    name: "Falcon 20E",
    burnGph: 386.9,
    speedKts: 457,
    matchAliases: ["Falcon 20E", "Mystere Falcon 20E"],
    fuelSource: {
      label: "Planephd, Dassault Falcon 20E",
      url: "https://planephd.com/wizard/details/975/Dassault-Falcon-20E-specifications-performance-operating-cost-valuation",
      notes: "Reports 386.9 gallons per hour fuel burn.",
    },
    speedSource: {
      label: "Planephd, Dassault Falcon 20E",
      url: "https://planephd.com/wizard/details/975/Dassault-Falcon-20E-specifications-performance-operating-cost-valuation",
      notes: "Reports 457 KIAS best cruise speed.",
    },
  },
  {
    key: "falcon_100",
    name: "Falcon 100",
    burnGph: 240,
    speedKts: 476,
    matchAliases: ["Falcon 100", "Mystere Falcon 100"],
    fuelSource: {
      label: "Jet Advisors, Falcon 100",
      url: "https://jetadvisors.com/jet/falcon-100/",
      notes: "Reports 240 US gallons per hour fuel consumption.",
    },
    speedSource: {
      label: "Jet Advisors, Falcon 100",
      url: "https://jetadvisors.com/jet/falcon-100/",
      notes: "Reports 476 ktas high-speed cruise.",
    },
  },
  {
    key: "falcon_200",
    name: "Falcon 200",
    burnGph: 277,
    speedKts: 460,
    matchAliases: ["Falcon 200", "Mystere Falcon 200"],
    fuelSource: {
      label: "Jet Advisors, Falcon 200",
      url: "https://jetadvisors.com/jet/falcon-200/",
      notes: "Reports 277 US gallons per hour fuel consumption.",
    },
    speedSource: {
      label: "Business Jet Traveler, Dassault Falcon 200",
      url: "https://www.bjtonline.com/aircraft/dassault-falcon-200",
      notes: "Reports 460 ktas maximum cruise speed.",
    },
  },
  {
    key: "falcon_50",
    name: "Falcon 50",
    burnGph: 356,
    speedKts: 480,
    matchAliases: ["Falcon 50", "Mystere Falcon 50", "Falcon 50EX"],
    fuelSource: {
      label: "Guardian Jet, Dassault Falcon 50",
      url: "https://www.guardianjet.com/jet-aircraft-online-tools/aircraft-brochure.cfm?m=Dassault-Falcon-50-96",
      notes: "Reports 356 gallons per hour fuel consumption.",
    },
    speedSource: {
      label: "Guardian Jet, Dassault Falcon 50",
      url: "https://www.guardianjet.com/jet-aircraft-online-tools/aircraft-brochure.cfm?m=Dassault-Falcon-50-96",
      notes: "Reports 480 ktas maximum cruise speed.",
    },
  },
  {
    key: "falcon_900",
    name: "Falcon 900",
    burnGph: 304,
    speedKts: 482,
    matchAliases: ["Falcon 900", "Falcon 900B", "Falcon 900C", "Falcon 900DX", "Falcon 900EX", "Falcon 900LX", "Mystere Falcon 900"],
    fuelSource: {
      label: "Guardian Jet, Dassault Falcon 900EX EASy",
      url: "https://www.guardianjet.com/jet-aircraft-online-tools/aircraft-brochure.cfm?m=Dassault-Falcon-900EX-EASy-170",
      notes: "Reports 304 gallons per hour fuel consumption.",
    },
    speedSource: {
      label: "Guardian Jet, Dassault Falcon 900EX EASy",
      url: "https://www.guardianjet.com/jet-aircraft-online-tools/aircraft-brochure.cfm?m=Dassault-Falcon-900EX-EASy-170",
      notes: "Reports 482 ktas maximum cruise speed.",
    },
  },
  {
    key: "falcon_2000",
    name: "Falcon 2000",
    burnGph: 287,
    speedKts: 475,
    matchAliases: ["Falcon 2000"],
    fuelSource: {
      label: "Guardian Jet, Dassault Falcon 2000",
      url: "https://www.guardianjet.com/jet-aircraft-online-tools/aircraft-brochure.cfm?m=Dassault-Falcon-2000-92",
      notes: "Reports 287 gallons per hour fuel consumption.",
    },
    speedSource: {
      label: "Guardian Jet, Dassault Falcon 2000",
      url: "https://www.guardianjet.com/jet-aircraft-online-tools/aircraft-brochure.cfm?m=Dassault-Falcon-2000-92",
      notes: "Reports 475 ktas maximum cruise speed.",
    },
  },
  {
    key: "falcon_2000ex",
    name: "Falcon 2000EX",
    burnGph: 284,
    speedKts: 508,
    matchAliases: ["Falcon 2000EX", "Falcon 2000EX EASy"],
    fuelSource: {
      label: "Guardian Jet, Dassault Falcon 2000EX",
      url: "https://www.guardianjet.com/jet-aircraft-online-tools/aircraft-brochure.cfm?m=Dassault-Falcon-2000EX-93",
      notes: "Reports 284 gallons per hour fuel consumption.",
    },
    speedSource: {
      label: "Guardian Jet, Dassault Falcon 2000EX",
      url: "https://www.guardianjet.com/jet-aircraft-online-tools/aircraft-brochure.cfm?m=Dassault-Falcon-2000EX-93",
      notes: "Reports 508 ktas maximum cruise speed.",
    },
  },
  {
    key: "falcon_2000lx_lxs",
    name: "Falcon 2000LX / 2000LXS",
    burnGph: 280,
    speedKts: 508,
    matchAliases: ["Falcon 2000LX", "Falcon 2000LXS", "Falcon 2000S"],
    fuelSource: {
      label: "Guardian Jet, Dassault Falcon 2000LXS",
      url: "https://www.guardianjet.com/jet-aircraft-online-tools/aircraft-brochure.cfm?m=Dassault-Falcon-2000LXS-183",
      notes: "Reports 280 gallons per hour fuel consumption.",
    },
    speedSource: {
      label: "Guardian Jet, Dassault Falcon 2000EX",
      url: "https://www.guardianjet.com/jet-aircraft-online-tools/aircraft-brochure.cfm?m=Dassault-Falcon-2000EX-93",
      notes: "Reports 508 ktas maximum cruise speed.",
    },
  },
  {
    key: "falcon_7x",
    name: "Falcon 7X",
    burnGph: 394,
    speedKts: 492,
    matchAliases: ["Falcon 7X"],
    fuelSource: {
      label: "Jet Advisors, Falcon 7X",
      url: "https://jetadvisors.com/jet/falcon-7x/",
      notes: "Reports 394 US gallons per hour fuel consumption.",
    },
    speedSource: {
      label: "Guardian Jet, Dassault Falcon 7X",
      url: "https://www.guardianjet.com/jet-aircraft-online-tools/aircraft-brochure.cfm?m=Dassault-Falcon-7X-98",
      notes: "Reports 492 ktas maximum cruise speed.",
    },
  },
  {
    key: "falcon_6x",
    name: "Falcon 6X",
    burnGph: 444,
    speedKts: 505,
    matchAliases: ["Falcon 6X"],
    fuelSource: {
      label: "Virtual Hangar, Falcon 6X",
      url: "https://virtualhangar.com/aircraft-manufacturers/dassault-falcon/falcon-6x",
      notes: "Reports 444 US gallons per hour fuel consumption.",
    },
    speedSource: {
      label: "Virtual Hangar, Falcon 6X",
      url: "https://virtualhangar.com/aircraft-manufacturers/dassault-falcon/falcon-6x",
      notes: "Reports 505 ktas maximum cruise speed.",
    },
  },
  {
    key: "falcon_8x",
    name: "Falcon 8X",
    burnGph: 377,
    speedKts: 492,
    matchAliases: ["Falcon 8X"],
    fuelSource: {
      label: "Guardian Jet, Dassault Falcon 8X",
      url: "https://www.guardianjet.com/jet-aircraft-online-tools/aircraft-brochure.cfm?m=Dassault-Falcon-8X-194",
      notes: "Reports 377 gallons per hour fuel consumption.",
    },
    speedSource: {
      label: "Guardian Jet, Dassault Falcon 8X",
      url: "https://www.guardianjet.com/jet-aircraft-online-tools/aircraft-brochure.cfm?m=Dassault-Falcon-8X-194",
      notes: "Reports 492 ktas maximum cruise speed.",
    },
  },
  {
    key: "challenger_300",
    name: "Challenger 300",
    burnGph: 295,
    speedKts: 470,
    matchAliases: ["Challenger 300", "CL 300", "BD 100 1A10", "BD100 1A10"],
    fuelSource: {
      label: "Guardian Jet, Bombardier CL 300",
      url: "https://www.guardianjet.com/jet-aircraft-online-tools/aircraft-brochure.cfm?m=Bombardier-CL-300-6",
      notes: "Reports 295 gallons per hour fuel consumption.",
    },
    speedSource: {
      label: "Guardian Jet, Bombardier CL 300",
      url: "https://www.guardianjet.com/jet-aircraft-online-tools/aircraft-brochure.cfm?m=Bombardier-CL-300-6",
      notes: "Reports 470 ktas maximum cruise speed.",
    },
  },
  {
    key: "challenger_350",
    name: "Challenger 350 / 3500",
    burnGph: 297,
    speedKts: 470,
    matchAliases: ["Challenger 350", "Challenger 3500", "CL 350", "CL 3500", "BD 100 Challenger 350"],
    fuelSource: {
      label: "Guardian Jet, Bombardier CL 350/3500",
      url: "https://www.guardianjet.com/jet-aircraft-online-tools/aircraft-brochure.cfm?m=Bombardier-CL-350%2F3500-185",
      notes: "Reports 297 gallons per hour fuel consumption.",
    },
    speedSource: {
      label: "Guardian Jet, Bombardier CL 350/3500",
      url: "https://www.guardianjet.com/jet-aircraft-online-tools/aircraft-brochure.cfm?m=Bombardier-CL-350%2F3500-185",
      notes: "Reports 470 ktas maximum cruise speed.",
    },
  },
  {
    key: "challenger_604_605_650",
    name: "Challenger 604 / 605 / 650",
    burnGph: 329,
    speedKts: 488,
    matchAliases: [
      "Challenger 604",
      "Challenger 605",
      "Challenger 650",
      "CL 604",
      "CL 605",
      "CL 650",
      "CL 600 2B16",
      "CL600 2B16",
      "CL 600 Challenger",
      "Canadair Challenger",
    ],
    fuelSource: {
      label: "Guardian Jet, Bombardier CL 605",
      url: "https://www.guardianjet.com/jet-aircraft-online-tools/aircraft-brochure.cfm?m=Bombardier-CL-605-47",
      notes: "Reports 329 gallons per hour fuel consumption.",
    },
    speedSource: {
      label: "Guardian Jet, Bombardier CL 650",
      url: "https://www.guardianjet.com/jet-aircraft-online-tools/aircraft-brochure.cfm?m=Bombardier-CL-650-193",
      notes: "Reports 488 ktas maximum cruise speed.",
    },
  },
  {
    key: "challenger_601_3a",
    name: "Challenger 601-3A",
    burnGph: 306,
    speedKts: 459,
    matchAliases: ["Challenger 601-3A", "Challenger 601 3A", "Canadair 601-3A", "Canadair 601 3A", "CL 601 3A"],
    fuelSource: {
      label: "Jet Advisors, Challenger 601-3A",
      url: "https://jetadvisors.com/jet/challenger-601-3a/",
      notes: "Reports 306 US gallons per hour fuel consumption.",
    },
    speedSource: {
      label: "Jet Advisors, Challenger 601-3A",
      url: "https://jetadvisors.com/jet/challenger-601-3a/",
      notes: "Reports 459 ktas maximum cruise speed.",
    },
  },
  {
    key: "challenger_601_3r",
    name: "Challenger 601-3R",
    burnGph: 304,
    speedKts: 459,
    matchAliases: ["Challenger 601-3R", "Challenger 601 3R", "Canadair 601-3R", "Canadair 601 3R", "CL 601 3R"],
    fuelSource: {
      label: "Jet Advisors, Challenger 601-3R",
      url: "https://jetadvisors.com/jet/challenger-601-3r/",
      notes: "Reports 304 US gallons per hour fuel consumption.",
    },
    speedSource: {
      label: "Planephd, Challenger 601-3R",
      url: "https://planephd.com/wizard/details/726/BOMBARDIER-CHALLENGER-601-3R-specifications-performance-operating-cost-valuation",
      notes: "Reports 459 KIAS best cruise speed.",
    },
  },
  {
    key: "challenger_850",
    name: "Challenger 850",
    burnGph: 333,
    speedKts: 460,
    matchAliases: ["Challenger 850", "Challenger 850 CS"],
    fuelSource: {
      label: "Jetcraft, Bombardier Challenger 850",
      url: "https://www.jetcraft.com/jetstream/2022/10/bombardier-challenger-850-1996-2017/",
      notes: "Reports combined fuel use of 333 gallons per hour.",
    },
    speedSource: {
      label: "Craft, Bombardier Challenger 850",
      url: "https://flycraft.com/aircraft/bombardier-challenger-850",
      notes: "Reports cruise up to 460 knots.",
    },
  },
  {
    key: "global_5000_6000",
    name: "Global 5000 / 6000",
    burnGph: 512,
    speedKts: 505,
    matchAliases: [
      "Global 5000",
      "Global 5500",
      "Global 6000",
      "Global 6500",
      "BD 700 Global 5000",
      "BD 700 Global 6000",
      "BD 700 1A11",
      "BD700 1A11",
      "BD-700-1A11",
    ],
    fuelSource: {
      label: "Guardian Jet, Bombardier Global 6000",
      url: "https://www.guardianjet.com/jet-aircraft-online-tools/aircraft-brochure.cfm?m=Bombardier-Global-6000-52",
      notes: "Reports 512 gallons per hour fuel consumption.",
    },
    speedSource: {
      label: "Guardian Jet, Bombardier Global 6000",
      url: "https://www.guardianjet.com/jet-aircraft-online-tools/aircraft-brochure.cfm?m=Bombardier-Global-6000-52",
      notes: "Reports 505 ktas maximum cruise speed.",
    },
  },
  {
    key: "global_express",
    name: "Global Express",
    burnGph: 535,
    speedKts: 500,
    matchAliases: ["Global Express", "BD 700 1A10", "BD700 1A10", "BD-700-1A10"],
    fuelSource: {
      label: "Guardian Jet, Bombardier Global Express",
      url: "https://www.guardianjet.com/jet-aircraft-online-tools/aircraft-brochure.cfm?m=Bombardier-Global-Express-50",
      notes: "Reports 535 gallons per hour fuel consumption.",
    },
    speedSource: {
      label: "Guardian Jet, Bombardier Global Express",
      url: "https://www.guardianjet.com/jet-aircraft-online-tools/aircraft-brochure.cfm?m=Bombardier-Global-Express-50",
      notes: "Reports 500 ktas maximum cruise speed.",
    },
  },
  {
    key: "legacy_600_650",
    name: "Legacy 600 / 650",
    burnGph: 341,
    speedKts: 456,
    matchAliases: [
      "Legacy 600",
      "Legacy 650",
      "EMB 135 Legacy",
      "EMB 145 Legacy",
      "EMB 135BJ",
      "EMB 135KL",
      "EMB-135BJ",
      "EMB-135KL",
    ],
    fuelSource: {
      label: "Jet Advisors, Embraer Legacy 650",
      url: "https://jetadvisors.com/jet/embraer-legacy-650/",
      notes: "Reports 341 US gallons per hour fuel consumption.",
    },
    speedSource: {
      label: "Guardian Jet, Embraer Legacy 650",
      url: "https://www.guardianjet.com/jet-aircraft-online-tools/aircraft-brochure.cfm?m=Embraer-Legacy-650-162",
      notes: "Reports 456 ktas maximum cruise speed.",
    },
  },
  {
    key: "legacy_500_praetor_600",
    name: "Legacy 500 / Praetor 600",
    burnGph: 298,
    speedKts: 466,
    matchAliases: ["Legacy 500", "Praetor 600", "EMB 550", "Embraer 550", { value: "550", manufacturers: ["Embraer"] }],
    fuelSource: {
      label: "Guardian Jet, Embraer Praetor 600",
      url: "https://www.guardianjet.com/jet-aircraft-online-tools/aircraft-brochure.cfm?m=Embraer-Praetor-600-201",
      notes: "Reports 298 gallons per hour fuel consumption.",
    },
    speedSource: {
      label: "Guardian Jet, Embraer Praetor 600",
      url: "https://www.guardianjet.com/jet-aircraft-online-tools/aircraft-brochure.cfm?m=Embraer-Praetor-600-201",
      notes: "Reports 466 ktas maximum cruise speed.",
    },
  },
  {
    key: "shorts_360",
    name: "Shorts 360",
    burnGph: 123,
    speedKts: 200,
    matchAliases: ["Shorts 360", "Short 360", "Shorts SD3-60", "SD3-60", "SD-360", "SD 360"],
    fuelSource: {
      label: "Wikipedia, Short 360 specifications",
      url: "https://en.wikipedia.org/wiki/Short_360",
      notes: "Reports 820 lb/h fuel consumption at 200 kn TAS; profile converts to 123 gph.",
    },
    speedSource: {
      label: "Wikipedia, Short 360 specifications",
      url: "https://en.wikipedia.org/wiki/Short_360",
      notes: "Reports fuel-consumption condition at 200 kn TAS.",
    },
  },
  {
    key: "beechcraft_1900c",
    name: "Beechcraft 1900C",
    burnGph: 109.1,
    speedKts: 240,
    matchAliases: ["Beech 1900C", "Beechcraft 1900C", "1900C"],
    fuelSource: {
      label: "Planephd, Beechcraft 1900C",
      url: "https://planephd.com/wizard/details/920/BEECHCRAFT-1900C-specifications-performance-operating-cost-valuation",
      notes: "Reports 109.1 gph fuel burn.",
    },
    speedSource: {
      label: "Planephd, Beechcraft 1900C",
      url: "https://planephd.com/wizard/details/920/BEECHCRAFT-1900C-specifications-performance-operating-cost-valuation",
      notes: "Reports 240 KIAS best cruise speed.",
    },
  },
  {
    key: "beechcraft_1900d",
    name: "Beechcraft 1900D",
    burnGph: 111.3,
    speedKts: 277,
    matchAliases: ["Beech 1900D", "Beechcraft 1900D", "1900D"],
    fuelSource: {
      label: "Planephd, Beechcraft 1900D",
      url: "https://planephd.com/wizard/details/921/BEECHCRAFT-1900D-specifications-performance-operating-cost-valuation",
      notes: "Reports 111.3 gph fuel burn.",
    },
    speedSource: {
      label: "Planephd, Beechcraft 1900D",
      url: "https://planephd.com/wizard/details/921/BEECHCRAFT-1900D-specifications-performance-operating-cost-valuation",
      notes: "Reports 277 KIAS best cruise speed.",
    },
  },
  {
    key: "pilatus_pc12",
    name: "Pilatus PC-12",
    burnGph: 77,
    speedKts: 290,
    matchAliases: ["PC-12", "PC 12", "PC-12/45", "PC-12/47", "PC-12/47E", "Pilatus PC-12"],
    fuelSource: {
      label: "Guardian Jet, Pilatus PC-12 NG",
      url: "https://www.guardianjet.com/jet-aircraft-online-tools/aircraft-brochure.cfm?m=Pilatus-PC-12-NG-150",
      notes: "Reports 77 gallons per hour fuel consumption.",
    },
    speedSource: {
      label: "Pilatus Aircraft, PC-12 technical data",
      url: "https://www.pilatus-aircraft.com/en/pc-12/technical-data",
      notes: "Reports 290 KTAS maximum cruise speed.",
    },
  },
  {
    key: "embraer_emb120",
    name: "Embraer EMB-120 Brasilia",
    burnGph: 128.7,
    speedKts: 270,
    matchAliases: ["EMB-120", "EMB 120", "EMB-120ER", "EMB 120ER", "EMB120", "Embraer 120", "Brasilia"],
    fuelSource: {
      label: "Airlines Inform, Embraer EMB-120 Brasilia specifications",
      url: "https://www.airlines-inform.com/commercial-aircraft/embraer-120-brasilia.html",
      notes: "Reports 390 kg/h fuel flow; profile converts with 3.03 kg/gal Jet-A density.",
    },
    speedSource: {
      label: "GlobalAir, Embraer 120ER specifications",
      url: "https://www.globalair.com/aircraft-specifications/embraer/embraer-120er-specifications/830",
      notes: "Reports 270 knot normal cruise speed.",
    },
  },
  {
    key: "daher_tbm700",
    name: "Daher/Socata TBM 700",
    burnGph: 55,
    speedKts: 300,
    matchAliases: ["TBM 700", "TBM700", "TBM-700", "Socata TBM 700", "Daher TBM 700"],
    fuelSource: {
      label: "Guardian Jet, Daher TBM 700",
      url: "https://www.guardianjet.com/jet-aircraft-online-tools/aircraft-brochure.cfm?m=Daher-TBM-700-184",
      notes: "Reports 55 gallons per hour fuel consumption.",
    },
    speedSource: {
      label: "AOPA, Daher TBM 700 quick look",
      url: "https://www.aopa.org/news-and-media/all-news/2021/june/pilot/turbine-quick-look-daher-tbm-700",
      notes: "Reports 300 kt maximum cruise speed.",
    },
  },
  {
    key: "fairchild_metro_sa227",
    name: "Fairchild/Swearingen Metro SA227",
    burnGph: 100,
    speedKts: 280,
    matchAliases: [
      "Metro III",
      "Metroliner",
      "Swearingen Metro",
      "Fairchild Metro",
      "SA227",
      "SA 227",
      "SA227-AC",
      "SA227-AT",
      "SA227-DC",
      "SA 227AC",
      "SA 227AT",
      "SA 227DC",
    ],
    fuelSource: {
      label: "AOPA, Turbine Pilot",
      url: "https://www.aopa.org/news-and-media/all-news/1994/february/pilot/turbine-pilot-%284%29",
      notes: "Reports 670 pph, approximately 100 gallons per hour, for the Merlin/Metro IIIB.",
    },
    speedSource: {
      label: "AOPA, Turbine Pilot",
      url: "https://www.aopa.org/news-and-media/all-news/1994/february/pilot/turbine-pilot-%284%29",
      notes: "Reports flight planning at 280 KTAS.",
    },
  },
  {
    key: "king_air_350_b300",
    name: "Beechcraft King Air 350 / B300",
    burnGph: 136,
    speedKts: 320,
    matchAliases: [
      "King Air 350",
      "Super King Air 350",
      "Beech King Air 350",
      "Beechcraft King Air 350",
      "B300",
      "B300C",
    ],
    fuelSource: {
      label: "Guardian Jet, Beech King Air 350",
      url: "https://www.guardianjet.com/jet-aircraft-online-tools/aircraft-brochure.cfm?m=Beech-King-Air-350-16",
      notes: "Reports 136 gallons per hour fuel consumption.",
    },
    speedSource: {
      label: "Guardian Jet, Beech King Air 350",
      url: "https://www.guardianjet.com/jet-aircraft-online-tools/aircraft-brochure.cfm?m=Beech-King-Air-350-16",
      notes: "Reports 320 ktas maximum cruise speed.",
    },
  },
  {
    key: "king_air_200_b200",
    name: "Beechcraft King Air 200 / B200",
    burnGph: 113,
    speedKts: 290,
    matchAliases: [
      "King Air 200",
      "King Air B200",
      "King Air B200GT",
      "Beech 200",
      "Beech B200",
      "B200",
      "B200GT",
      { value: "200", manufacturers: ["Beech", "Beechcraft", "Hawker", "Raytheon", "Textron"] },
    ],
    fuelSource: {
      label: "Guardian Jet, Beech King Air B200",
      url: "https://www.guardianjet.com/jet-aircraft-online-tools/aircraft-brochure.cfm?m=Beech-King-Air-B200-21",
      notes: "Reports 113 gallons per hour fuel consumption.",
    },
    speedSource: {
      label: "Guardian Jet, Beech King Air B200",
      url: "https://www.guardianjet.com/jet-aircraft-online-tools/aircraft-brochure.cfm?m=Beech-King-Air-B200-21",
      notes: "Reports 290 ktas maximum cruise speed.",
    },
  },
  {
    key: "cessna_caravan_208b",
    name: "Cessna Caravan 208B",
    burnGph: 56,
    speedKts: 184,
    matchAliases: ["Caravan 208B", "Grand Caravan", "Cessna 208B", "Textron 208B", "208B"],
    fuelSource: {
      label: "Guardian Jet, Cessna/Textron Caravan 208B",
      url: "https://www.guardianjet.com/jet-aircraft-online-tools/aircraft-brochure.cfm?m=Cessna%2FTextron-Caravan-208B-64",
      notes: "Reports 56 gallons per hour fuel consumption.",
    },
    speedSource: {
      label: "Guardian Jet, Cessna/Textron Caravan 208B",
      url: "https://www.guardianjet.com/jet-aircraft-online-tools/aircraft-brochure.cfm?m=Cessna%2FTextron-Caravan-208B-64",
      notes: "Reports 184 ktas maximum cruise speed.",
    },
  },
  {
    key: "beechcraft_99",
    name: "Beechcraft 99",
    burnGph: 74.6,
    speedKts: 215,
    matchAliases: ["Beech 99", "Beechcraft 99", "King Air 99", "99", "99A", "B-99", "B 99"],
    fuelSource: {
      label: "Planephd, Beechcraft 99",
      url: "https://planephd.com/wizard/details/919/BEECHCRAFT-99-specifications-performance-operating-cost-valuation",
      notes: "Reports 74.6 gph fuel burn.",
    },
    speedSource: {
      label: "Planephd, Beechcraft 99",
      url: "https://planephd.com/wizard/details/919/BEECHCRAFT-99-specifications-performance-operating-cost-valuation",
      notes: "Reports 215 KIAS best cruise speed.",
    },
  },
  {
    key: "king_air_300",
    name: "Beechcraft King Air 300",
    burnGph: 135,
    speedKts: 320,
    matchAliases: [
      "King Air 300",
      "Beech King Air 300",
      "Beechcraft King Air 300",
      "Beech 300",
      { value: "300", manufacturers: ["Beech", "Beechcraft", "Hawker", "Raytheon", "Textron"] },
    ],
    fuelSource: {
      label: "Guardian Jet, Beech King Air 300",
      url: "https://www.guardianjet.com/jet-aircraft-online-tools/aircraft-brochure.cfm?m=Beech-King-Air-300-18",
      notes: "Reports 135 gallons per hour fuel consumption.",
    },
    speedSource: {
      label: "Guardian Jet, Beech King Air 300",
      url: "https://www.guardianjet.com/jet-aircraft-online-tools/aircraft-brochure.cfm?m=Beech-King-Air-300-18",
      notes: "Reports 320 ktas maximum cruise speed.",
    },
  },
  {
    key: "king_air_90",
    name: "Beechcraft King Air 90",
    burnGph: 78,
    speedKts: 223,
    matchAliases: ["King Air 90", "King Air C90", "C90", "C90A", "C90GT", "C90GTI", "C90GTx", "E-90", "E 90", "F90", "65-A90", "65 A90"],
    fuelSource: {
      label: "Guardian Jet, Beech King Air C90",
      url: "https://www.guardianjet.com/jet-aircraft-online-tools/aircraft-brochure.cfm?m=Beech-King-Air-C90-31",
      notes: "Reports 78 gallons per hour fuel consumption.",
    },
    speedSource: {
      label: "Guardian Jet, Beech King Air C90",
      url: "https://www.guardianjet.com/jet-aircraft-online-tools/aircraft-brochure.cfm?m=Beech-King-Air-C90-31",
      notes: "Reports 223 ktas maximum cruise speed.",
    },
  },
  {
    key: "piper_meridian_m500",
    name: "Piper Meridian / M500",
    burnGph: 48,
    speedKts: 260,
    matchAliases: ["PA-46-500TP", "PA46-500TP", "PA 46 500TP", "Meridian", "Piper M500", "M500"],
    fuelSource: {
      label: "Guardian Jet, Piper Meridian",
      url: "https://www.guardianjet.com/jet-aircraft-online-tools/aircraft-brochure.cfm?m=Piper-Meridian-151",
      notes: "Reports 48 gallons per hour fuel consumption.",
    },
    speedSource: {
      label: "GlobalAir, Piper M-Class Meridian M500 specifications",
      url: "https://www.globalair.com/aircraft-specifications/piper/m-class-meridian-m500-specifications/1514",
      notes: "Reports 260 knot maximum cruise speed.",
    },
  },
  {
    key: "piper_m600",
    name: "Piper M600",
    burnGph: 39,
    speedKts: 274,
    matchAliases: ["PA-46-600TP", "PA46-600TP", "PA 46 600TP", "Piper M600", "M600"],
    fuelSource: {
      label: "Guardian Jet, Piper M600",
      url: "https://www.guardianjet.com/jet-aircraft-online-tools/aircraft-brochure.cfm?m=Piper-M600-214",
      notes: "Reports 39 gallons per hour fuel consumption.",
    },
    speedSource: {
      label: "Altivation Aircraft, Piper M600 specifications",
      url: "https://altivationaircraft.com/piper-m600/",
      notes: "Reports 274 ktas maximum cruise speed.",
    },
  },
  {
    key: "citation_cj4",
    name: "Citation CJ4",
    burnGph: 209,
    speedKts: 451,
    matchAliases: ["Citation CJ4", "CJ4", "Cessna 525C", "Textron 525C", "525C", { value: "525C", manufacturers: ["Cessna", "Textron"] }],
    fuelSource: {
      label: "Guardian Jet, Cessna/Textron CJ4",
      url: "https://www.guardianjet.com/jet-aircraft-online-tools/aircraft-brochure.cfm?m=Cessna%2FTextron-CJ4-77",
      notes: "Reports 209 gallons per hour fuel consumption.",
    },
    speedSource: {
      label: "Guardian Jet, Cessna/Textron CJ4",
      url: "https://www.guardianjet.com/jet-aircraft-online-tools/aircraft-brochure.cfm?m=Cessna%2FTextron-CJ4-77",
      notes: "Reports 451 ktas maximum cruise speed.",
    },
  },
  {
    key: "gulfstream_g650",
    name: "Gulfstream G650",
    burnGph: 500,
    speedKts: 516,
    matchAliases: ["Gulfstream G650", "Gulfstream G650ER", "Gulfstream 650ER", "Gulfstream 6", "G650", "G650ER", "GVI"],
    fuelSource: {
      label: "Guardian Jet, Gulfstream G650",
      url: "https://www.guardianjet.com/jet-aircraft-online-tools/aircraft-brochure.cfm?m=Gulfstream-G650-29",
      notes: "Reports 500 gallons per hour fuel consumption.",
    },
    speedSource: {
      label: "Business Jet Traveler, Gulfstream G650",
      url: "https://www.bjtonline.com/aircraft/gulfstream-g650",
      notes: "Reports 516 ktas maximum cruise speed.",
    },
  },
  {
    key: "global_7500",
    name: "Global 7500",
    burnGph: 528,
    speedKts: 516,
    matchAliases: [
      "Global 7500",
      "Global 7000",
      "BD 700 Global 7500",
      "BD 700 Global 7000",
      "BD 700 2A12",
      "BD700 2A12",
      "BD-700-2A12",
    ],
    fuelSource: {
      label: "Guardian Jet, Bombardier Global 7500",
      url: "https://www.guardianjet.com/jet-aircraft-online-tools/aircraft-brochure.cfm?m=Bombardier-Global-7500-203",
      notes: "Reports 528 gallons per hour fuel consumption.",
    },
    speedSource: {
      label: "Altivation Aircraft, Global 7500 specifications",
      url: "https://altivationaircraft.com/global-7500-specifications/",
      notes: "Reports 516 ktas high cruise speed.",
    },
  },
];

const COMPILED_AIRCRAFT_PROFILES = AIRCRAFT_PROFILES.map(compileAircraftProfile);
const BUSINESS_JET_FALLBACK_PROFILE = COMPILED_AIRCRAFT_PROFILES.find((profile) => profile.key === "citation_cj4");
const EUROCONTROL_AIRCRAFT_CODE_PATTERNS = [
  [/\b560XLS?\b|CITATION (EXCEL|XLS)/, "C56X"],
  [/\bEMB\s*505\b|PHENOM 300/, "E55P"],
  [/\b525B\b|CITATION CJ3/, "C25B"],
  [/LEARJET.*\b45(XR)?\b|\bLEAR\s*45\b/, "LJ45"],
  [/LEARJET.*\b40(XR)?\b|\bLEAR\s*40\b/, "LJ40"],
  [/LEARJET.*\b70\b|\bLEAR\s*70\b/, "LJ70"],
  [/LEARJET.*\b75\b|\bLEAR\s*75\b/, "LJ75"],
  [/\bGULFSTREAM G280\b|\bG280\b/, "G280"],
  [/\bTEXTRON.*\b700\b|\bCESSNA.*\b700\b|CITATION LONGITUDE/, "C700"],
  [/\bFALCON 2000(EX|LX|LXS)?\b|MYSTERE FALCON 2000/, "F2TH"],
  [/\bHAWKER (750|800|800XP|850XP|900XP)\b|\b800XP\b|\b850XP\b|\b900XP\b/, "H25B"],
  [/\bHAWKER 1000\b|\b1000A\b|\b1000B\b/, "H25C"],
  [/\bCITATION X\b|\bCESSNA.*\b750\b|\b750\b/, "C750"],
  [/\b525A\b|CITATION CJ2/, "C25A"],
  [/\b525C\b|CITATION CJ4/, "C25C"],
  [/CITATION M2\b/, "C25M"],
  [/\bCESSNA.*\b525\b|\bTEXTRON.*\b525\b|CITATIONJET|CITATION JET|CITATION CJ1\b/, "C525"],
  [/\bBEECHJET\b|\b400A\b|HAWKER 400(XP)?\b/, "BE40"],
  [/\bMU[\s-]?300\b/, "MU30"],
  [/\bGVII[\s-]?G600\b|\bGULFSTREAM G600\b|\bG600\b/, "GA6C"],
  [/\bGVII[\s-]?G500\b|\bGULFSTREAM G500\b|\bG500\b/, "GA5C"],
  [/\bGVI\b|\bGULFSTREAM G650(ER)?\b|\bG650(ER)?\b/, "GLF6"],
  [/\bGV[\s-]?SP\b|\bGULFSTREAM G550\b|\bG550\b|\bGULFSTREAM G5\b|\bGULFSTREAM G-V\b|\bG-V\b/, "GLF5"],
  [/\bGIV[\s-]?X\b|\bGULFSTREAM G450\b|\bG450\b|\bGULFSTREAM G400\b|\bG[\s-]?IV\b|\bGIV\b/, "GLF4"],
  [/\bG[\s-]?V\b/, "GLF5"],
  [/\bHAWKER 4000\b|\b4000\b/, "HA4T"],
  [/\bEMB\s*545\b|LEGACY 450|PRAETOR 500/, "E545"],
  [/\bEMB\s*550\b|LEGACY 500|PRAETOR 600/, "E550"],
  [/\bPC[\s-]?24\b/, "PC24"],
  [/\bFALCON 900/, "F900"],
  [/\bSF[\s-]?50\b|VISION JET/, "SF50"],
  [/\bCESSNA.*\b680A\b|\bTEXTRON.*\b680A\b|CITATION LATITUDE/, "C68A"],
  [/\bCESSNA.*\b680\b|\bTEXTRON.*\b680\b|CITATION SOVEREIGN/, "C680"],
  [/\bCESSNA.*\b650\b|CITATION III|CITATION VII/, "C650"],
  [/\bHA[\s-]?420\b|HONDAJET|HONDA JET/, "HDJT"],
  [/\bEMB\s*500\b|PHENOM 100/, "E50P"],
  [/\bFALCON 7X\b/, "FA7X"],
  [/\bFALCON 8X\b/, "FA8X"],
  [/\bFALCON 6X\b/, "FA6X"],
  [/LEARJET.*\b60\b|\bLEAR\s*60\b/, "LJ60"],
  [/\bCESSNA.*\b510\b|CITATION MUSTANG|MUSTANG/, "C510"],
  [/\bGULFSTREAM 200\b|\bGULFSTREAM G200\b|\bG200\b|\bGALAXY\b|\b1126\b/, "GALX"],
  [/\bGULFSTREAM G150\b|\bG150\b/, "G150"],
  [/\bPREMIER\b|\bHAWKER 200\b|\bRAYTHEON.*\b390\b|\bBEECH.*\b390\b|\b390\b/, "PRM1"],
  [/\bEMB[\s-]?135BJ\b|LEGACY 600|LEGACY 650/, "E35L"],
  [/\bCL[\s-]?600[\s-]?2B16\b|\bCL[\s-]?600 CHALLENGER\b|CHALLENGER (604|605|650)|CANADAIR CHALLENGER/, "CL60"],
  [/LEARJET.*\b31A?\b|\bLEAR\s*31A?\b/, "LJ31"],
  [/LEARJET.*\b35A?\b|\bLEAR\s*35A?\b/, "LJ35"],
  [/LEARJET.*\b55[BC]?\b|\bLEAR\s*55[BC]?\b/, "LJ55"],
  [/\bFALCON 10\b/, "FA10"],
  [/\bFALCON 20\b/, "FA20"],
  [/\bFALCON 50\b|MYSTERE[\s-]?FALCON 50/, "FA50"],
  [/\bBAE 125 800A\b|\bBAE 125 800\b|\b125 800A\b|\b125 800\b/, "H25B"],
  [/\b1125\b|WESTWIND ASTRA|\bASTRA\b/, "ASTR"],
  [/\b1124\b|IAI.*WESTWIND|ISRAEL.*WESTWIND/, "WW24"],
  [/SABRELINER|\bNA[\s-]?265\b/, "SBR1"],
  [/\bEA5[05]0\b|\bEA\s*5[05]0\b|ECLIPSE.*\b5[05]0\b/, "EA50"],
  [/\bBD[\s-]?100.*CHALLENGER 350|CHALLENGER 350|CHALLENGER 3500|\bCL35\b/, "CL35"],
  [/\bBD[\s-]?100|CHALLENGER 300|\bCL30\b/, "CL30"],
  [/\bGLOBAL 5500\b|\bGL5T\b/, "GL5T"],
  [/\bGLOBAL (7000|7500|8000)\b|\bGL7T\b|\bBD[\s-]?700[\s-]?2A12\b/, "GL7T"],
  [/\bBD[\s-]?700\b|GLOBAL (5000|6000|6500|EXPRESS)|\bGLEX\b/, "GLEX"],
  [/\bGULFSTREAM G700\b|\bG700\b/, "GA7C"],
  [/\bGULFSTREAM G800\b|\bG800\b/, "GA8C"],
  [/\bCESSNA.*\bS550\b|\bS550\b|CITATION S2|CITATION S II\b/, "C550"],
  [/\bCESSNA.*\b551\b|\b551\b|CITATION II SP\b|CITATION 2SP\b/, "C551"],
  [/CITATION BRAVO|\b550B\b/, "C55B"],
  [/\bCESSNA.*\b550\b|CITATION II\b|\b550\b/, "C550"],
  [/\bCESSNA.*\b560\b|CITATION V\b|CITATION ULTRA|CITATION ENCORE|\b560\b/, "C560"],
  [/\bCESSNA.*\b501\b|CITATION 1SP\b|CITATION I SP\b/, "C501"],
  [/\bCESSNA.*\b500\b|CITATION I\b|CITATION 1\b/, "C500"],
];
// Curves excluded from the Combined model's primary branch. Previously held
// "G200", which turned out to be a mislabel rather than a bad curve: SET's
// G200 designator is the Giles G-200 piston kit plane, while the Gulfstream
// G200/Galaxy is GALX (see ICAO Doc 8643).
const EUROCONTROL_SUSPICIOUS_ICAO_CODES = new Set();
const TURBOPROP_PROFILE_KEYS = new Set([
  "shorts_360",
  "beechcraft_1900c",
  "beechcraft_1900d",
  "pilatus_pc12",
  "embraer_emb120",
  "daher_tbm700",
  "fairchild_metro_sa227",
  "king_air_350_b300",
  "king_air_200_b200",
  "cessna_caravan_208b",
  "beechcraft_99",
  "king_air_300",
  "king_air_90",
  "piper_meridian_m500",
  "piper_m600",
]);
const TURBOPROP_PROFILES = COMPILED_AIRCRAFT_PROFILES.filter((profile) => TURBOPROP_PROFILE_KEYS.has(profile.key));
const ESTIMABLE_AIRCRAFT_TYPES = new Set([
  "business_jet",
  "commercial_jet",
  "military",
  "turboprop",
  "commercial_turboprop",
]);
const BUSINESS_JET_FALLBACK_EXCLUSIONS = [
  /AIRBUS|\bA3[0-9]{2}\b|\bA2[0-9]{2}\b/,
  /\b3(?:18|19|20|21|30|50|80)[- ]?[0-9A-Z]*\b/,
  /BOEING|\b7[0-9]{2}\b|\bB7[0-9]{2}\b/,
  /ANTONOV|AN[- ]?124/,
  /COMAC|ARJ[- ]?21|SUKHOI|SSJ/,
  /REGIONAL[- ]?JET|CANADAIR REGIONAL|CRJ|CL[- ]?600[- ]?2B19|CL[- ]?600[- ]?2[CD][0-9]{2}/,
  /ERJ[- ]?|EMB[- ]?135LR|EMB[- ]?145|EMB[- ]?170|EMB[- ]?175|EMB[- ]?190|EMB[- ]?195|E[- ]?195/,
  /EMBRAER[- ]?(?:135LR|145|170|175|190|195)|170[- ]?200|175STD/,
  /FOKKER|\bF28\b|BAE[- ]?146|AVRO|RJ85|RJ100|DORNIER[- ]?328|DO[- ]?328/,
  /ERJ[- ]?135|EMB[- ]?135ER/,
  /BARON|BEECH.*G58|\bG58\b|\bG36\b|\bAA[- ]?5[AB]\b|CHALLENGER II|CIRRUS.*SR22|\bSR22\b|DIAMOND|DA[- ]?40|LANCAIR/,
  /CESSNA.*\b(?:150|152|170|172|T182|T206|414A)\b|TEXTRON.*\b208\b|\bC(?:150|152|170|172)\b|PIPER|PA[- ]?(?:31|32)|VANS|RV[- ]?3|TURBINE LEGEND/,
  /TUPOLEV|TU[- ]?204|ROBINSON|\bR22\b|\bR44\b|TECNAM|P2010|ILYUSHIN|IL[- ]?76/,
  /MC[- ]?21|IRKUT|DC[- ]?8|DC[- ]?9|\bF100\b|328[- ]?300/,
  /EUROCOPTER|EC[- ]?130|ANDURIL|HAVOC|DJI|AGRAS/,
  /SIAI|MARCHETTI|S[- ]?211|AERMACCHI|IMPALA|MB[- ]?326/,
  /TEST REGISTRATION|GLASAIR|LEGACY L2K|GA[- ]?7|COUGAR/,
  /AERO VODOCHODY|\bL[- ]?159\b|\bL[- ]?39[A-Z]*\b|\bL[- ]?29\b|DELFIN/,
  /NORTHROP|HUNTER|HNTR|HAWK|HURRICANE|FOUGA|MAGISTER|T[- ]?33|CT[- ]?33|T[- ]?38|ALPHA JET|KFIR|MIRAGE|GENERAL DYNAMICS.*F[- ]?16|LOCKHEED|ER[- ]?2|MCDONNELL DOUGLAS.*(?:\bA[- ]?4\b|TA[- ]?4)|\bA4N\b/,
];

function parseArgs(argv) {
  const args = {
    host: process.env.HOST || "127.0.0.1",
    port: Number(process.env.PORT || 8080),
    dbDir: environment("PJET_DB_DIR", DEFAULT_DB_DIR),
    adsbfiDbDir: environment("PJET_ADSBFI_DB_DIR", environment("ADSBFI_DB_DIR", DEFAULT_ADSBFI_DB_DIR)),
  };
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (value === "--host") args.host = argv[++index];
    else if (value === "--port") args.port = Number(argv[++index]);
    else if (value === "--db-dir") args.dbDir = argv[++index];
    else if (value === "--adsbfi-db-dir") args.adsbfiDbDir = argv[++index];
  }
  return args;
}

function escapeSqlString(value) {
  return String(value).replaceAll("'", "''");
}

function openDatabase(adsbfiDbDir) {
  const eventsPath = path.join(adsbfiDbDir, "events.sqlite");
  const airportsPath = path.join(adsbfiDbDir, "airports.sqlite");
  const aircraftPath = path.join(adsbfiDbDir, "aircraft.sqlite");
  for (const required of [eventsPath, airportsPath, aircraftPath]) {
    if (!fs.existsSync(required)) {
      throw new Error(`Missing ${required}; set PJET_ADSBFI_DB_DIR to an adsbfi-proxy database directory`);
    }
  }
  const cacheKiB = Number(environment("PJET_SQLITE_CACHE_KIB", DEFAULT_SQLITE_CACHE_KIB));
  const mmapBytes = Number(environment("PJET_SQLITE_MMAP_BYTES", DEFAULT_SQLITE_MMAP_BYTES));
  const db = new Database(eventsPath, { fileMustExist: true });
  db.exec(`
    ATTACH DATABASE '${escapeSqlString(airportsPath)}' AS airports;
    ATTACH DATABASE '${escapeSqlString(aircraftPath)}' AS aircraft;
    PRAGMA temp_store = MEMORY;
    PRAGMA cache_size = -${Number.isFinite(cacheKiB) && cacheKiB > 0 ? Math.round(cacheKiB) : DEFAULT_SQLITE_CACHE_KIB};
    PRAGMA mmap_size = ${Number.isFinite(mmapBytes) && mmapBytes > 0 ? Math.round(mmapBytes) : DEFAULT_SQLITE_MMAP_BYTES};
    PRAGMA query_only = ON;
  `);
  const hasEndpoints = db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'endpoints'").get();
  if (!hasEndpoints) {
    throw new Error(`${eventsPath} has no endpoints table; it must be an adsbfi-proxy movement ledger`);
  }
  const aircraftColumns = new Set(db.prepare("SELECT name FROM aircraft.pragma_table_info('aircraft')").all().map((row) => row.name));
  if (!aircraftColumns.has("icao_type")) {
    throw new Error(`${aircraftPath} is missing the icao_type column; rebuild it with "adsbfi-proxy import-aircraft"`);
  }
  return db;
}

function icaoHex(value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return "";
  return numeric.toString(16).padStart(6, "0");
}

function toIso(value) {
  if (value === null || value === undefined) return null;
  return new Date(Number(value) * 1000).toISOString();
}

function readLedgerMeta(db) {
  const values = Object.fromEntries(db.prepare("SELECT key, value FROM meta").all().map((row) => [row.key, row.value]));
  const ledger = {
    inferenceVersion: values.inference_version || null,
    ledgerSchema: values.ledger_schema || null,
  };
  if (values.endpoint_count && values.min_endpoint_ts && values.max_endpoint_ts) {
    return {
      ...ledger,
      count: Number(values.endpoint_count),
      min_ts: Number(values.min_endpoint_ts),
      max_ts: Number(values.max_endpoint_ts),
      source: "meta",
    };
  }
  return {
    ...ledger,
    ...db.prepare("SELECT COUNT(*) AS count, MIN(ts) AS min_ts, MAX(ts) AS max_ts FROM endpoints").get(),
    source: "endpoints_scan",
  };
}

function readEventRange(db) {
  const started = performance.now();
  const ledgerRow = readLedgerMeta(db);
  return {
    movements: Number(ledgerRow.count || 0),
    minTime: toIso(ledgerRow.min_ts),
    maxTime: toIso(ledgerRow.max_ts),
    source: ledgerRow.source,
    queryMs: roundNumber(performance.now() - started, 3),
  };
}

function readProcessedMeta(adsbfiDbDir) {
  const statePath = path.join(adsbfiDbDir, "build_state.sqlite");
  if (!fs.existsSync(statePath)) return null;
  const stateDb = new Database(statePath, { readonly: true, fileMustExist: true });
  try {
    return stateDb
      .prepare(
        `
        SELECT
          COUNT(*) AS processed_count,
          MAX(slot_ts) AS max_slot_ts
        FROM processed_files
        `
      )
      .get();
  } finally {
    stateDb.close();
  }
}

function fileSize(pathname) {
  try {
    return fs.statSync(pathname).size;
  } catch {
    return null;
  }
}

function databaseFileStats(adsbfiDbDir) {
  const names = [
    "events.sqlite",
    "events.sqlite-wal",
    "events.sqlite-shm",
    "airports.sqlite",
    "airports.sqlite-wal",
    "airports.sqlite-shm",
    "aircraft.sqlite",
    "aircraft.sqlite-wal",
    "aircraft.sqlite-shm",
    "build_state.sqlite",
    "build_state.sqlite-wal",
    "build_state.sqlite-shm",
  ];
  const files = names.map((name) => {
    const bytes = fileSize(path.join(adsbfiDbDir, name));
    return { name, bytes };
  });
  const totalBytes = files.reduce((total, file) => total + (file.bytes || 0), 0);
  return { totalBytes, files };
}

function readJsonFile(pathname) {
  try {
    return JSON.parse(fs.readFileSync(pathname, "utf8"));
  } catch {
    return null;
  }
}

function secondsSince(isoTime, now) {
  const timeMs = Date.parse(isoTime || "");
  return Number.isFinite(timeMs) ? Math.max(0, Math.round((now.getTime() - timeMs) / 1000)) : null;
}

function buildInfo(db, options) {
  const ledgerRow = readLedgerMeta(db);
  const processedRow = readProcessedMeta(options.adsbfiDbDir);
  const workerStatus = readJsonFile(path.join(options.adsbfiDbDir, "proxy-status.json"));
  const now = new Date();
  const maxTime = toIso(ledgerRow.max_ts);
  return {
    now: now.toISOString(),
    service: {
      name: "Private Jet Emissions Tracker",
      version: APP_VERSION,
      dataSource: "adsbfi-proxy (adsb.fi heatmaps)",
      ingestSlotMinutes: INGEST_SLOT_MINUTES,
      maxFlightHours: MAX_FLIGHT_SECONDS / 3600,
      isIngesting: Boolean(workerStatus?.build_running),
    },
    database: {
      adsbfiDbDir: options.adsbfiDbDir,
      inferenceVersion: ledgerRow.inferenceVersion,
      ledgerSchema: ledgerRow.ledgerSchema,
      movements: Number(ledgerRow.count || 0),
      minTime: toIso(ledgerRow.min_ts),
      maxTime,
      secondsSinceLatestMovement: secondsSince(maxTime, now),
      processedFiles: processedRow
        ? {
            count: Number(processedRow.processed_count || 0),
            maxSlotTime: toIso(processedRow.max_slot_ts),
          }
        : null,
      size: databaseFileStats(options.adsbfiDbDir),
    },
    ingest: workerStatus
      ? {
          processedThrough: workerStatus.processed_through || null,
          lagSeconds: workerStatus.lag_seconds ?? null,
          lastPollAt: workerStatus.last_poll_at || null,
          secondsSinceLastPoll: secondsSince(workerStatus.last_poll_at, now),
          lastBuildAt: workerStatus.last_build_at || null,
          downloadError: workerStatus.download_error || null,
          buildError: workerStatus.build_error || null,
          workerStatus,
        }
      : null,
  };
}

function markdownTitle(markdown, fallback) {
  const heading = String(markdown || "")
    .split(/\r?\n/)
    .find((line) => /^#\s+/.test(line));
  if (heading) return heading.replace(/^#\s+/, "").trim();
  return fallback
    .replace(/\.md$/i, "")
    .replace(/[-_]+/g, " ")
    .replace(/\b\w/g, (character) => character.toUpperCase());
}

function readDocs() {
  const files = fs.existsSync(DOCS_DIR)
    ? fs
        .readdirSync(DOCS_DIR, { withFileTypes: true })
        .filter((entry) => entry.isFile() && /\.md$/i.test(entry.name))
        .map((entry) => entry.name)
        .sort((left, right) => left.localeCompare(right))
    : [];
  return {
    updatedAt: new Date().toISOString(),
    docs: files.map((name) => {
      const markdown = fs.readFileSync(path.join(DOCS_DIR, name), "utf8");
      return {
        name,
        title: markdownTitle(markdown, name),
        markdown,
      };
    }),
  };
}

function renderInfoPage() {
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Private Jet Emissions Tracker Info</title>
    <link rel="stylesheet" href="/info.css" />
  </head>
  <body class="auth-pending">
    <main class="info-shell">
      <header class="info-header">
        <div>
          <h1>Private Jet Emissions Tracker Info</h1>
          <p id="infoUpdated">Loading</p>
        </div>
        <button type="button" id="refreshButton">Refresh</button>
      </header>
      <section id="infoStatus" class="status" aria-live="polite">Loading database status</section>
      <section id="infoContent" class="info-content"></section>
    </main>
    <div id="loginOverlay" class="login-overlay">
      <form id="loginForm" class="login-panel">
        <h2>Enter Password</h2>
        <label>
          <span>Password</span>
          <input id="passwordInput" type="password" placeholder="Password" autocomplete="current-password" />
        </label>
        <button type="submit">Open Info</button>
        <div id="loginError" class="login-error" role="alert"></div>
      </form>
    </div>
    <script src="/info.js"></script>
  </body>
</html>`;
}

function renderDocsPage() {
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Private Jet Emissions Tracker Docs</title>
    <link rel="stylesheet" href="/info.css" />
    <link rel="stylesheet" href="/docs.css" />
  </head>
  <body class="auth-pending">
    <main class="info-shell docs-shell">
      <header class="info-header">
        <div>
          <h1>Private Jet Emissions Tracker Docs</h1>
          <p id="docsUpdated">Loading</p>
        </div>
        <button type="button" id="refreshButton">Refresh</button>
      </header>
      <section id="docsStatus" class="status" aria-live="polite">Loading docs</section>
      <nav id="docsNav" class="docs-nav" aria-label="Documentation files"></nav>
      <section id="docsContent" class="docs-content"></section>
    </main>
    <div id="loginOverlay" class="login-overlay">
      <form id="loginForm" class="login-panel">
        <h2>Enter Password</h2>
        <label>
          <span>Password</span>
          <input id="passwordInput" type="password" placeholder="Password" autocomplete="current-password" />
        </label>
        <button type="submit">Open Docs</button>
        <div id="loginError" class="login-error" role="alert"></div>
      </form>
    </div>
    <script src="/docs.js"></script>
  </body>
</html>`;
}

function renderAdminPage() {
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Private Jet Emissions Tracker Admin</title>
    <link rel="stylesheet" href="/info.css" />
    <link rel="stylesheet" href="/admin.css" />
  </head>
  <body class="auth-pending">
    <main class="info-shell admin-shell">
      <header class="info-header">
        <div>
          <h1>Private Jet Emissions Tracker Admin</h1>
          <p>Manage the admin password and journalist vouchers.</p>
        </div>
        <div class="admin-header-actions">
          <button type="button" id="refreshButton">Refresh</button>
          <a class="button-link" href="/">Open PJET</a>
        </div>
      </header>
      <section id="adminStatus" class="status" aria-live="polite">Loading credentials</section>
      <div class="admin-content">
        <section class="info-section">
          <h2>Admin password</h2>
          <form id="adminPasswordForm" class="admin-form">
            <label>
              <span>Current admin password</span>
              <input id="currentAdminPassword" type="password" autocomplete="current-password" required />
            </label>
            <label>
              <span>New admin password</span>
              <input id="newAdminPassword" type="password" autocomplete="new-password" required />
            </label>
            <label>
              <span>Confirm password</span>
              <input id="confirmAdminPassword" type="password" autocomplete="new-password" required />
            </label>
            <button type="submit">Update admin password</button>
          </form>
          <p class="admin-note">Changing this password signs out every existing admin session, including this one.</p>
        </section>

        <section class="info-section">
          <h2>Journalist vouchers</h2>
          <form id="voucherForm" class="admin-form voucher-form">
            <label>
              <span>New voucher</span>
              <input id="voucherPassword" type="text" autocomplete="off" spellcheck="false" required />
            </label>
            <button type="submit">Add voucher</button>
          </form>
          <div class="table-wrap">
            <table class="voucher-table">
              <thead>
                <tr>
                  <th>Voucher ID</th>
                  <th>Queries</th>
                  <th>Created</th>
                  <th><span class="visually-hidden">Actions</span></th>
                </tr>
              </thead>
              <tbody id="voucherRows"></tbody>
            </table>
          </div>
          <p class="admin-note">Voucher values are shown only when created. Save them securely before leaving this page.</p>
          <p id="emptyVouchers" class="admin-empty" hidden>No vouchers have been added.</p>
        </section>
      </div>
    </main>

    <div id="loginOverlay" class="login-overlay">
      <form id="loginForm" class="login-panel">
        <h2>Enter Admin Password</h2>
        <label>
          <span>Admin password</span>
          <input id="passwordInput" type="password" placeholder="Password" autocomplete="current-password" />
        </label>
        <button type="submit">Open Admin</button>
        <div id="loginError" class="login-error" role="alert"></div>
      </form>
    </div>
    <script src="/admin.js"></script>
  </body>
</html>`;
}

function parseCookies(header) {
  return Object.fromEntries(
    String(header || "")
      .split(";")
      .map((part) => part.trim())
      .filter(Boolean)
      .map((part) => {
        const index = part.indexOf("=");
        if (index === -1) return [part, ""];
        const value = part.slice(index + 1);
        try {
          return [part.slice(0, index), decodeURIComponent(value)];
        } catch {
          return [part.slice(0, index), value];
        }
      })
  );
}

function base64Url(buffer) {
  return Buffer.from(buffer).toString("base64").replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/g, "");
}

function hmac(value, authStore) {
  return base64Url(createHmac("sha256", authStore.sessionSecret).update(value).digest());
}

function safeTokenEqual(a, b) {
  const left = Buffer.from(String(a || ""));
  const right = Buffer.from(String(b || ""));
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}

function signSession(credential, issued, authStore) {
  const payload = `${credential.credentialId}.${credential.sessionVersion}.${issued}`;
  return `${payload}.${hmac(payload, authStore)}`;
}

function authenticatedCredential(request, authStore) {
  const cookies = parseCookies(request.headers.cookie || "");
  const token = cookies[COOKIE_NAME];
  if (!token) return null;
  const [credentialIdRaw, sessionVersionRaw, issuedRaw, signature, ...extra] = token.split(".");
  if (extra.length) return null;
  const credentialId = Number(credentialIdRaw);
  const sessionVersion = Number(sessionVersionRaw);
  const issued = Number(issuedRaw);
  if (!Number.isInteger(credentialId) || credentialId < 1) return null;
  if (!Number.isInteger(sessionVersion) || sessionVersion < 1) return null;
  if (!Number.isInteger(issued) || !signature) return null;
  const now = Math.floor(Date.now() / 1000);
  if (issued > now + 300 || now - issued > SESSION_TTL_SECONDS) return null;
  const payload = `${credentialIdRaw}.${sessionVersionRaw}.${issuedRaw}`;
  if (!safeTokenEqual(signature, hmac(payload, authStore))) return null;
  const credential = authStore.findById(credentialId);
  if (!credential || credential.sessionVersion !== sessionVersion) return null;
  return credential;
}

function isSecureRequest(request) {
  const forwardedProto = String(request.headers["x-forwarded-proto"] || "").split(",")[0].trim();
  return request.secure || forwardedProto === "https";
}

function clearSessionCookie(response) {
  response.set("set-cookie", `${COOKIE_NAME}=; Path=/; Max-Age=0; HttpOnly; SameSite=Lax`);
}

function isLoopbackAddress(address) {
  return address === "127.0.0.1" || address === "::1" || address === "::ffff:127.0.0.1";
}

function loginClientKey(request) {
  const peer = request.socket.remoteAddress || "unknown";
  if (!isLoopbackAddress(peer)) return peer;
  const forwarded = request.headers["x-forwarded-for"];
  if (typeof forwarded !== "string") return peer;
  return forwarded.split(",")[0].trim() || peer;
}

function loginRetryAfterSeconds(clientKey, now = Date.now()) {
  const attempt = LOGIN_ATTEMPTS.get(clientKey);
  if (!attempt) return 0;
  if (attempt.resetAt <= now) {
    LOGIN_ATTEMPTS.delete(clientKey);
    return 0;
  }
  return attempt.failures >= LOGIN_MAX_FAILURES ? Math.max(1, Math.ceil((attempt.resetAt - now) / 1000)) : 0;
}

function recordFailedLogin(clientKey, now = Date.now()) {
  const attempt = LOGIN_ATTEMPTS.get(clientKey);
  if (!attempt || attempt.resetAt <= now) {
    LOGIN_ATTEMPTS.set(clientKey, { failures: 1, resetAt: now + LOGIN_WINDOW_MS });
    return;
  }
  attempt.failures += 1;
}

function login(request, response, authStore) {
  const clientKey = loginClientKey(request);
  const retryAfter = loginRetryAfterSeconds(clientKey);
  if (retryAfter) {
    response.set("Retry-After", String(retryAfter));
    response.status(429).json({ error: "Too many login attempts; try again later" });
    return;
  }
  const password = typeof request.body?.password === "string" ? request.body.password : "";
  const credential = password ? authStore.findByPassword(password) : null;
  if (!credential) {
    recordFailedLogin(clientKey);
    response.status(401).json({ error: "Invalid password" });
    return;
  }
  LOGIN_ATTEMPTS.delete(clientKey);
  const issued = String(Math.floor(Date.now() / 1000));
  const secure = isSecureRequest(request) ? " Secure;" : "";
  response
    .set(
      "set-cookie",
      `${COOKIE_NAME}=${encodeURIComponent(signSession(credential, issued, authStore))}; Path=/; Max-Age=${SESSION_TTL_SECONDS}; HttpOnly; SameSite=Lax;${secure}`
    )
    .json({ ok: true, role: credential.role });
}

function logout(request, response) {
  clearSessionCookie(response);
  response.json({ ok: true });
}

function requireAuth(authStore) {
  return (request, response, next) => {
    const credential = authenticatedCredential(request, authStore);
    if (!credential) {
      clearSessionCookie(response);
      response.status(401).json({ error: "Authentication required" });
      return;
    }
    request.authCredential = credential;
    next();
  };
}

function requireAdmin(request, response, next) {
  if (request.authCredential?.role !== ADMIN_ROLE) {
    response.status(403).json({ error: "Admin password required" });
    return;
  }
  next();
}

function recordSuccessfulQuery(request, authStore) {
  if (request.authCredential?.role !== VOUCHER_ROLE) return;
  authStore.incrementQueryCount(request.authCredential.credentialId);
}

function managedPassword(value, label) {
  if (typeof value !== "string" || !value.trim()) {
    const error = new Error(`${label} is required`);
    error.statusCode = 400;
    throw error;
  }
  const password = value.trim();
  if (password.length > 200) {
    const error = new Error(`${label} must be 200 characters or fewer`);
    error.statusCode = 400;
    throw error;
  }
  return password;
}

function credentialWriteError(error) {
  if (String(error?.code || "").startsWith("SQLITE_CONSTRAINT")) {
    const conflict = new Error("That password is already in use");
    conflict.statusCode = 409;
    return conflict;
  }
  return error;
}

function parseTime(value, field) {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`${field} is required`);
  }
  const text = value.trim();
  const parsed = Date.parse(/^\d{4}-\d{2}-\d{2}$/.test(text) ? `${text}T00:00:00Z` : text);
  if (!Number.isFinite(parsed)) {
    throw new Error(`${field} must be an ISO date or datetime`);
  }
  return Math.floor(parsed / 1000);
}

function parseNumber(value, field) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    throw new Error(`${field} must be numeric`);
  }
  return parsed;
}

function normalizeEmissionsMethodology(value) {
  const text = String(value || "").trim();
  if (!text) return COMBINED_METHODOLOGY;
  const methodology = EMISSIONS_METHODOLOGY_LABELS.get(text);
  if (methodology) return methodology.value;
  throw new Error(
    `emissionsMethodology must be one of: ${EMISSIONS_METHODOLOGIES.map((item) => item.value).join(", ")}`
  );
}

function normalizeIncludeWellToTank(value) {
  if (value === null || value === undefined || value === "") return true;
  if (typeof value === "boolean") return value;
  const text = String(value).trim().toLocaleLowerCase();
  if (["true", "1", "yes", "on"].includes(text)) return true;
  if (["false", "0", "no", "off"].includes(text)) return false;
  throw new Error("includeWellToTank must be boolean");
}

function normalizeAirportIds(value) {
  if (!Array.isArray(value)) {
    throw new Error("airportIds must be an array");
  }
  const ids = [...new Set(value.map((item) => Number(item)).filter((item) => Number.isInteger(item) && item > 0))];
  return ids;
}

function rowToAirport(row) {
  return {
    airportId: row.airport_id,
    code: row.code,
    name: row.name,
    latitude: row.lat_e7 / 1e7,
    longitude: row.lon_e7 / 1e7,
    airportType: row.airport_type,
  };
}

function rowToEvent(row) {
  const modelDisplay = resolveModelDisplay(row.manufacturer, row.model);
  return {
    eventId: row.event_id,
    icao: icaoHex(row.icao_id),
    registration: row.registration || row.n_number || null,
    aircraftModel: modelDisplay.modelName,
    aircraftType: row.aircraft_type || "unknown",
    takeoffTime: toIso(row.takeoff_ts),
    takeoffAirportId: row.takeoff_airport_id,
    takeoffAirportCode: row.takeoff_airport_code,
    takeoffAirportName: row.takeoff_airport_name,
    takeoffAirportLatitude: row.takeoff_lat_e7 === null ? null : row.takeoff_lat_e7 / 1e7,
    takeoffAirportLongitude: row.takeoff_lon_e7 === null ? null : row.takeoff_lon_e7 / 1e7,
    landingTime: toIso(row.landing_ts),
    landingAirportId: row.landing_airport_id,
    landingAirportCode: row.landing_airport_code,
    landingAirportName: row.landing_airport_name,
    landingAirportLatitude: row.landing_lat_e7 === null ? null : row.landing_lat_e7 / 1e7,
    landingAirportLongitude: row.landing_lon_e7 === null ? null : row.landing_lon_e7 / 1e7,
    operationMatches: row.operation_matches,
  };
}

function rowToEventSummary(row, emissions) {
  const modelDisplay = resolveModelDisplay(row.manufacturer, row.model);
  return {
    eventId: row.event_id,
    icao: icaoHex(row.icao_id),
    registration: row.registration || row.n_number || null,
    aircraftModel: modelDisplay.modelName,
    aircraftType: row.aircraft_type || "unknown",
    takeoffTime: toIso(row.takeoff_ts),
    takeoffAirportCode: row.takeoff_airport_code,
    landingTime: toIso(row.landing_ts),
    landingAirportCode: row.landing_airport_code,
    emissions: summarizeEmissionsForList(emissions),
  };
}

function rowToEventDetail(row, emissions) {
  return {
    ...rowToEvent(row),
    ownerName: row.owner_name || null,
    ownerCity: row.owner_city || null,
    ownerState: row.owner_state || null,
    ownerCountry: row.owner_country || null,
    ownerType: row.owner_type || null,
    yearManufactured: row.year_mfr || null,
    emissions: summarizeEmissionsForDetail(emissions),
  };
}

function compactModel(manufacturer, model) {
  return resolveModelDisplay(manufacturer, model).modelName;
}

function resolveModelDisplay(manufacturer, model) {
  const cacheKey = `${manufacturer || ""}\u0001${model || ""}`;
  if (MODEL_DISPLAY_CACHE.has(cacheKey)) return MODEL_DISPLAY_CACHE.get(cacheKey);
  const manufacturerText = String(manufacturer || "").trim();
  let modelText = String(model || "").trim();
  const normalizedManufacturer = normalizeAircraftText(manufacturerText);
  const normalizedModel = normalizeAircraftText(modelText);
  if (normalizedManufacturer && normalizedModel.startsWith(`${normalizedManufacturer} `)) {
    modelText = modelText.slice(manufacturerText.length).trim();
  }
  const parts = [manufacturerText, modelText].filter(Boolean);
  const modelName = parts.join(" ") || null;
  const display = {
    modelName,
    groupKey: normalizeAircraftText(modelName) || "UNKNOWN MODEL",
  };
  setBoundedCacheValue(MODEL_DISPLAY_CACHE, cacheKey, display);
  return display;
}

function normalizeAircraftText(value) {
  return String(value || "")
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, " ")
    .trim()
    .replace(/\s+/g, " ");
}

function parseCsvRows(text) {
  const [headerLine, ...lines] = String(text || "").trim().split(/\r?\n/);
  const headers = headerLine.split(",");
  return lines
    .filter(Boolean)
    .map((line) => {
      const values = line.split(",");
      return Object.fromEntries(headers.map((header, index) => [header, values[index] ?? ""]));
    });
}

function numericCsvValue(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function loadEurocontrolCurves(filename) {
  if (!filename || !fs.existsSync(filename)) return new Map();
  const rows = parseCsvRows(fs.readFileSync(filename, "utf8"));
  return new Map(
    rows
      .filter((row) => row.ICAO_TYPE_CODE)
      .map((row) => {
        const rowCo2Coefficient = numericCsvValue(row.CO2_COEFF);
        return [
          row.ICAO_TYPE_CODE,
          {
            aircraftIcaoCode: row.ICAO_TYPE_CODE,
            co2Coefficient:
              rowCo2Coefficient !== null && rowCo2Coefficient >= 3.15
                ? EUROCONTROL_JET_TURBOPROP_CO2_COEFF
                : rowCo2Coefficient,
            correctionFactor: numericCsvValue(row.CORR_FACTOR) ?? 1,
            breakpointsNm: [numericCsvValue(row.BreakPoint_1), numericCsvValue(row.BreakPoint_2)],
            slopesKgPerNm: [numericCsvValue(row.Slope_1), numericCsvValue(row.Slope_2), numericCsvValue(row.Slope_3)],
            interceptsKg: [numericCsvValue(row.Intercept_1), numericCsvValue(row.Intercept_2), numericCsvValue(row.Intercept_3)],
          },
        ];
      })
  );
}

// Registry designators that lack a SET curve but are variants of a type that
// has one, and are close enough to share it.
const EUROCONTROL_REGISTRY_TYPE_ALIASES = new Map([
  ["E45X", "E145"], // EMB-145XR: same fuselage as the EMB-145, extended range
]);
// Registry designators the registries themselves get wrong often enough that a
// model-text pattern match should win when the two disagree. G200: some
// registries tag Gulfstream G200s with the Giles G-200 kit plane's designator.
const EUROCONTROL_DISTRUSTED_REGISTRY_TYPES = new Set(["G200"]);

const EUROCONTROL_REGISTRY_BASIS = "registry ICAO type designator";
const EUROCONTROL_PATTERN_BASIS = "model text pattern";

function resolveEurocontrolIcaoCode(row) {
  const registryType = typeof row.icao_type === "string" ? row.icao_type.trim().toUpperCase() : "";
  const cacheKey = `${registryType}\u0001${row.manufacturer || ""}\u0001${row.model || ""}`;
  if (EUROCONTROL_ICAO_CACHE.has(cacheKey)) return EUROCONTROL_ICAO_CACHE.get(cacheKey);
  const text = normalizeAircraftText([row.manufacturer, row.model].filter(Boolean).join(" "));
  const match = text ? EUROCONTROL_AIRCRAFT_CODE_PATTERNS.find(([pattern]) => pattern.test(text)) : null;
  const patternCode = match?.[1] || null;
  let resolved = null;
  if (registryType) {
    const registryCode = EUROCONTROL_REGISTRY_TYPE_ALIASES.get(registryType) || registryType;
    if (EUROCONTROL_DISTRUSTED_REGISTRY_TYPES.has(registryCode) && patternCode && patternCode !== registryCode) {
      resolved = { code: patternCode, basis: EUROCONTROL_PATTERN_BASIS };
    } else {
      resolved = { code: registryCode, basis: EUROCONTROL_REGISTRY_BASIS };
    }
  } else if (patternCode) {
    resolved = { code: patternCode, basis: EUROCONTROL_PATTERN_BASIS };
  }
  setBoundedCacheValue(EUROCONTROL_ICAO_CACHE, cacheKey, resolved);
  return resolved;
}

function eurocontrolCurveForRow(row) {
  const resolved = resolveEurocontrolIcaoCode(row);
  const aircraftIcaoCode = resolved?.code || null;
  return {
    aircraftIcaoCode,
    aircraftIcaoCodeBasis: resolved?.basis || null,
    curve: aircraftIcaoCode ? EUROCONTROL_CURVES.get(aircraftIcaoCode) || null : null,
  };
}

function compileProfileAlias(entry) {
  const value = typeof entry === "string" ? entry : entry.value;
  const normalizedAlias = normalizeAircraftText(value);
  const normalizedManufacturers =
    typeof entry === "object" && entry.manufacturers?.length
      ? entry.manufacturers.map(normalizeAircraftText).filter(Boolean)
      : [];
  return {
    value,
    normalizedAlias,
    normalizedManufacturers,
    includeManufacturer: Boolean(typeof entry === "object" && entry.includeManufacturer),
  };
}

function compileAircraftProfile(profile) {
  return {
    ...profile,
    normalizedMatchAliases: (profile.matchAliases || []).map(compileProfileAlias).filter((entry) => entry.normalizedAlias),
  };
}

function roundNumber(value, decimals = 2) {
  if (!Number.isFinite(value)) return value;
  const factor = 10 ** decimals;
  return Math.round(value * factor) / factor;
}

function setBoundedCacheValue(cache, key, value) {
  if (!cache || EMISSIONS_CACHE_MAX <= 0) return;
  if (!cache.has(key) && cache.size >= EMISSIONS_CACHE_MAX) {
    cache.delete(cache.keys().next().value);
  }
  cache.set(key, value);
}

function hasWholeNormalizedAlias(text, normalizedAlias) {
  if (!text || !normalizedAlias) return false;
  return ` ${text} `.includes(` ${normalizedAlias} `);
}

function hasWholeAlias(text, alias) {
  return hasWholeNormalizedAlias(text, normalizeAircraftText(alias));
}

function profileAliasMatchScore(row, entry, texts) {
  const compiledEntry = entry.normalizedAlias ? entry : compileProfileAlias(entry);
  const normalizedAlias = compiledEntry.normalizedAlias;
  if (!normalizedAlias) return 0;
  if (compiledEntry.normalizedManufacturers?.length) {
    const hasManufacturer = compiledEntry.normalizedManufacturers.some((manufacturer) => {
      return hasWholeNormalizedAlias(texts.manufacturer, manufacturer) || hasWholeNormalizedAlias(texts.combined, manufacturer);
    });
    if (!hasManufacturer) return 0;
  }
  const targetText = compiledEntry.includeManufacturer ? texts.combined : texts.model;
  return hasWholeNormalizedAlias(targetText, normalizedAlias) ? normalizedAlias.length : 0;
}

function profileAliasMatches(row, entry, texts) {
  return profileAliasMatchScore(row, entry, texts) > 0;
}

function aircraftProfileMatchScore(row, profile) {
  const texts = {
    manufacturer: normalizeAircraftText(row.manufacturer),
    model: normalizeAircraftText(row.model),
  };
  texts.combined = [texts.manufacturer, texts.model].filter(Boolean).join(" ");
  const aliases = profile.normalizedMatchAliases || profile.matchAliases || [];
  return Math.max(0, ...aliases.map((entry) => profileAliasMatchScore(row, entry, texts)));
}

function aircraftProfileMatches(row, profile) {
  return aircraftProfileMatchScore(row, profile) > 0;
}

function businessJetFallbackExcluded(row) {
  const text = normalizeAircraftText([row.manufacturer, row.model].filter(Boolean).join(" "));
  if (!text) return true;
  return BUSINESS_JET_FALLBACK_EXCLUSIONS.some((pattern) => pattern.test(text));
}

function haversineNm(startLat, startLon, endLat, endLon) {
  const startLatRad = (startLat * Math.PI) / 180;
  const startLonRad = (startLon * Math.PI) / 180;
  const endLatRad = (endLat * Math.PI) / 180;
  const endLonRad = (endLon * Math.PI) / 180;
  const deltaLat = endLatRad - startLatRad;
  const deltaLon = endLonRad - startLonRad;
  const haversineTerm =
    Math.sin(deltaLat / 2) ** 2 + Math.cos(startLatRad) * Math.cos(endLatRad) * Math.sin(deltaLon / 2) ** 2;
  const centralAngle = 2 * Math.asin(Math.sqrt(haversineTerm));
  return EARTH_RADIUS_NM * centralAngle;
}

function haversineKm(startLat, startLon, endLat, endLon) {
  const startLatRad = (startLat * Math.PI) / 180;
  const startLonRad = (startLon * Math.PI) / 180;
  const endLatRad = (endLat * Math.PI) / 180;
  const endLonRad = (endLon * Math.PI) / 180;
  const deltaLat = endLatRad - startLatRad;
  const deltaLon = endLonRad - startLonRad;
  const haversineTerm =
    Math.sin(deltaLat / 2) ** 2 + Math.cos(startLatRad) * Math.cos(endLatRad) * Math.sin(deltaLon / 2) ** 2;
  const centralAngle = 2 * Math.asin(Math.sqrt(haversineTerm));
  return EARTH_RADIUS_KM * centralAngle;
}

function routeDistanceCacheKey(row) {
  return `${row.takeoff_airport_id}\u0001${row.landing_airport_id}`;
}

function emissionEstimateCacheKey(profile, routeCacheKey, includeWellToTank, detail) {
  return `${profile.key}\u0001${includeWellToTank ? "wtt" : "ttw"}\u0001${detail ? "detail" : "list"}\u0001${routeCacheKey}`;
}

function eurocontrolEstimateCacheKey(methodology, aircraftIcaoCode, profileKey, routeCacheKey, includeWellToTank, detail) {
  return `${methodology}\u0001${aircraftIcaoCode || ""}\u0001${profileKey || ""}\u0001${
    includeWellToTank ? "wtt" : "ttw"
  }\u0001${detail ? "detail" : "list"}\u0001${routeCacheKey}`;
}

function aircraftProfileCacheKey(row) {
  return `${row.aircraft_type || ""}\u0001${row.manufacturer || ""}\u0001${row.model || ""}`;
}

function selectAircraftProfile(row, cache = null) {
  const cacheKey = cache ? aircraftProfileCacheKey(row) : null;
  if (cache && cache.has(cacheKey)) return cache.get(cacheKey);

  let selectedProfile = null;
  if (ESTIMABLE_AIRCRAFT_TYPES.has(row.aircraft_type)) {
    const candidateProfiles =
      row.aircraft_type === "turboprop" || row.aircraft_type === "commercial_turboprop"
        ? TURBOPROP_PROFILES
        : COMPILED_AIRCRAFT_PROFILES;
    let exactProfile = null;
    let bestScore = 0;
    for (const profile of candidateProfiles) {
      const score = aircraftProfileMatchScore(row, profile);
      if (score > bestScore) {
        exactProfile = profile;
        bestScore = score;
      }
    }
    if (exactProfile) {
      selectedProfile = { ...exactProfile, source: "model_match" };
    } else if (row.aircraft_type === "business_jet" && BUSINESS_JET_FALLBACK_PROFILE && !businessJetFallbackExcluded(row)) {
      selectedProfile = {
        ...BUSINESS_JET_FALLBACK_PROFILE,
        key: "generic_business_jet_cj4",
        name: "Generic business jet (CJ4 assumptions)",
        source: "business_jet_fallback",
      };
    }
  }

  setBoundedCacheValue(cache, cacheKey, selectedProfile);
  return selectedProfile;
}

// ATIM is not offered as a model of its own: the Combined Model uses its
// profile-based estimate when an aircraft has no usable EUROCONTROL curve.
function estimateAdaptedTimEmissions(row, options = {}) {
  const includeWellToTank = options.includeWellToTank !== false;
  const detail = options.detail === true;
  const profile = selectAircraftProfile(row, options.profileCache || null);
  if (!profile) return null;

  const routeCacheKey = routeDistanceCacheKey(row);
  const estimateCache = options.estimateCache || null;
  const estimateCacheKey = estimateCache ? emissionEstimateCacheKey(profile, routeCacheKey, includeWellToTank, detail) : null;
  if (estimateCache && estimateCache.has(estimateCacheKey)) return estimateCache.get(estimateCacheKey);

  const startLat = row.takeoff_lat_e7 / 1e7;
  const startLon = row.takeoff_lon_e7 / 1e7;
  const endLat = row.landing_lat_e7 / 1e7;
  const endLon = row.landing_lon_e7 / 1e7;
  if (
    !Number.isFinite(startLat) ||
    !Number.isFinite(startLon) ||
    !Number.isFinite(endLat) ||
    !Number.isFinite(endLon)
  ) {
    return null;
  }

  const routeCache = options.routeCache || null;
  let routeDistance = routeCache?.get(routeCacheKey);
  if (!routeDistance) {
    const greatCircleNm = haversineNm(startLat, startLon, endLat, endLon);
    const adjustedDistanceNm = greatCircleNm * LATERAL_INEFFICIENCY_FACTOR;
    routeDistance = {
      greatCircleNm,
      adjustedDistanceNm,
      routeExtraNm: adjustedDistanceNm - greatCircleNm,
    };
    setBoundedCacheValue(routeCache, routeCacheKey, routeDistance);
  }
  const { greatCircleNm, adjustedDistanceNm, routeExtraNm } = routeDistance;
  const flightTimeHours = adjustedDistanceNm / profile.speedKts;
  const ltoGallons = 0.1 * profile.burnGph;
  const cruiseFuelGallons = flightTimeHours * profile.burnGph;
  const totalFuelGallons = cruiseFuelGallons + ltoGallons;
  const totalFuelKg = totalFuelGallons * JET_A_KG_PER_GALLON;
  const tankToWakeCo2eKg = totalFuelKg * TANK_TO_WAKE_CO2E_KG_PER_KG_FUEL;
  const wellToTankCo2eKg = totalFuelKg * WELL_TO_TANK_CO2E_KG_PER_KG_FUEL;
  const totalWithoutWellToTankCo2eKg = tankToWakeCo2eKg;
  const totalWithWellToTankCo2eKg = tankToWakeCo2eKg + wellToTankCo2eKg;
  const totalCo2eKg = includeWellToTank ? totalWithWellToTankCo2eKg : totalWithoutWellToTankCo2eKg;

  const baseEstimate = {
    includeWellToTank,
    profileKey: profile.key,
    profile: profile.name,
    profileSource: profile.source,
    burnGph: profile.burnGph,
    fuelSource: profile.fuelSource,
    fuelSourceDomain: sourceDomain(profile.fuelSource),
    flightTimeHours,
    totalFuelGallons,
    tankToWakeCo2eKg: roundNumber(tankToWakeCo2eKg),
    wellToTankCo2eKg: roundNumber(wellToTankCo2eKg),
    totalWithoutWellToTankCo2eKg: roundNumber(totalWithoutWellToTankCo2eKg),
    totalWithWellToTankCo2eKg: roundNumber(totalWithWellToTankCo2eKg),
    totalCo2eKg: roundNumber(totalCo2eKg),
  };
  const estimate = detail
    ? {
        ...baseEstimate,
        speedKts: profile.speedKts,
        speedSource: profile.speedSource,
        greatCircleNm,
        adjustedDistanceNm,
        routeExtraNm,
        ltoGallons,
        cruiseFuelGallons,
        totalFuelKg,
        jetAKgPerGallon: JET_A_KG_PER_GALLON,
        lateralInefficiencyFactor: LATERAL_INEFFICIENCY_FACTOR,
        tankToWakeFactor: TANK_TO_WAKE_CO2E_KG_PER_KG_FUEL,
        wellToTankFactor: WELL_TO_TANK_CO2E_KG_PER_KG_FUEL,
      }
    : baseEstimate;
  setBoundedCacheValue(estimateCache, estimateCacheKey, estimate);
  return estimate;
}

function routeCoordinatesForRow(row) {
  const startLat = row.takeoff_lat_e7 / 1e7;
  const startLon = row.takeoff_lon_e7 / 1e7;
  const endLat = row.landing_lat_e7 / 1e7;
  const endLon = row.landing_lon_e7 / 1e7;
  if (
    !Number.isFinite(startLat) ||
    !Number.isFinite(startLon) ||
    !Number.isFinite(endLat) ||
    !Number.isFinite(endLon)
  ) {
    return null;
  }
  return { startLat, startLon, endLat, endLon };
}

function eurocontrolRouteDistance(row, routeCache = null) {
  const routeCacheKey = routeDistanceCacheKey(row);
  let routeDistance = routeCache?.get(routeCacheKey);
  if (routeDistance) return routeDistance;
  const coordinates = routeCoordinatesForRow(row);
  if (!coordinates) return null;
  const greatCircleKm = haversineKm(coordinates.startLat, coordinates.startLon, coordinates.endLat, coordinates.endLon);
  const greatCircleNm = greatCircleKm / KM_PER_NM;
  const correctedDistanceKm = greatCircleKm + EUROCONTROL_GCD_CORRECTION_KM;
  const correctedDistanceNm = correctedDistanceKm / KM_PER_NM;
  routeDistance = {
    greatCircleKm,
    greatCircleNm,
    correctedDistanceKm,
    correctedDistanceNm,
    gcdCorrectionKm: EUROCONTROL_GCD_CORRECTION_KM,
    gcdCorrectionNm: EUROCONTROL_GCD_CORRECTION_KM / KM_PER_NM,
  };
  setBoundedCacheValue(routeCache, routeCacheKey, routeDistance);
  return routeDistance;
}

function interpolateEurocontrolFuelKg(curve, distanceNm) {
  const breakPoint1 = curve.breakpointsNm[0];
  const breakPoint2 = Number.isFinite(curve.breakpointsNm[1]) ? curve.breakpointsNm[1] : EUROCONTROL_MAX_DISTANCE_NM;
  const xp = [0, breakPoint1, breakPoint2, EUROCONTROL_MAX_DISTANCE_NM];
  const yp = [
    curve.interceptsKg[0],
    curve.interceptsKg[0] + curve.slopesKgPerNm[0] * breakPoint1,
    Number.isFinite(curve.interceptsKg[1]) && Number.isFinite(curve.slopesKgPerNm[1])
      ? curve.interceptsKg[1] + curve.slopesKgPerNm[1] * breakPoint2
      : null,
    Number.isFinite(curve.interceptsKg[2]) && Number.isFinite(curve.slopesKgPerNm[2])
      ? curve.interceptsKg[2] + curve.slopesKgPerNm[2] * EUROCONTROL_MAX_DISTANCE_NM
      : null,
  ];
  const firstMissing = xp.findIndex((value, index) => !Number.isFinite(value) || !Number.isFinite(yp[index]));
  const usableXp = firstMissing === -1 ? xp : xp.slice(0, Math.max(2, firstMissing));
  const usableYp = firstMissing === -1 ? yp : yp.slice(0, Math.max(2, firstMissing));
  const i = usableXp.findIndex((value) => value > distanceNm);
  const upperIndex = i === -1 ? usableXp.length - 1 : Math.min(Math.max(i, 1), usableXp.length - 1);
  const lowerIndex = Math.max(upperIndex - 1, 0);
  const lowerX = usableXp[lowerIndex];
  const upperX = usableXp[upperIndex];
  const lowerY = usableYp[lowerIndex];
  const upperY = usableYp[upperIndex];
  const rawFuelKg = (distanceNm - lowerX) * ((upperY - lowerY) / (upperX - lowerX)) + lowerY;
  return {
    rawFuelKg,
    fuelKg: rawFuelKg * curve.correctionFactor,
    segmentIndex: upperIndex,
    segmentLabel: `Segment ${upperIndex}`,
    segmentStartNm: lowerX,
    segmentEndNm: upperX,
    segmentStartFuelKg: lowerY,
    segmentEndFuelKg: upperY,
    segmentSlopeKgPerNm: (upperY - lowerY) / (upperX - lowerX),
  };
}

function estimateEurocontrolFastEmissions(row, options = {}) {
  const detail = options.detail === true;
  const routeCache = options.routeCache || null;
  const estimateCache = options.estimateCache || null;
  const { aircraftIcaoCode, aircraftIcaoCodeBasis, curve } = eurocontrolCurveForRow(row);
  const routeCacheKey = routeDistanceCacheKey(row);
  const estimateCacheKey = estimateCache
    ? eurocontrolEstimateCacheKey(EUROCONTROL_FAST_METHODOLOGY, aircraftIcaoCode, null, routeCacheKey, false, detail)
    : null;
  if (estimateCache && estimateCache.has(estimateCacheKey)) return estimateCache.get(estimateCacheKey);
  const base = {
    methodology: EUROCONTROL_FAST_METHODOLOGY,
    label: EUROCONTROL_FAST_LABEL,
    scope: "whole_flight",
    scopeLabel: "Whole flight",
    gasBasis: "CO2 from fuel burn",
    aircraftIcaoCode,
  };
  if (!aircraftIcaoCode) {
    const estimate = { ...base, totalCo2eKg: null, unsupportedReason: "aircraft_not_supported" };
    setBoundedCacheValue(estimateCache, estimateCacheKey, estimate);
    return estimate;
  }
  if (!curve) {
    const estimate = { ...base, totalCo2eKg: null, unsupportedReason: "aircraft_not_in_method_dataset" };
    setBoundedCacheValue(estimateCache, estimateCacheKey, estimate);
    return estimate;
  }
  const routeDistance = eurocontrolRouteDistance(row, routeCache);
  if (!routeDistance) {
    const estimate = { ...base, totalCo2eKg: null, unsupportedReason: "missing_route_coordinates" };
    setBoundedCacheValue(estimateCache, estimateCacheKey, estimate);
    return estimate;
  }
  const interpolation = interpolateEurocontrolFuelKg(curve, routeDistance.correctedDistanceNm);
  const tankToWakeCo2eKg = interpolation.fuelKg * curve.co2Coefficient;
  const estimate = {
    ...base,
    totalCo2eKg: roundNumber(tankToWakeCo2eKg),
    totalWithoutWellToTankCo2eKg: roundNumber(tankToWakeCo2eKg),
    totalWithWellToTankCo2eKg: roundNumber(tankToWakeCo2eKg),
    tankToWakeCo2eKg: null,
    wellToTankCo2eKg: null,
    totalFuelKg: roundNumber(interpolation.fuelKg),
    eurocontrolCurveSource: "SET 2025",
    eurocontrolCurveBasis: aircraftIcaoCodeBasis,
    calculationSource: "eurocontrol_curve",
    ...(detail
      ? {
          ...routeDistance,
          co2Coefficient: curve.co2Coefficient,
          correctionFactor: curve.correctionFactor,
          breakpointsNm: curve.breakpointsNm.filter(Number.isFinite),
          slopesKgPerNm: curve.slopesKgPerNm.filter(Number.isFinite),
          interceptsKg: curve.interceptsKg.filter(Number.isFinite),
          rawFuelKg: interpolation.rawFuelKg,
          fuelKg: interpolation.fuelKg,
          curveSegment: interpolation.segmentLabel,
          segmentStartNm: interpolation.segmentStartNm,
          segmentEndNm: interpolation.segmentEndNm,
          segmentStartFuelKg: interpolation.segmentStartFuelKg,
          segmentEndFuelKg: interpolation.segmentEndFuelKg,
          segmentSlopeKgPerNm: interpolation.segmentSlopeKgPerNm,
        }
      : {}),
  };
  setBoundedCacheValue(estimateCache, estimateCacheKey, estimate);
  return estimate;
}

function atimDerivedCurveEstimate(row, atimEstimate, routeDistance, options = {}) {
  if (!atimEstimate || !routeDistance) return null;
  const detail = options.detail === true;
  const burnGph = atimEstimate.burnGph;
  const speedKts = atimEstimate.speedKts || null;
  if (!Number.isFinite(burnGph) || !Number.isFinite(speedKts) || speedKts <= 0) return null;
  const ltoFuelKg = 0.1 * burnGph * JET_A_KG_PER_GALLON;
  const slopeKgPerNm = (burnGph * JET_A_KG_PER_GALLON) / speedKts;
  const adjustedDistanceNm = routeDistance.greatCircleNm * LATERAL_INEFFICIENCY_FACTOR;
  const fuelKg = ltoFuelKg + adjustedDistanceNm * slopeKgPerNm;
  const tankToWakeCo2eKg = fuelKg * TANK_TO_WAKE_CO2E_KG_PER_KG_FUEL;
  const wellToTankCo2eKg = fuelKg * WELL_TO_TANK_CO2E_KG_PER_KG_FUEL;
  const includeWellToTank = options.includeWellToTank !== false;
  return {
    profile: atimEstimate.profile,
    profileKey: atimEstimate.profileKey,
    profileSource: atimEstimate.profileSource,
    fuelSource: atimEstimate.fuelSource,
    fuelSourceDomain: sourceDomain(atimEstimate.fuelSource),
    speedSource: atimEstimate.speedSource,
    burnGph,
    speedKts,
    totalFuelKg: roundNumber(fuelKg),
    tankToWakeCo2eKg: roundNumber(tankToWakeCo2eKg),
    wellToTankCo2eKg: roundNumber(wellToTankCo2eKg),
    totalWithoutWellToTankCo2eKg: roundNumber(tankToWakeCo2eKg),
    totalWithWellToTankCo2eKg: roundNumber(tankToWakeCo2eKg + wellToTankCo2eKg),
    totalCo2eKg: roundNumber(includeWellToTank ? tankToWakeCo2eKg + wellToTankCo2eKg : tankToWakeCo2eKg),
    calculationSource: "atim_derived_curve",
    eurocontrolCurveBasis: "ATIM profile fallback",
    ...(detail
      ? {
          adjustedDistanceNm,
          ltoFuelKg,
          curveSegment: "ATIM one-segment fallback",
          segmentStartNm: 0,
          segmentEndNm: EUROCONTROL_MAX_DISTANCE_NM,
          segmentStartFuelKg: ltoFuelKg,
          segmentEndFuelKg: ltoFuelKg + EUROCONTROL_MAX_DISTANCE_NM * slopeKgPerNm,
          segmentSlopeKgPerNm: slopeKgPerNm,
        }
      : {}),
  };
}

function estimateCombinedEmissions(row, options = {}) {
  const includeWellToTank = options.includeWellToTank !== false;
  const detail = options.detail === true;
  const routeCache = options.routeCache || null;
  const estimateCache = options.estimateCache || null;
  const profileCache = options.profileCache || null;
  const atimEstimateCache = options.atimEstimateCache || null;
  const { aircraftIcaoCode, aircraftIcaoCodeBasis, curve } = eurocontrolCurveForRow(row);
  const routeCacheKey = routeDistanceCacheKey(row);
  const atimProfile = selectAircraftProfile(row, profileCache);
  const estimateCacheKey = estimateCache
    ? eurocontrolEstimateCacheKey(COMBINED_METHODOLOGY, aircraftIcaoCode, atimProfile?.key, routeCacheKey, includeWellToTank, detail)
    : null;
  if (estimateCache && estimateCache.has(estimateCacheKey)) return estimateCache.get(estimateCacheKey);
  const routeDistance = eurocontrolRouteDistance(row, routeCache);
  const atimEstimate = estimateAdaptedTimEmissions(row, {
    includeWellToTank,
    profileCache,
    routeCache: ADAPTED_TIM_ROUTE_CACHE,
    estimateCache: atimEstimateCache,
    detail: true,
  });
  const useEurocontrolCurve = curve && !EUROCONTROL_SUSPICIOUS_ICAO_CODES.has(aircraftIcaoCode);
  const base = {
    methodology: COMBINED_METHODOLOGY,
    label: COMBINED_LABEL,
    includeWellToTank,
    scope: "whole_flight",
    scopeLabel: "Whole flight",
    aircraftIcaoCode,
  };
  let estimate = null;
  if (useEurocontrolCurve && routeDistance) {
    const interpolation = interpolateEurocontrolFuelKg(curve, routeDistance.correctedDistanceNm);
    const tankToWakeCo2eKg = interpolation.fuelKg * curve.co2Coefficient;
    const wellToTankCo2eKg = interpolation.fuelKg * WELL_TO_TANK_CO2E_KG_PER_KG_FUEL;
    estimate = {
      ...base,
      gasBasis: includeWellToTank ? "CO2 from fuel burn plus Jet A well-to-tank factor" : "CO2 from fuel burn",
      totalCo2eKg: roundNumber(includeWellToTank ? tankToWakeCo2eKg + wellToTankCo2eKg : tankToWakeCo2eKg),
      tankToWakeCo2eKg: roundNumber(tankToWakeCo2eKg),
      wellToTankCo2eKg: roundNumber(wellToTankCo2eKg),
      totalWithoutWellToTankCo2eKg: roundNumber(tankToWakeCo2eKg),
      totalWithWellToTankCo2eKg: roundNumber(tankToWakeCo2eKg + wellToTankCo2eKg),
      totalFuelKg: roundNumber(interpolation.fuelKg),
      eurocontrolCurveSource: "SET 2025",
      eurocontrolCurveBasis: aircraftIcaoCodeBasis,
      calculationSource: "eurocontrol_curve",
      profile: atimEstimate?.profile || null,
      profileSource: atimEstimate?.profileSource || null,
      burnGph: atimEstimate?.burnGph || null,
      ...(detail
        ? {
            ...routeDistance,
            co2Coefficient: curve.co2Coefficient,
            wellToTankFactor: WELL_TO_TANK_CO2E_KG_PER_KG_FUEL,
            correctionFactor: curve.correctionFactor,
            breakpointsNm: curve.breakpointsNm.filter(Number.isFinite),
            slopesKgPerNm: curve.slopesKgPerNm.filter(Number.isFinite),
            interceptsKg: curve.interceptsKg.filter(Number.isFinite),
            rawFuelKg: interpolation.rawFuelKg,
            fuelKg: interpolation.fuelKg,
            curveSegment: interpolation.segmentLabel,
            segmentStartNm: interpolation.segmentStartNm,
            segmentEndNm: interpolation.segmentEndNm,
            segmentStartFuelKg: interpolation.segmentStartFuelKg,
            segmentEndFuelKg: interpolation.segmentEndFuelKg,
            segmentSlopeKgPerNm: interpolation.segmentSlopeKgPerNm,
          }
        : {}),
    };
  } else {
    const fallback = atimDerivedCurveEstimate(row, atimEstimate, routeDistance, { includeWellToTank, detail });
    if (fallback) {
      const fallbackReason = curve
        ? `suspicious_eurocontrol_curve_${aircraftIcaoCode}`
        : aircraftIcaoCode
          ? "eurocontrol_curve_missing"
          : "aircraft_not_supported_by_eurocontrol";
      estimate = {
        ...base,
        ...fallback,
        gasBasis: includeWellToTank ? "ATIM fuel burn plus Jet A well-to-tank factor" : "ATIM fuel burn",
        aircraftIcaoCode,
        fallbackReason,
      };
    }
  }
  if (!estimate) {
    estimate = {
      ...base,
      totalCo2eKg: null,
      unsupportedReason: "combined_inputs_unavailable",
    };
  }
  setBoundedCacheValue(estimateCache, estimateCacheKey, estimate);
  return estimate;
}

function emissionsMethodologyMeta(methodology) {
  return EMISSIONS_METHODOLOGY_LABELS.get(methodology) || { value: methodology, label: methodology };
}

function isCombinedMethodology(methodology) {
  return methodology === COMBINED_METHODOLOGY;
}

function summarizeEmissionsForList(emissions) {
  if (!emissions) return null;
  if (isCombinedMethodology(emissions.methodology)) {
    return {
      profile: emissions.profile,
      profileSource: emissions.profileSource,
      aircraftIcaoCode: emissions.aircraftIcaoCode,
      totalCo2eKg: roundNumber(emissions.totalCo2eKg),
      tankToWakeCo2eKg: roundNumber(emissions.tankToWakeCo2eKg),
      wellToTankCo2eKg: roundNumber(emissions.wellToTankCo2eKg),
      calculationSource: emissions.calculationSource,
      fallbackReason: emissions.fallbackReason,
      scope: emissions.scope,
      scopeLabel: emissions.scopeLabel,
      gasBasis: emissions.gasBasis,
    };
  }
  return {
    aircraftIcaoCode: emissions.aircraftIcaoCode,
    totalCo2eKg: roundNumber(emissions.totalCo2eKg),
    scope: emissions.scope,
    scopeLabel: emissions.scopeLabel,
    gasBasis: emissions.gasBasis,
    calculationSource: emissions.calculationSource,
    unsupportedReason: emissions.unsupportedReason,
  };
}

function summarizeEmissionsForDetail(emissions) {
  if (!emissions) return null;
  const { methodology, includeWellToTank, label, ...rest } = emissions;
  for (const [key, value] of Object.entries(rest)) {
    if (key.endsWith("Co2eKg")) rest[key] = roundNumber(value);
  }
  return rest;
}

function sourceDomain(source) {
  if (!source?.url) return null;
  try {
    return new URL(source.url).hostname.replace(/^www\./, "");
  } catch {
    return null;
  }
}

function buildModelGroups(rows, estimates, emissionsSummary) {
  const groups = new Map();
  for (let index = 0; index < rows.length; index += 1) {
    const row = rows[index];
    const emissions = estimates[index] || null;
    const modelDisplay = resolveModelDisplay(row.manufacturer, row.model);
    const modelName = modelDisplay.modelName || "Unknown model";
    const key = modelDisplay.groupKey;
    const current =
      groups.get(key) ||
      {
        modelName,
        totalCo2eKg: 0,
        tankToWakeCo2eKg: 0,
        wellToTankCo2eKg: 0,
        totalWithoutWellToTankCo2eKg: 0,
        totalWithWellToTankCo2eKg: 0,
        eventCount: 0,
        estimatedEventCount: 0,
        eurocontrolCurveCount: 0,
        atimDerivedCurveCount: 0,
        fallbackReasonCounts: {},
      };
    current.eventCount += 1;
    if (emissions && Number.isFinite(emissions.totalCo2eKg)) {
      current.totalCo2eKg += emissions.totalCo2eKg;
      current.estimatedEventCount += 1;
    }
    if (Number.isFinite(emissions?.tankToWakeCo2eKg)) current.tankToWakeCo2eKg += emissions.tankToWakeCo2eKg;
    if (Number.isFinite(emissions?.wellToTankCo2eKg)) current.wellToTankCo2eKg += emissions.wellToTankCo2eKg;
    if (Number.isFinite(emissions?.totalWithoutWellToTankCo2eKg)) {
      current.totalWithoutWellToTankCo2eKg += emissions.totalWithoutWellToTankCo2eKg;
    }
    if (Number.isFinite(emissions?.totalWithWellToTankCo2eKg)) {
      current.totalWithWellToTankCo2eKg += emissions.totalWithWellToTankCo2eKg;
    }
    if (emissions?.calculationSource === "eurocontrol_curve") {
      current.eurocontrolCurveCount += 1;
    } else if (emissions?.calculationSource === "atim_derived_curve") {
      current.atimDerivedCurveCount += 1;
    }
    if (emissions?.fallbackReason) {
      current.fallbackReasonCounts[emissions.fallbackReason] = (current.fallbackReasonCounts[emissions.fallbackReason] || 0) + 1;
    }
    groups.set(key, current);
  }

  return [...groups.values()].map((group) => {
    const base = {
      modelName: group.modelName,
      eventCount: group.eventCount,
      estimatedEventCount: group.estimatedEventCount,
      totalCo2eKg: group.estimatedEventCount ? roundNumber(group.totalCo2eKg) : null,
      methodology: emissionsSummary.methodology,
    };
    if (!isCombinedMethodology(emissionsSummary.methodology)) {
      return {
        ...base,
        eurocontrolCurveCount: group.eurocontrolCurveCount || undefined,
        atimDerivedCurveCount: group.atimDerivedCurveCount || undefined,
        fallbackReasonCounts: Object.keys(group.fallbackReasonCounts).length ? group.fallbackReasonCounts : undefined,
      };
    }
    return {
      ...base,
      tankToWakeCo2eKg: group.estimatedEventCount ? roundNumber(group.tankToWakeCo2eKg) : null,
      wellToTankCo2eKg: group.estimatedEventCount ? roundNumber(group.wellToTankCo2eKg) : null,
      totalWithoutWellToTankCo2eKg: group.estimatedEventCount ? roundNumber(group.totalWithoutWellToTankCo2eKg) : null,
      totalWithWellToTankCo2eKg: group.estimatedEventCount ? roundNumber(group.totalWithWellToTankCo2eKg) : null,
      eurocontrolCurveCount: group.eurocontrolCurveCount || undefined,
      atimDerivedCurveCount: group.atimDerivedCurveCount || undefined,
      fallbackReasonCounts: Object.keys(group.fallbackReasonCounts).length ? group.fallbackReasonCounts : undefined,
    };
  });
}

function summarizeEmissionsForEstimates(rows, estimates, methodology, includeWellToTank) {
  if (methodology === "none") {
    return {
      methodology,
      label: "None",
      includeWellToTank,
      tankToWakeCo2eKg: null,
      wellToTankCo2eKg: null,
      totalWithoutWellToTankCo2eKg: null,
      totalWithWellToTankCo2eKg: null,
      totalCo2eKg: null,
      estimatedEventCount: 0,
      missingEventCount: rows.length,
    };
  }

  const meta = emissionsMethodologyMeta(methodology);
  let totalCo2eKg = 0;
  let tankToWakeCo2eKg = 0;
  let wellToTankCo2eKg = 0;
  let totalWithoutWellToTankCo2eKg = 0;
  let totalWithWellToTankCo2eKg = 0;
  let estimatedEventCount = 0;
  const unsupportedReasonCounts = {};
  const fallbackReasonCounts = {};
  const calculationSourceCounts = {};
  for (const estimate of estimates) {
    if (estimate && Number.isFinite(estimate.totalCo2eKg)) {
      totalCo2eKg += estimate.totalCo2eKg;
      if (Number.isFinite(estimate.tankToWakeCo2eKg)) tankToWakeCo2eKg += estimate.tankToWakeCo2eKg;
      if (Number.isFinite(estimate.wellToTankCo2eKg)) wellToTankCo2eKg += estimate.wellToTankCo2eKg;
      if (Number.isFinite(estimate.totalWithoutWellToTankCo2eKg)) {
        totalWithoutWellToTankCo2eKg += estimate.totalWithoutWellToTankCo2eKg;
      } else {
        totalWithoutWellToTankCo2eKg += estimate.totalCo2eKg;
      }
      if (Number.isFinite(estimate.totalWithWellToTankCo2eKg)) {
        totalWithWellToTankCo2eKg += estimate.totalWithWellToTankCo2eKg;
      } else {
        totalWithWellToTankCo2eKg += estimate.totalCo2eKg;
      }
      estimatedEventCount += 1;
      if (estimate.calculationSource) {
        calculationSourceCounts[estimate.calculationSource] = (calculationSourceCounts[estimate.calculationSource] || 0) + 1;
      }
      if (estimate.fallbackReason) {
        fallbackReasonCounts[estimate.fallbackReason] = (fallbackReasonCounts[estimate.fallbackReason] || 0) + 1;
      }
    } else {
      const reason = estimate?.unsupportedReason || "unsupported";
      unsupportedReasonCounts[reason] = (unsupportedReasonCounts[reason] || 0) + 1;
    }
  }
  const splitComponents = isCombinedMethodology(methodology);
  return {
    methodology,
    label: meta.label,
    scope: "whole_flight",
    scopeLabel: "Whole flight",
    gasBasis: splitComponents && includeWellToTank ? "CO2 from fuel burn plus Jet A well-to-tank factor" : "CO2 from fuel burn",
    includeWellToTank,
    tankToWakeCo2eKg: splitComponents ? roundNumber(tankToWakeCo2eKg) : null,
    wellToTankCo2eKg: splitComponents ? roundNumber(wellToTankCo2eKg) : null,
    totalWithoutWellToTankCo2eKg: roundNumber(totalWithoutWellToTankCo2eKg),
    totalWithWellToTankCo2eKg: roundNumber(totalWithWellToTankCo2eKg),
    totalCo2eKg: roundNumber(totalCo2eKg),
    estimatedEventCount,
    missingEventCount: rows.length - estimatedEventCount,
    unsupportedReasonCounts,
    calculationSourceCounts,
    fallbackReasonCounts,
  };
}

function estimateEmissionRows(rows, methodology, options = {}) {
  const includeWellToTank = options.includeWellToTank !== false;
  if (methodology === "none") {
    return rows.map(() => null);
  }

  const estimates = [];
  const detail = options.detail === true;
  const profileCache = ADAPTED_TIM_PROFILE_CACHE;
  const routeCache = EUROCONTROL_ROUTE_CACHE;
  const estimateCache = detail ? new Map() : isCombinedMethodology(methodology) ? COMBINED_ESTIMATE_CACHE : EUROCONTROL_FAST_ESTIMATE_CACHE;
  const atimEstimateCache = detail ? new Map() : ADAPTED_TIM_ESTIMATE_CACHE;
  for (const row of rows) {
    const estimate = isCombinedMethodology(methodology)
      ? estimateCombinedEmissions(row, { includeWellToTank, detail, profileCache, routeCache, estimateCache, atimEstimateCache })
      : estimateEurocontrolFastEmissions(row, { detail, routeCache, estimateCache });
    estimates.push(estimate);
  }
  return estimates;
}

function estimateEmissionsForRows(rows, methodology, options = {}) {
  const includeWellToTank = options.includeWellToTank !== false;
  const estimates = estimateEmissionRows(rows, methodology, options);
  return {
    estimates,
    summary: summarizeEmissionsForEstimates(rows, estimates, methodology, includeWellToTank),
  };
}

const EVENT_STREAM_CHUNK_SIZE = 10_000;

function createApi(db, authStore) {
  const app = express();
  app.set("trust proxy", "loopback");
  app.use("/api", (_request, response, next) => {
    response.set("Cache-Control", "no-store");
    next();
  });
  app.use(express.json({ limit: "1mb" }));

  app.post("/api/login", (request, response) => login(request, response, authStore));
  app.post("/api/logout", logout);
  app.get("/api/session", (request, response) => {
    const credential = authenticatedCredential(request, authStore);
    const cookies = parseCookies(request.headers.cookie || "");
    if (!credential && cookies[COOKIE_NAME]) clearSessionCookie(response);
    response.json({ authenticated: Boolean(credential), role: credential?.role || null });
  });

  app.get("/info", (request, response) => {
    response.type("html").send(renderInfoPage());
  });
  app.get("/docs", (request, response) => {
    response.type("html").send(renderDocsPage());
  });
  app.get("/admin", (request, response) => {
    response.type("html").send(renderAdminPage());
  });

  const publicDir = path.join(ROOT_DIR, "public");
  app.use("/", express.static(publicDir, { extensions: ["html"] }));
  app.use("/api", requireAuth(authStore));
  app.use("/api/admin", requireAdmin, (request, response, next) => {
    response.set("Cache-Control", "no-store");
    next();
  });

  app.get("/api/admin/vouchers", (request, response) => {
    response.json({ vouchers: authStore.listVouchers() });
  });

  app.post("/api/admin/vouchers", (request, response, next) => {
    try {
      const password = managedPassword(request.body?.password, "Voucher");
      const credentialId = authStore.createVoucher(password);
      response.status(201).json({ credentialId, vouchers: authStore.listVouchers() });
    } catch (error) {
      next(credentialWriteError(error));
    }
  });

  app.delete("/api/admin/vouchers/:credentialId", (request, response, next) => {
    try {
      const credentialId = Number(request.params.credentialId);
      if (!Number.isInteger(credentialId) || credentialId < 1) {
        const error = new Error("Invalid voucher ID");
        error.statusCode = 400;
        throw error;
      }
      if (!authStore.deleteVoucher(credentialId)) {
        response.status(404).json({ error: "Voucher not found" });
        return;
      }
      response.json({ ok: true });
    } catch (error) {
      next(error);
    }
  });

  app.put("/api/admin/password", (request, response, next) => {
    try {
      const currentPassword = managedPassword(request.body?.currentPassword, "Current admin password");
      const password = managedPassword(request.body?.password, "New admin password");
      if (!authStore.updateAdminPassword(request.authCredential.credentialId, currentPassword, password)) {
        const error = new Error("Current admin password is incorrect");
        error.statusCode = 400;
        throw error;
      }
      clearSessionCookie(response);
      response.json({ ok: true, reauthenticate: true });
    } catch (error) {
      next(credentialWriteError(error));
    }
  });

  app.get("/api/meta", (request, response, next) => {
    try {
      const eventRange = readEventRange(db);
      const aircraftTypes = db
        .prepare("SELECT label FROM aircraft.aircraft_types ORDER BY label")
        .all()
        .map((row) => row.label);
      const airportTypes = db
        .prepare("SELECT label FROM airports.airport_types ORDER BY label")
        .all()
        .map((row) => row.label);
      response.json({
        version: APP_VERSION,
        movements: eventRange.movements,
        minTime: eventRange.minTime,
        maxTime: eventRange.maxTime,
        eventRangeSource: eventRange.source,
        eventRangeQueryMs: eventRange.queryMs,
        aircraftTypes,
        airportTypes,
        emissionsMethodologies: EMISSIONS_METHODOLOGIES,
      });
    } catch (error) {
      next(error);
    }
  });

  app.get("/api/events/range", (request, response, next) => {
    try {
      response.json(readEventRange(db));
    } catch (error) {
      next(error);
    }
  });

  app.get("/api/info", (request, response, next) => {
    try {
      response.json(buildInfo(db, args));
    } catch (error) {
      next(error);
    }
  });

  app.get("/api/docs", (request, response, next) => {
    try {
      response.json(readDocs());
    } catch (error) {
      next(error);
    }
  });

  app.get("/api/airports", (request, response, next) => {
    try {
      const minLat = parseNumber(request.query.minLat, "minLat");
      const maxLat = parseNumber(request.query.maxLat, "maxLat");
      const minLon = parseNumber(request.query.minLon, "minLon");
      const maxLon = parseNumber(request.query.maxLon, "maxLon");
      const airportType = typeof request.query.type === "string" && request.query.type.trim() ? request.query.type.trim() : null;
      const excludeType =
        typeof request.query.excludeType === "string" && request.query.excludeType.trim()
          ? request.query.excludeType.trim()
          : null;
      const params = {
        minLatE7: Math.round(Math.min(minLat, maxLat) * 1e7),
        maxLatE7: Math.round(Math.max(minLat, maxLat) * 1e7),
        minLonE7: Math.round(Math.min(minLon, maxLon) * 1e7),
        maxLonE7: Math.round(Math.max(minLon, maxLon) * 1e7),
        airportType,
        excludeType,
      };
      const rows = db
        .prepare(
          `
          SELECT a.airport_id, a.code, a.name, a.lat_e7, a.lon_e7, t.label AS airport_type
          FROM airports.airports a
          JOIN airports.airport_types t ON t.airport_type_id = a.airport_type_id
          WHERE a.lat_e7 BETWEEN @minLatE7 AND @maxLatE7
            AND a.lon_e7 BETWEEN @minLonE7 AND @maxLonE7
            AND (@airportType IS NULL OR t.label = @airportType)
            AND (@excludeType IS NULL OR t.label != @excludeType)
          ORDER BY a.code
          `
        )
        .all(params);
      response.json({
        count: rows.length,
        airports: rows.map(rowToAirport),
      });
    } catch (error) {
      next(error);
    }
  });

  function parseEventQuery(payload) {
    const startTs = parseTime(payload.start, "start");
    const endTs = parseTime(payload.end, "end");
    if (endTs <= startTs) {
      throw new Error("end must be after start");
    }
    const airportIds = normalizeAirportIds(payload.airportIds);
    const aircraftType =
      typeof payload.aircraftType === "string" && payload.aircraftType.trim() ? payload.aircraftType.trim() : null;
    const emissionsMethodology = normalizeEmissionsMethodology(payload.emissionsMethodology);
    const includeWellToTank = normalizeIncludeWellToTank(payload.includeWellToTank);
    return {
      startTs,
      endTs,
      aircraftType,
      emissionsMethodology,
      includeWellToTank,
      airportIds,
    };
  }

  function eventSqlParams(query) {
    return {
      startTs: query.startTs,
      endTs: query.endTs,
      aircraftType: query.aircraftType,
      airportIdsJson: JSON.stringify(query.airportIds),
      maxFlightSeconds: MAX_FLIGHT_SECONDS,
    };
  }

  function emptyEventQueryResult(query) {
    return {
      startTs: query.startTs,
      endTs: query.endTs,
      aircraftType: query.aircraftType,
      emissionsMethodology: query.emissionsMethodology,
      includeWellToTank: query.includeWellToTank,
      airportIds: query.airportIds,
      events: [],
      modelGroups: [],
      airportCounts: [],
      emissions: estimateEmissionsForRows([], query.emissionsMethodology, { includeWellToTank: query.includeWellToTank }).summary,
    };
  }

  function queryAirportCounts(params) {
    return db
      .prepare(AIRPORT_COUNTS_SQL)
      .all(params)
      .map((row) => ({
        airportId: row.airport_id,
        code: row.code,
        name: row.name,
        latitude: row.lat_e7 / 1e7,
        longitude: row.lon_e7 / 1e7,
        airportType: row.airport_type,
        operations: Number(row.operations || 0),
        takeoffs: Number(row.takeoffs || 0),
        landings: Number(row.landings || 0),
      }));
  }

  function queryEventCount(params) {
    return Number(db.prepare(EVENT_COUNT_SQL).get(params)?.count || 0);
  }

  function queryEvents(payload) {
    const query = parseEventQuery(payload);
    if (!query.airportIds.length) {
      return emptyEventQueryResult(query);
    }
    const params = eventSqlParams(query);
    const eventRows = db.prepare(EVENT_ROWS_SQL).all(params);
    const emissionsResult = estimateEmissionsForRows(eventRows, query.emissionsMethodology, { includeWellToTank: query.includeWellToTank });
    const emissions = emissionsResult.summary;
    const events = eventRows.map((row, index) => rowToEventSummary(row, emissionsResult.estimates[index]));
    const modelGroups = buildModelGroups(eventRows, emissionsResult.estimates, emissions);

    const airportCounts = queryAirportCounts(params);

    return {
      startTs: query.startTs,
      endTs: query.endTs,
      aircraftType: query.aircraftType,
      emissionsMethodology: query.emissionsMethodology,
      includeWellToTank: query.includeWellToTank,
      airportIds: query.airportIds,
      events,
      modelGroups,
      airportCounts,
      emissions,
    };
  }

  function streamProgress(processed, total, startedAt) {
    const elapsedMs = performance.now() - startedAt;
    const eventsPerSecond = elapsedMs > 0 && processed > 0 ? processed / (elapsedMs / 1000) : null;
    const estimatedTotalMs = eventsPerSecond && total > 0 ? (total / eventsPerSecond) * 1000 : null;
    return {
      processed,
      total,
      percent: total > 0 ? roundNumber((processed / total) * 100, 1) : 100,
      elapsedMs: roundNumber(elapsedMs, 1),
      eventsPerSecond: eventsPerSecond ? roundNumber(eventsPerSecond, 1) : null,
      estimatedTotalMs: estimatedTotalMs ? roundNumber(estimatedTotalMs, 1) : null,
      remainingMs: estimatedTotalMs ? roundNumber(Math.max(0, estimatedTotalMs - elapsedMs), 1) : null,
    };
  }

  async function writeStreamJson(response, payload) {
    if (response.destroyed || response.writableEnded) return false;
    const canContinue = response.write(`${JSON.stringify(payload)}\n`);
    if (!canContinue) {
      await new Promise((resolve) => response.once("drain", resolve));
    }
    await new Promise((resolve) => setImmediate(resolve));
    return true;
  }

  async function streamEvents(payload, response) {
    const query = parseEventQuery(payload);
    response.status(200);
    response.set({
      "Content-Type": "application/x-ndjson; charset=utf-8",
      "Cache-Control": "no-store",
      "X-Accel-Buffering": "no",
    });
    response.flushHeaders?.();

    if (!query.airportIds.length) {
      const empty = emptyEventQueryResult(query);
      await writeStreamJson(response, {
        type: "meta",
        count: 0,
        airportCount: 0,
        airportCounts: [],
        chunkSize: EVENT_STREAM_CHUNK_SIZE,
        start: toIso(query.startTs),
        end: toIso(query.endTs),
        progress: streamProgress(0, 0, performance.now()),
      });
      await writeStreamJson(response, {
        type: "complete",
        count: 0,
        airportCount: 0,
        airportCounts: [],
        emissions: empty.emissions,
        events: [],
        modelGroups: [],
        progress: streamProgress(0, 0, performance.now()),
      });
      response.end();
      return;
    }

    const params = eventSqlParams(query);
    const countStarted = performance.now();
    const totalCount = queryEventCount(params);
    const countMs = performance.now() - countStarted;
    const airportCountsStarted = performance.now();
    const airportCounts = queryAirportCounts(params);
    const airportCountsMs = performance.now() - airportCountsStarted;
    const startedAt = performance.now();
    await writeStreamJson(response, {
      type: "meta",
      count: totalCount,
      airportCount: airportCounts.length,
      airportCounts,
      chunkSize: EVENT_STREAM_CHUNK_SIZE,
      start: toIso(query.startTs),
      end: toIso(query.endTs),
      timings: {
        countMs: roundNumber(countMs, 1),
        airportCountsMs: roundNumber(airportCountsMs, 1),
      },
      progress: streamProgress(0, totalCount, startedAt),
    });
    await writeStreamJson(response, {
      type: "progress",
      count: totalCount,
      airportCount: airportCounts.length,
      processed: 0,
      events: [],
      modelGroups: [],
      emissions: summarizeEmissionsForEstimates([], [], query.emissionsMethodology, query.includeWellToTank),
      progress: streamProgress(0, totalCount, startedAt),
    });

    const allRows = [];
    const allEstimates = [];
    let pendingRows = [];
    let processed = 0;

    const flushPending = async (type) => {
      const chunkRows = pendingRows;
      pendingRows = [];
      const chunkEstimates = chunkRows.length
        ? estimateEmissionRows(chunkRows, query.emissionsMethodology, { includeWellToTank: query.includeWellToTank })
        : [];
      for (let index = 0; index < chunkRows.length; index += 1) {
        allRows.push(chunkRows[index]);
        allEstimates.push(chunkEstimates[index] || null);
      }
      processed += chunkRows.length;
      const emissions = summarizeEmissionsForEstimates(
        allRows,
        allEstimates,
        query.emissionsMethodology,
        query.includeWellToTank
      );
      const modelGroups = buildModelGroups(allRows, allEstimates, emissions);
      return writeStreamJson(response, {
        type,
        count: totalCount,
        airportCount: airportCounts.length,
        airportCounts: type === "complete" ? airportCounts : undefined,
        processed,
        events: chunkRows.map((row, index) => rowToEventSummary(row, chunkEstimates[index] || null)),
        modelGroups,
        emissions,
        progress: streamProgress(processed, totalCount, startedAt),
      });
    };

    for (const row of db.prepare(EVENT_ROWS_SQL).iterate(params)) {
      if (response.destroyed || response.writableEnded) return;
      pendingRows.push(row);
      if (pendingRows.length >= EVENT_STREAM_CHUNK_SIZE) {
        const shouldContinue = await flushPending("progress");
        if (!shouldContinue) return;
      }
    }
    await flushPending("complete");
    response.end();
  }

  async function streamEventSummary(payload, response) {
    const query = parseEventQuery(payload);
    response.status(200);
    response.set({
      "Content-Type": "application/x-ndjson; charset=utf-8",
      "Cache-Control": "no-store",
      "X-Accel-Buffering": "no",
    });
    response.flushHeaders?.();

    const startedAt = performance.now();
    if (!query.airportIds.length) {
      const emissions = estimateEmissionsForRows([], query.emissionsMethodology, { includeWellToTank: query.includeWellToTank }).summary;
      await writeStreamJson(response, {
        type: "complete",
        count: 0,
        emissions,
        start: toIso(query.startTs),
        end: toIso(query.endTs),
        progress: streamProgress(0, 0, startedAt),
      });
      response.end();
      return;
    }

    const params = eventSqlParams(query);
    const totalCount = queryEventCount(params);
    await writeStreamJson(response, {
      type: "meta",
      count: totalCount,
      start: toIso(query.startTs),
      end: toIso(query.endTs),
      chunkSize: EVENT_STREAM_CHUNK_SIZE,
      progress: streamProgress(0, totalCount, startedAt),
    });
    await writeStreamJson(response, {
      type: "progress",
      count: totalCount,
      processed: 0,
      start: toIso(query.startTs),
      end: toIso(query.endTs),
      progress: streamProgress(0, totalCount, startedAt),
    });

    const allEstimates = [];
    let pendingRows = [];
    let processed = 0;

    const flushPending = async (type) => {
      const chunkRows = pendingRows;
      pendingRows = [];
      const chunkEstimates = chunkRows.length
        ? estimateEmissionRows(chunkRows, query.emissionsMethodology, { includeWellToTank: query.includeWellToTank })
        : [];
      allEstimates.push(...chunkEstimates);
      processed += chunkRows.length;
      const emissions = summarizeEmissionsForEstimates(
        { length: processed },
        allEstimates,
        query.emissionsMethodology,
        query.includeWellToTank
      );
      return writeStreamJson(response, {
        type,
        count: totalCount,
        processed,
        emissions,
        start: toIso(query.startTs),
        end: toIso(query.endTs),
        progress: streamProgress(processed, totalCount, startedAt),
      });
    };

    for (const row of db.prepare(EVENT_ROWS_SQL).iterate(params)) {
      if (response.destroyed || response.writableEnded) return;
      pendingRows.push(row);
      if (pendingRows.length >= EVENT_STREAM_CHUNK_SIZE) {
        const shouldContinue = await flushPending("progress");
        if (!shouldContinue) return;
      }
    }
    await flushPending("complete");
    response.end();
  }

  function queryEventDetail(payload) {
    const eventId = Number(payload.eventId);
    if (!Number.isInteger(eventId) || eventId <= 0) {
      throw new Error("eventId must be a positive integer");
    }
    const emissionsMethodology = normalizeEmissionsMethodology(payload.emissionsMethodology);
    const includeWellToTank = normalizeIncludeWellToTank(payload.includeWellToTank);
    const row = db.prepare(EVENT_DETAIL_SQL).get({ eventId, maxFlightSeconds: MAX_FLIGHT_SECONDS });
    if (!row) return null;
    const emissionsResult = estimateEmissionsForRows([row], emissionsMethodology, { includeWellToTank, detail: true });
    return rowToEventDetail(row, emissionsResult.estimates[0] || null);
  }

  app.post("/api/events", (request, response, next) => {
    try {
      const result = queryEvents(request.body || {});
      recordSuccessfulQuery(request, authStore);
      response.json({
        count: result.events.length,
        airportCount: result.airportCounts.length,
        emissions: result.emissions,
        events: result.events,
        modelGroups: result.modelGroups,
        airportCounts: result.airportCounts,
      });
    } catch (error) {
      next(error);
    }
  });

  app.post("/api/events/stream", async (request, response, next) => {
    try {
      await streamEvents(request.body || {}, response);
      recordSuccessfulQuery(request, authStore);
    } catch (error) {
      if (response.headersSent) {
        await writeStreamJson(response, { type: "error", error: error.message || "Search failed" }).catch(() => false);
        response.end();
        return;
      }
      next(error);
    }
  });

  app.post("/api/events/summary", (request, response, next) => {
    try {
      const result = queryEvents(request.body || {});
      recordSuccessfulQuery(request, authStore);
      response.json({
        count: result.events.length,
        emissions: result.emissions,
        start: toIso(result.startTs),
        end: toIso(result.endTs),
      });
    } catch (error) {
      next(error);
    }
  });

  app.post("/api/events/summary/stream", async (request, response, next) => {
    try {
      await streamEventSummary(request.body || {}, response);
      recordSuccessfulQuery(request, authStore);
    } catch (error) {
      if (response.headersSent) {
        await writeStreamJson(response, { type: "error", error: error.message || "Typical comparison failed" }).catch(() => false);
        response.end();
        return;
      }
      next(error);
    }
  });

  app.get("/api/events", (request, response, next) => {
    try {
      const payload = {
        start: request.query.start,
        end: request.query.end,
        aircraftType: request.query.aircraftType,
        emissionsMethodology: request.query.emissionsMethodology,
        includeWellToTank: request.query.includeWellToTank,
        airportIds: String(request.query.airportIds || "")
          .split(",")
          .filter(Boolean)
          .map((value) => Number(value)),
      };
      const result = queryEvents(payload);
      recordSuccessfulQuery(request, authStore);
      response.json({
        count: result.events.length,
        airportCount: result.airportCounts.length,
        emissions: result.emissions,
        events: result.events,
        modelGroups: result.modelGroups,
        airportCounts: result.airportCounts,
      });
    } catch (error) {
      next(error);
    }
  });

  app.get("/api/events/:eventId", (request, response, next) => {
    try {
      const event = queryEventDetail({
        eventId: request.params.eventId,
        emissionsMethodology: request.query.emissionsMethodology,
        includeWellToTank: request.query.includeWellToTank,
      });
      if (!event) {
        response.status(404).json({ error: "event not found" });
        return;
      }
      response.json({ event });
    } catch (error) {
      next(error);
    }
  });

  app.use((error, request, response, next) => {
    if (response.headersSent) {
      next(error);
      return;
    }
    const status = error.statusCode || (/required|must|after|array/.test(error.message || "") ? 400 : 500);
    response.status(status).json({ error: error.message || "Request failed" });
  });

  return app;
}

const args = parseArgs(process.argv.slice(2));
const db = openDatabase(args.adsbfiDbDir);
const authStore = openAuthStore(args.dbDir, {
  bootstrapPassword: environment("PJET_PASSWORD"),
  bootstrapSessionSecret: environment("PJET_SESSION_SECRET"),
});
const app = createApi(db, authStore);
app.listen(args.port, args.host, () => {
  console.log(`Private Jet Emissions Tracker listening at http://${args.host}:${args.port}/`);
});
