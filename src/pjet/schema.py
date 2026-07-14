from __future__ import annotations

import sqlite3
from pathlib import Path

from .paths import ensure_parent


EVENTS_SCHEMA = """
PRAGMA journal_mode=WAL;
PRAGMA synchronous=NORMAL;
PRAGMA foreign_keys=OFF;

CREATE TABLE IF NOT EXISTS meta (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS events (
    event_id INTEGER PRIMARY KEY,
    icao_id INTEGER NOT NULL,
    takeoff_ts INTEGER NOT NULL,
    takeoff_airport_id INTEGER NOT NULL,
    landing_ts INTEGER NOT NULL,
    landing_airport_id INTEGER NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_events_unique_pair
    ON events(icao_id, takeoff_ts, takeoff_airport_id, landing_ts, landing_airport_id);
CREATE INDEX IF NOT EXISTS idx_events_takeoff_airport_time
    ON events(takeoff_airport_id, takeoff_ts, icao_id, landing_airport_id, landing_ts);
CREATE INDEX IF NOT EXISTS idx_events_landing_airport_time
    ON events(landing_airport_id, landing_ts, icao_id, takeoff_airport_id, takeoff_ts);
CREATE INDEX IF NOT EXISTS idx_events_icao_takeoff
    ON events(icao_id, takeoff_ts);
"""

AIRPORTS_SCHEMA = """
PRAGMA journal_mode=WAL;
PRAGMA synchronous=NORMAL;

CREATE TABLE IF NOT EXISTS meta (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS airport_types (
    airport_type_id INTEGER PRIMARY KEY,
    label TEXT NOT NULL UNIQUE
);

CREATE TABLE IF NOT EXISTS airports (
    airport_id INTEGER PRIMARY KEY,
    code TEXT NOT NULL UNIQUE,
    name TEXT NOT NULL,
    lat_e7 INTEGER NOT NULL,
    lon_e7 INTEGER NOT NULL,
    airport_type_id INTEGER NOT NULL,
    elevation_ft INTEGER,
    FOREIGN KEY (airport_type_id) REFERENCES airport_types(airport_type_id)
);

CREATE INDEX IF NOT EXISTS idx_airports_lat_lon ON airports(lat_e7, lon_e7);
CREATE INDEX IF NOT EXISTS idx_airports_type_lat_lon ON airports(airport_type_id, lat_e7, lon_e7);
"""

AIRCRAFT_SCHEMA = """
PRAGMA journal_mode=WAL;
PRAGMA synchronous=NORMAL;

CREATE TABLE IF NOT EXISTS meta (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS aircraft_types (
    aircraft_type_id INTEGER PRIMARY KEY,
    label TEXT NOT NULL UNIQUE
);

CREATE TABLE IF NOT EXISTS aircraft (
    icao_id INTEGER PRIMARY KEY,
    registration TEXT,
    n_number TEXT,
    manufacturer TEXT,
    model TEXT,
    icao_type TEXT,
    aircraft_type_id INTEGER NOT NULL,
    source_mask INTEGER NOT NULL DEFAULT 0,
    owner_name TEXT,
    owner_city TEXT,
    owner_state TEXT,
    owner_country TEXT,
    owner_type TEXT,
    year_mfr INTEGER,
    FOREIGN KEY (aircraft_type_id) REFERENCES aircraft_types(aircraft_type_id)
);

CREATE INDEX IF NOT EXISTS idx_aircraft_type ON aircraft(aircraft_type_id, icao_id);
CREATE INDEX IF NOT EXISTS idx_aircraft_registration ON aircraft(registration);
"""

STATE_SCHEMA = """
PRAGMA journal_mode=WAL;
PRAGMA synchronous=NORMAL;

CREATE TABLE IF NOT EXISTS meta (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS processed_files (
    path TEXT PRIMARY KEY,
    slot_ts INTEGER NOT NULL,
    processed_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_processed_files_slot ON processed_files(slot_ts);

CREATE TABLE IF NOT EXISTS track_states (
    icao_id INTEGER PRIMARY KEY,
    is_rotorcraft INTEGER NOT NULL,
    segment_start_ts INTEGER NOT NULL,
    segment_end_ts INTEGER NOT NULL,
    last_seen_ts INTEGER NOT NULL,
    first_points_json TEXT NOT NULL,
    last_points_json TEXT NOT NULL,
    point_count INTEGER NOT NULL,
    max_altitude_ft REAL,
    max_altitude_ts INTEGER,
    source_first_file TEXT,
    source_last_file TEXT,
    open_start INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS pending_takeoffs (
    icao_id INTEGER PRIMARY KEY,
    takeoff_ts INTEGER NOT NULL,
    takeoff_airport_id INTEGER NOT NULL,
    confidence REAL NOT NULL,
    segment_end_ts INTEGER NOT NULL
);
"""


def connect(path: Path, schema: str | None = None) -> sqlite3.Connection:
    ensure_parent(path)
    connection = sqlite3.connect(path)
    connection.row_factory = sqlite3.Row
    if schema:
        connection.executescript(schema)
    return connection


def connect_readonly(path: Path) -> sqlite3.Connection:
    connection = sqlite3.connect(f"file:{path}?mode=ro", uri=True)
    connection.row_factory = sqlite3.Row
    return connection


def set_meta(connection: sqlite3.Connection, key: str, value: str) -> None:
    connection.execute(
        "INSERT INTO meta(key, value) VALUES(?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
        (key, value),
    )


def get_meta(connection: sqlite3.Connection, key: str) -> str | None:
    row = connection.execute("SELECT value FROM meta WHERE key = ?", (key,)).fetchone()
    return row["value"] if row else None


def vacuum(path: Path) -> None:
    with sqlite3.connect(path) as connection:
        connection.execute("PRAGMA optimize")
        connection.execute("VACUUM")
