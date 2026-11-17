import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import Database from "better-sqlite3";
import {
  AIRPORT_COUNTS_SQL,
  EVENT_COUNT_SQL,
  EVENT_DETAIL_SQL,
  EVENT_ROWS_SQL,
  MAX_FLIGHT_SECONDS,
} from "./flight-sql.js";

const HOUR = 3600;
const T0 = 1_800_000_000;
const A = 1;
const B = 2;
const C = 3;
const JET = 0xa00001;
const JET_GAP = 0xa00002;
const PISTON = 0xa00003;
const UNKNOWN = 0xa00004;

// Endpoint rows: [endpoint_id, icao_id, ts, is_landing, airport_id].
const ENDPOINTS = [
  // JET: A -> B, then B -> C, then an unpaired takeoff (next movement is a takeoff).
  [10, JET, T0 + 1 * HOUR, 0, A],
  [11, JET, T0 + 2 * HOUR, 1, B],
  [12, JET, T0 + 5 * HOUR, 0, B],
  [13, JET, T0 + 6 * HOUR, 1, C],
  [14, JET, T0 + 8 * HOUR, 0, C],
  [15, JET, T0 + 9 * HOUR, 0, A],
  [16, JET, T0 + 10 * HOUR, 1, B],
  // JET_GAP: takeoff and next landing too far apart to be one flight.
  [20, JET_GAP, T0 + 1 * HOUR, 0, A],
  [21, JET_GAP, T0 + 1 * HOUR + MAX_FLIGHT_SECONDS + 1, 1, B],
  // PISTON: A -> A local flight; landing with no preceding takeoff.
  [30, PISTON, T0 + 3 * HOUR, 0, A],
  [31, PISTON, T0 + 4 * HOUR, 1, A],
  [32, PISTON, T0 + 7 * HOUR, 1, B],
  // UNKNOWN: no aircraft metadata; takeoff before the window, landing inside it.
  [40, UNKNOWN, T0 - 2 * HOUR, 0, C],
  [41, UNKNOWN, T0 + 1 * HOUR, 1, A],
];

function createLedger() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pjet-flight-sql-"));
  const events = new Database(path.join(dir, "events.sqlite"));
  events.exec(`
    CREATE TABLE endpoints (
      endpoint_id INTEGER PRIMARY KEY, icao_id INTEGER NOT NULL, ts INTEGER NOT NULL,
      is_landing INTEGER NOT NULL, airport_id INTEGER NOT NULL, callsign_id INTEGER
    );
    CREATE UNIQUE INDEX idx_endpoints_aircraft_time ON endpoints(icao_id, ts, is_landing);
    CREATE INDEX idx_endpoints_airport_time ON endpoints(airport_id, ts, icao_id, is_landing);
  `);
  const insert = events.prepare("INSERT INTO endpoints VALUES (?, ?, ?, ?, ?, NULL)");
  for (const row of ENDPOINTS) insert.run(...row);
  events.close();

  const airports = new Database(path.join(dir, "airports.sqlite"));
  airports.exec(`
    CREATE TABLE airport_types (airport_type_id INTEGER PRIMARY KEY, label TEXT NOT NULL);
    CREATE TABLE airports (
      airport_id INTEGER PRIMARY KEY, code TEXT, name TEXT, lat_e7 INTEGER, lon_e7 INTEGER,
      airport_type_id INTEGER, elevation_ft INTEGER
    );
    INSERT INTO airport_types VALUES (1, 'medium_airport');
    INSERT INTO airports VALUES
      (1, 'AAAA', 'Alpha', 400000000, -740000000, 1, 0),
      (2, 'BBBB', 'Bravo', 410000000, -750000000, 1, 0),
      (3, 'CCCC', 'Charlie', 420000000, -760000000, 1, 0);
  `);
  airports.close();

  const aircraft = new Database(path.join(dir, "aircraft.sqlite"));
  aircraft.exec(`
    CREATE TABLE aircraft_types (aircraft_type_id INTEGER PRIMARY KEY, label TEXT NOT NULL);
    CREATE TABLE aircraft (
      icao_id INTEGER PRIMARY KEY, registration TEXT, n_number TEXT, manufacturer TEXT, model TEXT,
      icao_type TEXT, aircraft_type_id INTEGER, owner_name TEXT, owner_city TEXT, owner_state TEXT,
      owner_country TEXT, owner_type TEXT, year_mfr INTEGER
    );
    INSERT INTO aircraft_types VALUES (1, 'business_jet'), (2, 'piston');
  `);
  const insertAircraft = aircraft.prepare(
    "INSERT INTO aircraft (icao_id, registration, aircraft_type_id) VALUES (?, ?, ?)"
  );
  insertAircraft.run(JET, "N1JET", 1);
  insertAircraft.run(JET_GAP, "N2JET", 1);
  insertAircraft.run(PISTON, "N3PST", 2);
  aircraft.close();

  const db = new Database(path.join(dir, "events.sqlite"), { readonly: true });
  db.exec(`
    ATTACH DATABASE '${path.join(dir, "airports.sqlite")}' AS airports;
    ATTACH DATABASE '${path.join(dir, "aircraft.sqlite")}' AS aircraft;
  `);
  return {
    db,
    close() {
      db.close();
      fs.rmSync(dir, { recursive: true, force: true });
    },
  };
}

function params({ airportIds, startTs = T0, endTs = T0 + 24 * HOUR, aircraftType = null }) {
  return {
    airportIdsJson: JSON.stringify(airportIds),
    startTs,
    endTs,
    aircraftType,
    maxFlightSeconds: MAX_FLIGHT_SECONDS,
  };
}

function flights(db, query) {
  return db
    .prepare(EVENT_ROWS_SQL)
    .all(params(query))
    .map((row) => [row.event_id, row.takeoff_airport_code, row.landing_airport_code, row.operation_matches]);
}

test("pairs each takeoff with the directly following landing of the same aircraft", () => {
  const ledger = createLedger();
  try {
    assert.deepEqual(flights(ledger.db, { airportIds: [B] }), [
      [10, "AAAA", "BBBB", "landing:2"],
      [12, "BBBB", "CCCC", "takeoff:2"],
      [15, "AAAA", "BBBB", "landing:2"],
    ]);
  } finally {
    ledger.close();
  }
});

test("leaves out unpaired movements and pairs longer than the flight limit", () => {
  const ledger = createLedger();
  try {
    // Endpoint 14 (takeoff followed by a takeoff), JET_GAP and PISTON's lone landing are not flights.
    assert.deepEqual(
      flights(ledger.db, { airportIds: [C], aircraftType: "business_jet" }).map((row) => row[0]),
      [12]
    );
    assert.equal(ledger.db.prepare(EVENT_COUNT_SQL).get(params({ airportIds: [B], aircraftType: "piston" })).count, 0);
  } finally {
    ledger.close();
  }
});

test("returns one flight when both of its airports are selected", () => {
  const ledger = createLedger();
  try {
    const rows = flights(ledger.db, { airportIds: [A], aircraftType: "piston" });
    assert.deepEqual(rows.length, 1);
    assert.equal(rows[0][0], 30);
    assert.deepEqual(rows[0][3].split(",").sort(), ["landing:1", "takeoff:1"]);
    const counts = ledger.db.prepare(AIRPORT_COUNTS_SQL).all(params({ airportIds: [A], aircraftType: "piston" }));
    assert.deepEqual(
      counts.map((row) => [row.code, row.takeoffs, row.landings]),
      [["AAAA", 1, 1]]
    );
  } finally {
    ledger.close();
  }
});

test("matches landings in the window whose takeoff precedes it, and filters by aircraft type", () => {
  const ledger = createLedger();
  try {
    assert.deepEqual(
      flights(ledger.db, { airportIds: [A] }).map((row) => row[0]),
      [40, 10, 30, 15]
    );
    // UNKNOWN has no aircraft metadata, so any aircraft type filter excludes it.
    assert.deepEqual(
      flights(ledger.db, { airportIds: [A], aircraftType: "business_jet" }).map((row) => row[0]),
      [10, 15]
    );
  } finally {
    ledger.close();
  }
});

test("looks up a flight by its takeoff endpoint id only", () => {
  const ledger = createLedger();
  try {
    const detail = ledger.db.prepare(EVENT_DETAIL_SQL);
    const row = detail.get({ eventId: 12, maxFlightSeconds: MAX_FLIGHT_SECONDS });
    assert.equal(row.takeoff_airport_code, "BBBB");
    assert.equal(row.landing_airport_code, "CCCC");
    assert.equal(row.landing_ts - row.takeoff_ts, HOUR);
    assert.equal(row.registration, "N1JET");
    for (const eventId of [11, 14, 20, 999]) {
      assert.equal(detail.get({ eventId, maxFlightSeconds: MAX_FLIGHT_SECONDS }), undefined, `endpoint ${eventId}`);
    }
  } finally {
    ledger.close();
  }
});
