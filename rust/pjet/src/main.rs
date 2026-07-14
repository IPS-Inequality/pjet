use anyhow::{Context, Result, anyhow};
use chrono::{DateTime, NaiveDate, TimeZone, Utc};
use memmap2::MmapOptions;
use rusqlite::{Connection, params};
use rustc_hash::FxBuildHasher;
use std::collections::hash_map::RandomState;
use std::collections::{HashMap, HashSet};
use std::env;
use std::fs::{self, File};
use std::hash::BuildHasher;
use std::path::{Path, PathBuf};
use std::time::Instant;

const SLICE_BEGIN_MARKER: i32 = 0x0e7f7c9d;
const MAX_ICAO_ID: u32 = 0x00ff_ffff;
const EARTH_RADIUS_KM: f64 = 6371.0088;
const NON_ROTORCRAFT_EXCLUDED_AIRPORT_TYPE: &str = "heliport";

const EVENTS_SCHEMA: &str = r#"
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
"#;

const STATE_SCHEMA: &str = r#"
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
"#;

#[derive(Clone, Copy, Debug)]
struct TrackPoint {
    ts: i64,
    lat: f64,
    lon: f64,
    alt_ft: Option<f64>,
    on_ground: bool,
}

#[derive(Clone, Debug)]
struct AircraftFileSummary {
    icao_id: u32,
    first_ts: i64,
    first_lat: f64,
    first_lon: f64,
    first_alt_ft: Option<f64>,
    first_on_ground: bool,
    last_ts: i64,
    last_lat: f64,
    last_lon: f64,
    last_alt_ft: Option<f64>,
    last_on_ground: bool,
    max_altitude_ft: Option<f64>,
    max_altitude_ts: Option<i64>,
    point_count: i64,
}

#[derive(Clone, Debug)]
struct SummaryBuilder {
    first_ts: i64,
    first_lat: f64,
    first_lon: f64,
    first_alt_ft: Option<f64>,
    first_on_ground: bool,
    last_ts: i64,
    last_lat: f64,
    last_lon: f64,
    last_alt_ft: Option<f64>,
    last_on_ground: bool,
    max_altitude_ft: Option<f64>,
    max_altitude_ts: Option<i64>,
    point_count: i64,
}

#[derive(Clone, Copy, Debug)]
struct RawPoint {
    icao_id: u32,
    ts: i64,
    lat: f64,
    lon: f64,
    alt_ft: Option<f64>,
    on_ground: bool,
}

impl SummaryBuilder {
    fn new(ts: i64, lat: f64, lon: f64, alt_ft: Option<f64>, on_ground: bool) -> Self {
        Self {
            first_ts: ts,
            first_lat: lat,
            first_lon: lon,
            first_alt_ft: alt_ft,
            first_on_ground: on_ground,
            last_ts: ts,
            last_lat: lat,
            last_lon: lon,
            last_alt_ft: alt_ft,
            last_on_ground: on_ground,
            max_altitude_ft: alt_ft,
            max_altitude_ts: alt_ft.map(|_| ts),
            point_count: 1,
        }
    }

    fn add(&mut self, ts: i64, lat: f64, lon: f64, alt_ft: Option<f64>, on_ground: bool) {
        self.last_ts = ts;
        self.last_lat = lat;
        self.last_lon = lon;
        self.last_alt_ft = alt_ft;
        self.last_on_ground = on_ground;
        self.point_count += 1;
        if let Some(altitude) = alt_ft {
            if self
                .max_altitude_ft
                .is_none_or(|current| altitude > current)
            {
                self.max_altitude_ft = Some(altitude);
                self.max_altitude_ts = Some(ts);
            }
        }
    }

    fn finish(self, icao_id: u32) -> AircraftFileSummary {
        AircraftFileSummary {
            icao_id,
            first_ts: self.first_ts,
            first_lat: self.first_lat,
            first_lon: self.first_lon,
            first_alt_ft: self.first_alt_ft,
            first_on_ground: self.first_on_ground,
            last_ts: self.last_ts,
            last_lat: self.last_lat,
            last_lon: self.last_lon,
            last_alt_ft: self.last_alt_ft,
            last_on_ground: self.last_on_ground,
            max_altitude_ft: self.max_altitude_ft,
            max_altitude_ts: self.max_altitude_ts,
            point_count: self.point_count,
        }
    }
}

#[derive(Clone, Debug)]
struct TrackState {
    icao_id: u32,
    is_rotorcraft: bool,
    segment_start_ts: i64,
    segment_end_ts: i64,
    last_seen_ts: i64,
    first_points: Vec<TrackPoint>,
    last_points: Vec<TrackPoint>,
    point_count: i64,
    max_altitude_ft: Option<f64>,
    max_altitude_ts: Option<i64>,
    source_first_file: Option<String>,
    source_last_file: Option<String>,
    open_start: bool,
}

impl TrackState {
    fn add_summary(
        &mut self,
        summary: &AircraftFileSummary,
        source_file: &Path,
        endpoint_window_seconds: i64,
    ) {
        let first_point = TrackPoint {
            ts: summary.first_ts,
            lat: summary.first_lat,
            lon: summary.first_lon,
            alt_ft: summary.first_alt_ft,
            on_ground: summary.first_on_ground,
        };
        let last_point = TrackPoint {
            ts: summary.last_ts,
            lat: summary.last_lat,
            lon: summary.last_lon,
            alt_ft: summary.last_alt_ft,
            on_ground: summary.last_on_ground,
        };

        self.segment_end_ts = summary.last_ts;
        self.last_seen_ts = summary.last_ts;
        self.source_last_file = Some(source_file.display().to_string());
        self.point_count += summary.point_count;

        if summary.first_ts <= self.segment_start_ts + endpoint_window_seconds {
            self.first_points.push(first_point);
        }

        self.last_points.push(last_point);
        let cutoff = summary.last_ts - endpoint_window_seconds;
        let stale_count = self
            .last_points
            .iter()
            .take_while(|point| point.ts < cutoff)
            .count();
        if stale_count > 0 {
            self.last_points.drain(0..stale_count);
        }

        if let Some(max_altitude) = summary.max_altitude_ft {
            if self
                .max_altitude_ft
                .is_none_or(|current| max_altitude > current)
            {
                self.max_altitude_ft = Some(max_altitude);
                self.max_altitude_ts = summary.max_altitude_ts;
            }
        }
    }

    fn row_tuple(
        &self,
    ) -> (
        i64,
        i64,
        i64,
        i64,
        i64,
        String,
        String,
        i64,
        Option<f64>,
        Option<i64>,
        Option<String>,
        Option<String>,
        i64,
    ) {
        (
            self.icao_id as i64,
            self.is_rotorcraft as i64,
            self.segment_start_ts,
            self.segment_end_ts,
            self.last_seen_ts,
            points_json(&self.first_points),
            points_json(&self.last_points),
            self.point_count,
            self.max_altitude_ft,
            self.max_altitude_ts,
            self.source_first_file.clone(),
            self.source_last_file.clone(),
            self.open_start as i64,
        )
    }
}

#[derive(Clone, Copy, Debug)]
struct PendingTakeoff {
    icao_id: u32,
    takeoff_ts: i64,
    takeoff_airport_id: i64,
    confidence: f64,
    segment_end_ts: i64,
}

#[derive(Clone, Copy, Debug)]
struct AirportEndpoint {
    airport_id: i64,
    elevation_ft: Option<f64>,
    distance_km: f64,
}

#[derive(Clone, Debug)]
struct Airport {
    airport_id: i64,
    lat: f64,
    lon: f64,
    elevation_ft: Option<f64>,
    cos_lat_rad: f64,
}

struct AirportIndex {
    cell_degrees: f64,
    grid: HashMap<(i32, i32), Vec<Airport>>,
}

impl AirportIndex {
    fn from_db(path: &Path, exclude_types: &HashSet<String>) -> Result<Self> {
        let conn = Connection::open_with_flags(path, rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY)
            .with_context(|| format!("opening airports db {}", path.display()))?;
        let mut stmt = conn.prepare(
            r#"
            SELECT a.airport_id, a.lat_e7, a.lon_e7, a.elevation_ft, t.label AS airport_type
            FROM airports a
            JOIN airport_types t ON t.airport_type_id = a.airport_type_id
            ORDER BY a.airport_id
            "#,
        )?;
        let mut rows = stmt.query([])?;
        let mut grid: HashMap<(i32, i32), Vec<Airport>> = HashMap::new();
        let cell_degrees = 0.1_f64;
        while let Some(row) = rows.next()? {
            let airport_type: String = row.get(4)?;
            let normalized = airport_type.to_lowercase();
            if normalized == "closed"
                || normalized == "closed_airport"
                || exclude_types.contains(&normalized)
            {
                continue;
            }
            let lat_e7: i64 = row.get(1)?;
            let lon_e7: i64 = row.get(2)?;
            let lat = lat_e7 as f64 / 1e7;
            let lon = lon_e7 as f64 / 1e7;
            let airport = Airport {
                airport_id: row.get(0)?,
                lat,
                lon,
                elevation_ft: row.get::<_, Option<i64>>(3)?.map(|value| value as f64),
                cos_lat_rad: lat.to_radians().cos(),
            };
            grid.entry(cell_for(cell_degrees, lat, lon))
                .or_default()
                .push(airport);
        }
        Ok(Self { cell_degrees, grid })
    }

    fn nearest(&self, lat: f64, lon: f64, max_distance_km: f64) -> Option<AirportEndpoint> {
        let lat_radius = max_distance_km / 111.0;
        let phi1 = lat.to_radians();
        let cos_phi1 = phi1.cos();
        let cos_lat = 0.15_f64.max(cos_phi1.abs());
        let lon_radius = max_distance_km / (111.0 * cos_lat);
        let min_cell = cell_for(self.cell_degrees, lat - lat_radius, lon - lon_radius);
        let max_cell = cell_for(self.cell_degrees, lat + lat_radius, lon + lon_radius);
        let mut best: Option<AirportEndpoint> = None;
        for lat_cell in min_cell.0..=max_cell.0 {
            for lon_cell in min_cell.1..=max_cell.1 {
                if let Some(airports) = self.grid.get(&(lat_cell, lon_cell)) {
                    for airport in airports {
                        let distance = haversine_from_query_km(lat, lon, cos_phi1, airport);
                        if distance <= max_distance_km
                            && best
                                .as_ref()
                                .is_none_or(|current| distance < current.distance_km)
                        {
                            best = Some(AirportEndpoint {
                                airport_id: airport.airport_id,
                                elevation_ft: airport.elevation_ft,
                                distance_km: distance,
                            });
                        }
                    }
                }
            }
        }
        best
    }
}

struct NearestAirportCache {
    index: AirportIndex,
    max_distance_km: f64,
    cache: HashMap<(i64, i64), Option<AirportEndpoint>>,
}

impl NearestAirportCache {
    fn new(index: AirportIndex, max_distance_km: f64) -> Self {
        Self {
            index,
            max_distance_km,
            cache: HashMap::new(),
        }
    }

    fn nearest(&mut self, lat: f64, lon: f64) -> Option<AirportEndpoint> {
        let key = (
            python_round_to_i64(lat * 1000.0),
            python_round_to_i64(lon * 1000.0),
        );
        if !self.cache.contains_key(&key) {
            let value = self.index.nearest(lat, lon, self.max_distance_km);
            self.cache.insert(key, value);
        }
        self.cache.get(&key).copied().flatten()
    }
}

#[derive(Clone, Copy, Debug)]
struct EndpointCandidate {
    icao_id: u32,
    ts: i64,
    airport_id: i64,
    airport_elevation_ft: Option<f64>,
    confidence: f64,
}

#[derive(Clone, Copy, Debug)]
enum ParserMode {
    SortVec,
    StreamWords,
    DirectSort,
    MmapSort,
    StreamWordsFx,
    DirectStreamFx,
}

impl ParserMode {
    fn parse(value: &str) -> Result<Self> {
        match value {
            "sort-vec" => Ok(Self::SortVec),
            "stream-words" => Ok(Self::StreamWords),
            "direct-sort" => Ok(Self::DirectSort),
            "mmap-sort" => Ok(Self::MmapSort),
            "stream-words-fx" => Ok(Self::StreamWordsFx),
            "direct-stream-fx" => Ok(Self::DirectStreamFx),
            _ => Err(anyhow!(
                "unknown parser mode {value}; expected one of sort-vec, stream-words, direct-sort, mmap-sort, stream-words-fx, direct-stream-fx"
            )),
        }
    }

    fn as_str(self) -> &'static str {
        match self {
            Self::SortVec => "sort-vec",
            Self::StreamWords => "stream-words",
            Self::DirectSort => "direct-sort",
            Self::MmapSort => "mmap-sort",
            Self::StreamWordsFx => "stream-words-fx",
            Self::DirectStreamFx => "direct-stream-fx",
        }
    }
}

#[derive(Debug)]
struct Args {
    cache_dir: PathBuf,
    events_db: PathBuf,
    airports_db: PathBuf,
    aircraft_db: PathBuf,
    state_db: PathBuf,
    start: Option<String>,
    end: Option<String>,
    max_files: Option<usize>,
    reset: bool,
    commit_every: usize,
    progress_every: usize,
    parser_mode: ParserMode,
}

impl Args {
    fn parse() -> Result<Self> {
        let mut args = env::args().skip(1);
        let command = args.next().unwrap_or_else(|| "build-events".to_string());
        if command != "build-events" {
            return Err(anyhow!("only build-events is supported"));
        }
        let data_dir = env::var_os("PJET_DATA_DIR")
            .map(PathBuf::from)
            .unwrap_or_else(|| PathBuf::from("data"));
        let db_dir = env::var_os("PJET_DB_DIR")
            .map(PathBuf::from)
            .unwrap_or_else(|| data_dir.join("pjet"));
        let cache_dir = env::var_os("PJET_ADSBX_CACHE_DIR")
            .map(PathBuf::from)
            .unwrap_or_else(|| data_dir.join("adsbx"));
        let mut parsed = Self {
            cache_dir,
            events_db: db_dir.join("events.sqlite"),
            airports_db: db_dir.join("airports.sqlite"),
            aircraft_db: db_dir.join("aircraft.sqlite"),
            state_db: db_dir.join("build_state.sqlite"),
            start: None,
            end: None,
            max_files: None,
            reset: false,
            commit_every: 50,
            progress_every: 25,
            parser_mode: ParserMode::DirectStreamFx,
        };
        while let Some(arg) = args.next() {
            match arg.as_str() {
                "--cache-dir" => parsed.cache_dir = PathBuf::from(required_arg(&mut args, &arg)?),
                "--events-db" => parsed.events_db = PathBuf::from(required_arg(&mut args, &arg)?),
                "--airports-db" => {
                    parsed.airports_db = PathBuf::from(required_arg(&mut args, &arg)?)
                }
                "--aircraft-db" => {
                    parsed.aircraft_db = PathBuf::from(required_arg(&mut args, &arg)?)
                }
                "--state-db" => parsed.state_db = PathBuf::from(required_arg(&mut args, &arg)?),
                "--start" => parsed.start = Some(required_arg(&mut args, &arg)?),
                "--end" => parsed.end = Some(required_arg(&mut args, &arg)?),
                "--max-files" => parsed.max_files = Some(required_arg(&mut args, &arg)?.parse()?),
                "--reset" => parsed.reset = true,
                "--commit-every" => parsed.commit_every = required_arg(&mut args, &arg)?.parse()?,
                "--progress-every" => {
                    parsed.progress_every = required_arg(&mut args, &arg)?.parse()?
                }
                "--parser-mode" => {
                    parsed.parser_mode = ParserMode::parse(&required_arg(&mut args, &arg)?)?
                }
                other => return Err(anyhow!("unknown argument {other}")),
            }
        }
        Ok(parsed)
    }
}

fn required_arg(args: &mut impl Iterator<Item = String>, flag: &str) -> Result<String> {
    args.next()
        .ok_or_else(|| anyhow!("{flag} requires a value"))
}

struct EventBuilder {
    events_conn: Connection,
    state_conn: Connection,
    rotorcraft_ids: HashSet<u32>,
    all_airports: NearestAirportCache,
    non_heliport_airports: NearestAirportCache,
    states: HashMap<u32, TrackState>,
    state_order: Vec<u32>,
    pending_takeoffs: HashMap<u32, PendingTakeoff>,
    processed_paths: HashSet<String>,
    processed_batch: Vec<(String, i64, String)>,
    max_gap_seconds: i64,
    endpoint_window_seconds: i64,
    min_segment_seconds: f64,
    min_climb_ft: f64,
    max_airport_agl_ft: f64,
    fallback_low_alt_ft: f64,
    max_pending_seconds: i64,
    airport_match_radius_km: f64,
    inserted_events: i64,
    files_processed: i64,
    files_skipped: i64,
    telemetry_rows: i64,
    completed_pairs: i64,
    pending_added: i64,
    pending_completed: i64,
    stale_segments: i64,
    ground_splits: i64,
    parse_errors: Vec<String>,
    in_event_transaction: bool,
    parse_seconds: f64,
    summary_seconds: f64,
    flush_seconds: f64,
    save_seconds: f64,
    parser_mode: ParserMode,
}

impl EventBuilder {
    fn new(
        events_db: &Path,
        airports_db: &Path,
        aircraft_db: &Path,
        state_db: &Path,
        parser_mode: ParserMode,
    ) -> Result<Self> {
        ensure_parent(events_db)?;
        ensure_parent(state_db)?;
        let events_conn = Connection::open(events_db)?;
        events_conn.execute_batch(EVENTS_SCHEMA)?;
        let state_conn = Connection::open(state_db)?;
        state_conn.execute_batch(STATE_SCHEMA)?;
        let rotorcraft_ids = load_rotorcraft_ids(aircraft_db)?;

        let all_airports =
            NearestAirportCache::new(AirportIndex::from_db(airports_db, &HashSet::new())?, 12.0);
        let mut excluded = HashSet::new();
        excluded.insert(NON_ROTORCRAFT_EXCLUDED_AIRPORT_TYPE.to_string());
        let non_heliport_airports =
            NearestAirportCache::new(AirportIndex::from_db(airports_db, &excluded)?, 12.0);

        let mut builder = Self {
            events_conn,
            state_conn,
            rotorcraft_ids,
            all_airports,
            non_heliport_airports,
            states: HashMap::new(),
            state_order: Vec::new(),
            pending_takeoffs: HashMap::new(),
            processed_paths: HashSet::new(),
            processed_batch: Vec::new(),
            max_gap_seconds: 20 * 60,
            endpoint_window_seconds: 8 * 60,
            min_segment_seconds: 120.0,
            min_climb_ft: 1500.0,
            max_airport_agl_ft: 1500.0,
            fallback_low_alt_ft: 1500.0,
            max_pending_seconds: 30 * 3600,
            airport_match_radius_km: 12.0,
            inserted_events: 0,
            files_processed: 0,
            files_skipped: 0,
            telemetry_rows: 0,
            completed_pairs: 0,
            pending_added: 0,
            pending_completed: 0,
            stale_segments: 0,
            ground_splits: 0,
            parse_errors: Vec::new(),
            in_event_transaction: false,
            parse_seconds: 0.0,
            summary_seconds: 0.0,
            flush_seconds: 0.0,
            save_seconds: 0.0,
            parser_mode,
        };
        let (states, state_order) = builder.load_states()?;
        builder.states = states;
        builder.state_order = state_order;
        builder.pending_takeoffs = builder.load_pending_takeoffs()?;
        builder.processed_paths = builder.load_processed_paths()?;
        builder.begin_events()?;
        Ok(builder)
    }

    fn begin_events(&mut self) -> Result<()> {
        if !self.in_event_transaction {
            self.events_conn.execute_batch("BEGIN")?;
            self.in_event_transaction = true;
        }
        Ok(())
    }

    fn commit_events(&mut self) -> Result<()> {
        if self.in_event_transaction {
            self.events_conn.execute_batch("COMMIT")?;
            self.in_event_transaction = false;
        }
        Ok(())
    }

    fn load_processed_paths(&self) -> Result<HashSet<String>> {
        let mut stmt = self
            .state_conn
            .prepare("SELECT path FROM processed_files")?;
        let rows = stmt.query_map([], |row| row.get::<_, String>(0))?;
        let mut paths = HashSet::new();
        for row in rows {
            paths.insert(row?);
        }
        Ok(paths)
    }

    fn load_pending_takeoffs(&self) -> Result<HashMap<u32, PendingTakeoff>> {
        let mut stmt = self.state_conn.prepare(
            "SELECT icao_id, takeoff_ts, takeoff_airport_id, confidence, segment_end_ts FROM pending_takeoffs",
        )?;
        let rows = stmt.query_map([], |row| {
            Ok(PendingTakeoff {
                icao_id: row.get::<_, i64>(0)? as u32,
                takeoff_ts: row.get(1)?,
                takeoff_airport_id: row.get(2)?,
                confidence: row.get(3)?,
                segment_end_ts: row.get(4)?,
            })
        })?;
        let mut pending = HashMap::new();
        for row in rows {
            let value = row?;
            pending.insert(value.icao_id, value);
        }
        Ok(pending)
    }

    fn load_states(&self) -> Result<(HashMap<u32, TrackState>, Vec<u32>)> {
        let mut stmt = self.state_conn.prepare(
            r#"
            SELECT icao_id, is_rotorcraft, segment_start_ts, segment_end_ts, last_seen_ts,
                   first_points_json, last_points_json, point_count, max_altitude_ft,
                   max_altitude_ts, source_first_file, source_last_file, open_start
            FROM track_states
            ORDER BY rowid
            "#,
        )?;
        let rows = stmt.query_map([], |row| {
            let icao_id = row.get::<_, i64>(0)? as u32;
            Ok((
                icao_id,
                TrackState {
                    icao_id,
                    is_rotorcraft: row.get::<_, i64>(1)? != 0,
                    segment_start_ts: row.get(2)?,
                    segment_end_ts: row.get(3)?,
                    last_seen_ts: row.get(4)?,
                    first_points: parse_points_json(&row.get::<_, String>(5)?),
                    last_points: parse_points_json(&row.get::<_, String>(6)?),
                    point_count: row.get(7)?,
                    max_altitude_ft: row.get(8)?,
                    max_altitude_ts: row.get(9)?,
                    source_first_file: row.get(10)?,
                    source_last_file: row.get(11)?,
                    open_start: row.get::<_, i64>(12)? != 0,
                },
            ))
        })?;
        let mut states = HashMap::new();
        let mut state_order = Vec::new();
        for row in rows {
            let (key, state) = row?;
            state_order.push(key);
            states.insert(key, state);
        }
        Ok((states, state_order))
    }

    fn airport_cache_for(&mut self, is_rotorcraft: bool) -> &mut NearestAirportCache {
        if is_rotorcraft {
            &mut self.all_airports
        } else {
            &mut self.non_heliport_airports
        }
    }

    fn choose_endpoint(
        &mut self,
        icao_id: u32,
        is_rotorcraft: bool,
        _segment_end_ts: i64,
        points: &[TrackPoint],
    ) -> Option<EndpointCandidate> {
        let max_airport_agl_ft = self.max_airport_agl_ft;
        let fallback_low_alt_ft = self.fallback_low_alt_ft;
        let airport_match_radius_km = self.airport_match_radius_km;
        let airport_cache = self.airport_cache_for(is_rotorcraft);
        let mut best_point: Option<TrackPoint> = None;
        let mut best_airport: Option<AirportEndpoint> = None;
        let mut best_confidence = 0.0;
        let mut best_score: Option<f64> = None;

        for point in points {
            let Some(airport) = airport_cache.nearest(point.lat, point.lon) else {
                continue;
            };
            let agl_ft = endpoint_agl(point, &airport);
            let mut low_enough = point.on_ground;
            if agl_ft.is_some_and(|value| value <= max_airport_agl_ft) {
                low_enough = true;
            }
            if point
                .alt_ft
                .is_some_and(|value| value <= fallback_low_alt_ft)
            {
                low_enough = true;
            }
            if !low_enough {
                continue;
            }

            let agl_score = agl_ft.map_or(1.0, |value| {
                (1.0 - value / max_airport_agl_ft).clamp(0.0, 1.0)
            });
            let distance_score =
                (1.0 - airport.distance_km / airport_match_radius_km).clamp(0.0, 1.0);
            let ground_bonus = if point.on_ground { 0.15 } else { 0.0 };
            let confidence = (0.55 * distance_score + 0.35 * agl_score + ground_bonus).min(1.0);
            let score = airport.distance_km + agl_ft.unwrap_or(0.0) / 1800.0;
            if best_score.is_none_or(|current| score < current) {
                best_point = Some(*point);
                best_airport = Some(airport);
                best_confidence = confidence;
                best_score = Some(score);
            }
        }

        let point = best_point?;
        let airport = best_airport?;
        Some(EndpointCandidate {
            icao_id,
            ts: point.ts,
            airport_id: airport.airport_id,
            airport_elevation_ft: airport.elevation_ft,
            confidence: best_confidence,
        })
    }

    fn infer_takeoff(&mut self, state: &TrackState) -> Option<EndpointCandidate> {
        if state.open_start || state.first_points.is_empty() || state.max_altitude_ft.is_none() {
            return None;
        }
        let candidate = self.choose_endpoint(
            state.icao_id,
            state.is_rotorcraft,
            state.segment_end_ts,
            &state.first_points,
        )?;
        let endpoint_alt = endpoint_altitude_for(&candidate, &state.first_points);
        let climbed = state.max_altitude_ft? - endpoint_alt;
        let max_after = state
            .max_altitude_ts
            .is_none_or(|value| value >= candidate.ts);
        if climbed >= self.min_climb_ft && max_after {
            Some(candidate)
        } else {
            None
        }
    }

    fn infer_landing(&mut self, state: &TrackState) -> Option<EndpointCandidate> {
        if state.last_points.is_empty() || state.max_altitude_ft.is_none() {
            return None;
        }
        let candidate = self.choose_endpoint(
            state.icao_id,
            state.is_rotorcraft,
            state.segment_end_ts,
            &state.last_points,
        )?;
        let endpoint_alt = endpoint_altitude_for(&candidate, &state.last_points);
        let descended = state.max_altitude_ft? - endpoint_alt;
        let max_before = state
            .max_altitude_ts
            .is_none_or(|value| value <= candidate.ts);
        let near_segment_end = state.segment_end_ts - candidate.ts <= self.endpoint_window_seconds;
        if descended >= self.min_climb_ft && max_before && near_segment_end {
            Some(candidate)
        } else {
            None
        }
    }

    fn finalise_segment(
        &mut self,
        state: &TrackState,
        landing_override: Option<EndpointCandidate>,
    ) -> Result<()> {
        let duration = state.segment_end_ts - state.segment_start_ts;
        if state.point_count < 3
            || (duration as f64) < self.min_segment_seconds
            || state.max_altitude_ft.is_none()
        {
            return Ok(());
        }
        let takeoff = self.infer_takeoff(state);
        let landing = landing_override.or_else(|| self.infer_landing(state));

        if let (Some(takeoff), Some(landing)) = (takeoff, landing) {
            if self.insert_event(takeoff, landing)? {
                self.pending_takeoffs.remove(&state.icao_id);
                self.completed_pairs += 1;
                return Ok(());
            }
        }

        if let Some(landing) = landing {
            if let Some(pending) = self.pending_takeoffs.get(&state.icao_id).copied() {
                if self.insert_pending_event(pending, landing)? {
                    self.pending_takeoffs.remove(&state.icao_id);
                    self.completed_pairs += 1;
                    self.pending_completed += 1;
                    return Ok(());
                }
            }
        }

        if let Some(takeoff) = takeoff {
            self.pending_takeoffs.insert(
                state.icao_id,
                PendingTakeoff {
                    icao_id: state.icao_id,
                    takeoff_ts: takeoff.ts,
                    takeoff_airport_id: takeoff.airport_id,
                    confidence: takeoff.confidence,
                    segment_end_ts: state.segment_end_ts,
                },
            );
            self.pending_added += 1;
        }
        Ok(())
    }

    fn insert_pending_event(
        &mut self,
        takeoff: PendingTakeoff,
        landing: EndpointCandidate,
    ) -> Result<bool> {
        if landing.ts <= takeoff.takeoff_ts
            || landing.ts - takeoff.takeoff_ts > self.max_pending_seconds
        {
            return Ok(false);
        }
        let changed = {
            let mut stmt = self.events_conn.prepare_cached(
                r#"
                INSERT OR IGNORE INTO events(icao_id, takeoff_ts, takeoff_airport_id, landing_ts, landing_airport_id)
                VALUES (?1, ?2, ?3, ?4, ?5)
                "#,
            )?;
            stmt.execute(params![
                takeoff.icao_id as i64,
                takeoff.takeoff_ts,
                takeoff.takeoff_airport_id,
                landing.ts,
                landing.airport_id
            ])?
        };
        let inserted = changed > 0;
        if inserted {
            self.inserted_events += 1;
        }
        Ok(inserted)
    }

    fn insert_event(
        &mut self,
        takeoff: EndpointCandidate,
        landing: EndpointCandidate,
    ) -> Result<bool> {
        if landing.ts <= takeoff.ts || landing.ts - takeoff.ts > self.max_pending_seconds {
            return Ok(false);
        }
        let changed = {
            let mut stmt = self.events_conn.prepare_cached(
                r#"
                INSERT OR IGNORE INTO events(icao_id, takeoff_ts, takeoff_airport_id, landing_ts, landing_airport_id)
                VALUES (?1, ?2, ?3, ?4, ?5)
                "#,
            )?;
            stmt.execute(params![
                takeoff.icao_id as i64,
                takeoff.ts,
                takeoff.airport_id,
                landing.ts,
                landing.airport_id
            ])?
        };
        let inserted = changed > 0;
        if inserted {
            self.inserted_events += 1;
        }
        Ok(inserted)
    }

    fn flush_stale(&mut self, current_ts: i64) -> Result<()> {
        self.compact_state_order();
        let stale_ids: Vec<u32> = self
            .state_order
            .iter()
            .filter_map(|icao_id| {
                let state = self.states.get(icao_id)?;
                if current_ts - state.last_seen_ts > self.max_gap_seconds {
                    Some(*icao_id)
                } else {
                    None
                }
            })
            .collect();
        for icao_id in stale_ids {
            if let Some(state) = self.states.remove(&icao_id) {
                self.finalise_segment(&state, None)?;
                self.stale_segments += 1;
            }
        }
        self.prune_pending(current_ts);
        Ok(())
    }

    fn maybe_split_ground_segment(
        &mut self,
        state: &TrackState,
        summary: &AircraftFileSummary,
    ) -> Result<bool> {
        if !summary.last_on_ground || state.max_altitude_ts.is_none() {
            return Ok(false);
        }
        if state.max_altitude_ts.unwrap() > summary.last_ts - self.endpoint_window_seconds {
            return Ok(false);
        }
        let Some(landing) = self.infer_landing(state) else {
            return Ok(false);
        };
        self.finalise_segment(state, Some(landing))?;
        self.states.remove(&state.icao_id);
        self.ground_splits += 1;
        Ok(true)
    }

    fn prune_pending(&mut self, current_ts: i64) {
        let expired: Vec<u32> = self
            .pending_takeoffs
            .iter()
            .filter_map(|(icao_id, pending)| {
                if current_ts - pending.takeoff_ts > self.max_pending_seconds {
                    Some(*icao_id)
                } else {
                    None
                }
            })
            .collect();
        for icao_id in expired {
            self.pending_takeoffs.remove(&icao_id);
        }
    }

    fn process_file(&mut self, path: &Path, open_start_cutoff_ts: Option<i64>) -> Result<()> {
        let path_key = path.display().to_string();
        if self.processed_paths.contains(&path_key) {
            self.files_skipped += 1;
            return Ok(());
        }
        let slot_ts = slot_timestamp_from_path(path)?;
        let parse_started = Instant::now();
        let summaries = match summarize_heatmap_file(path, self.parser_mode) {
            Ok(value) => value,
            Err(error) => {
                self.parse_errors
                    .push(format!("{}: {error}", path.display()));
                Vec::new()
            }
        };
        self.parse_seconds += parse_started.elapsed().as_secs_f64();
        let mut last_observed_ts = slot_ts + 1800;
        if let Some(max_ts) = summaries.iter().map(|summary| summary.last_ts).max() {
            last_observed_ts = max_ts;
        }

        let summary_started = Instant::now();
        for summary in &summaries {
            self.telemetry_rows += summary.point_count;
            let mut needs_new_state = false;
            if let Some(state) = self.states.get(&summary.icao_id) {
                if summary.first_ts - state.last_seen_ts > self.max_gap_seconds {
                    let state = self.states.remove(&summary.icao_id).unwrap();
                    self.finalise_segment(&state, None)?;
                    self.stale_segments += 1;
                    needs_new_state = true;
                }
            } else {
                needs_new_state = true;
            }

            if needs_new_state {
                self.states.insert(
                    summary.icao_id,
                    TrackState {
                        icao_id: summary.icao_id,
                        is_rotorcraft: self.rotorcraft_ids.contains(&summary.icao_id),
                        segment_start_ts: summary.first_ts,
                        segment_end_ts: summary.last_ts,
                        last_seen_ts: summary.last_ts,
                        first_points: Vec::new(),
                        last_points: Vec::new(),
                        point_count: 0,
                        max_altitude_ft: None,
                        max_altitude_ts: None,
                        source_first_file: Some(path.display().to_string()),
                        source_last_file: Some(path.display().to_string()),
                        open_start: open_start_cutoff_ts
                            .is_some_and(|cutoff| summary.first_ts <= cutoff),
                    },
                );
                self.state_order.push(summary.icao_id);
            }

            let state = self.states.get_mut(&summary.icao_id).unwrap();
            state.add_summary(summary, path, self.endpoint_window_seconds);
            let should_check_split = summary.last_on_ground
                && state
                    .max_altitude_ts
                    .is_some_and(|max_ts| max_ts <= summary.last_ts - self.endpoint_window_seconds);
            if should_check_split {
                let state_snapshot = state.clone();
                self.maybe_split_ground_segment(&state_snapshot, summary)?;
            }
        }
        self.summary_seconds += summary_started.elapsed().as_secs_f64();

        let flush_started = Instant::now();
        self.flush_stale(last_observed_ts)?;
        self.flush_seconds += flush_started.elapsed().as_secs_f64();
        let processed_at = Utc::now().to_rfc3339();
        self.processed_batch
            .push((path_key.clone(), slot_ts, processed_at));
        self.processed_paths.insert(path_key);
        self.files_processed += 1;
        Ok(())
    }

    fn save_state(&mut self) -> Result<()> {
        let started = Instant::now();
        self.compact_state_order();
        self.state_conn.execute_batch("BEGIN")?;
        self.state_conn.execute("DELETE FROM track_states", [])?;
        {
            let mut stmt = self.state_conn.prepare(
                r#"
                INSERT INTO track_states(
                    icao_id, is_rotorcraft, segment_start_ts, segment_end_ts, last_seen_ts,
                    first_points_json, last_points_json, point_count, max_altitude_ft,
                    max_altitude_ts, source_first_file, source_last_file, open_start
                ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13)
                "#,
            )?;
            for icao_id in &self.state_order {
                let Some(state) = self.states.get(icao_id) else {
                    continue;
                };
                let row = state.row_tuple();
                stmt.execute(params![
                    row.0, row.1, row.2, row.3, row.4, row.5, row.6, row.7, row.8, row.9, row.10,
                    row.11, row.12
                ])?;
            }
        }
        self.state_conn
            .execute("DELETE FROM pending_takeoffs", [])?;
        {
            let mut keys: Vec<u32> = self.pending_takeoffs.keys().copied().collect();
            keys.sort_unstable();
            let mut stmt = self.state_conn.prepare(
                r#"
                INSERT INTO pending_takeoffs(
                    icao_id, takeoff_ts, takeoff_airport_id, confidence, segment_end_ts
                ) VALUES (?1, ?2, ?3, ?4, ?5)
                "#,
            )?;
            for key in keys {
                let pending = self.pending_takeoffs[&key];
                stmt.execute(params![
                    pending.icao_id as i64,
                    pending.takeoff_ts,
                    pending.takeoff_airport_id,
                    pending.confidence,
                    pending.segment_end_ts
                ])?;
            }
        }
        if !self.processed_batch.is_empty() {
            let mut stmt = self.state_conn.prepare(
                "INSERT OR IGNORE INTO processed_files(path, slot_ts, processed_at) VALUES (?1, ?2, ?3)",
            )?;
            for row in &self.processed_batch {
                stmt.execute(params![row.0, row.1, row.2])?;
            }
            self.processed_batch.clear();
        }
        set_meta(
            &self.state_conn,
            "active_track_states",
            &self.states.len().to_string(),
        )?;
        set_meta(
            &self.state_conn,
            "pending_takeoffs",
            &self.pending_takeoffs.len().to_string(),
        )?;
        self.state_conn.execute_batch("COMMIT")?;
        self.commit_events()?;
        self.begin_events()?;
        self.save_seconds += started.elapsed().as_secs_f64();
        Ok(())
    }

    fn compact_state_order(&mut self) {
        let mut seen = HashSet::with_capacity(self.states.len());
        let mut compacted = Vec::with_capacity(self.states.len());
        for icao_id in self.state_order.iter().rev() {
            if self.states.contains_key(icao_id) && seen.insert(*icao_id) {
                compacted.push(*icao_id);
            }
        }
        compacted.reverse();
        self.state_order = compacted;
    }

    fn run(
        &mut self,
        files: &[PathBuf],
        start_ts: Option<i64>,
        commit_every: usize,
        progress_every: usize,
    ) -> Result<serde_json::Value> {
        let started = Instant::now();
        let open_start_cutoff_ts = if self.processed_paths.is_empty() {
            start_ts.map(|value| value + self.max_gap_seconds)
        } else {
            None
        };
        for (index, path) in files.iter().enumerate() {
            self.process_file(path, open_start_cutoff_ts)?;
            let one_based = index + 1;
            if one_based % commit_every == 0 {
                self.save_state()?;
            }
            if progress_every > 0 && one_based % progress_every == 0 {
                eprintln!(
                    "Processed {one_based}/{total} selected files ({new} new, {skipped} skipped), {events} inserted events, {active} active tracks, {pending} pending takeoffs, {elapsed:.1}s",
                    total = files.len(),
                    new = self.files_processed,
                    skipped = self.files_skipped,
                    events = self.inserted_events,
                    active = self.states.len(),
                    pending = self.pending_takeoffs.len(),
                    elapsed = started.elapsed().as_secs_f64(),
                );
            }
        }
        self.save_state()?;
        self.commit_events()?;

        let (event_count, min_takeoff_ts, max_landing_ts): (i64, Option<i64>, Option<i64>) = self
            .events_conn
            .query_row(
                "SELECT COUNT(*) AS count, MIN(takeoff_ts) AS min_ts, MAX(landing_ts) AS max_ts FROM events",
                [],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
            )?;
        let elapsed = started.elapsed().as_secs_f64();
        let details = serde_json::json!({
            "selected_files": files.len(),
            "files_processed": self.files_processed,
            "files_skipped": self.files_skipped,
            "telemetry_rows": self.telemetry_rows,
            "inserted_events": self.inserted_events,
            "completed_pairs": self.completed_pairs,
            "pending_added": self.pending_added,
            "pending_completed": self.pending_completed,
            "active_track_states": self.states.len(),
            "pending_takeoffs": self.pending_takeoffs.len(),
            "stale_segments": self.stale_segments,
            "ground_splits": self.ground_splits,
            "parse_error_count": self.parse_errors.len(),
            "parse_errors": self.parse_errors,
            "parser_mode": self.parser_mode.as_str(),
            "parse_seconds": self.parse_seconds,
            "summary_seconds": self.summary_seconds,
            "flush_seconds": self.flush_seconds,
            "save_seconds": self.save_seconds,
            "elapsed_seconds": elapsed,
            "seconds_per_selected_file": if files.is_empty() { serde_json::Value::Null } else { serde_json::json!(elapsed / files.len() as f64) },
            "event_count": event_count,
            "min_takeoff_ts": min_takeoff_ts,
            "max_landing_ts": max_landing_ts,
        });
        set_meta(
            &self.events_conn,
            "last_build_details",
            &serde_json::to_string(&details)?,
        )?;
        if let Some(value) = min_takeoff_ts {
            set_meta(&self.events_conn, "min_takeoff_ts", &value.to_string())?;
        }
        if let Some(value) = max_landing_ts {
            set_meta(&self.events_conn, "max_landing_ts", &value.to_string())?;
        }
        set_meta(&self.events_conn, "event_count", &event_count.to_string())?;
        Ok(details)
    }
}

fn main() -> Result<()> {
    let args = Args::parse()?;
    if args.reset {
        remove_sqlite_family(&args.events_db)?;
        remove_sqlite_family(&args.state_db)?;
    }
    let start_ts = parse_time_arg(args.start.as_deref())?;
    let end_ts = parse_time_arg(args.end.as_deref())?;
    let mut files = iter_heatmap_files(&args.cache_dir, start_ts, end_ts)?;
    if let Some(max_files) = args.max_files {
        files.truncate(max_files);
    }
    if files.is_empty() {
        return Err(anyhow!(
            "No ADS-B Exchange heatmap files matched the requested range."
        ));
    }
    let mut builder = EventBuilder::new(
        &args.events_db,
        &args.airports_db,
        &args.aircraft_db,
        &args.state_db,
        args.parser_mode,
    )?;
    let details = builder.run(&files, start_ts, args.commit_every, args.progress_every)?;
    println!("{}", serde_json::to_string_pretty(&details)?);
    Ok(())
}

fn load_rotorcraft_ids(path: &Path) -> Result<HashSet<u32>> {
    let conn = Connection::open_with_flags(path, rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY)
        .with_context(|| format!("opening aircraft db {}", path.display()))?;
    let mut stmt = conn.prepare(
        r#"
        SELECT a.icao_id
        FROM aircraft a
        JOIN aircraft_types t ON t.aircraft_type_id = a.aircraft_type_id
        WHERE t.label IN ('helicopter', 'gyroplane')
        "#,
    )?;
    let rows = stmt.query_map([], |row| row.get::<_, i64>(0))?;
    let mut ids = HashSet::new();
    for row in rows {
        ids.insert(row? as u32);
    }
    Ok(ids)
}

fn summarize_heatmap_file(path: &Path, mode: ParserMode) -> Result<Vec<AircraftFileSummary>> {
    match mode {
        ParserMode::SortVec => summarize_sort_vec(path),
        ParserMode::StreamWords => summarize_streaming_words(path, RandomState::new()),
        ParserMode::DirectSort => summarize_direct_sort(path),
        ParserMode::MmapSort => summarize_mmap_sort(path),
        ParserMode::StreamWordsFx => summarize_streaming_words(path, FxBuildHasher),
        ParserMode::DirectStreamFx => summarize_direct_streaming(path, FxBuildHasher),
    }
}

fn summarize_sort_vec(path: &Path) -> Result<Vec<AircraftFileSummary>> {
    let raw = fs::read(path)?;
    if raw.len() < 16 {
        return Ok(Vec::new());
    }
    summarize_sort_vec_from_bytes(&raw)
}

fn summarize_mmap_sort(path: &Path) -> Result<Vec<AircraftFileSummary>> {
    let file = File::open(path)?;
    if file.metadata()?.len() < 16 {
        return Ok(Vec::new());
    }
    let mmap = unsafe { MmapOptions::new().map(&file)? };
    summarize_sort_vec_from_bytes(&mmap)
}

fn summarize_sort_vec_from_bytes(raw: &[u8]) -> Result<Vec<AircraftFileSummary>> {
    let (words_i, words_u) = build_word_vectors(raw);
    let marker_indices: Vec<usize> = words_i
        .iter()
        .enumerate()
        .filter_map(|(index, value)| {
            if *value == SLICE_BEGIN_MARKER {
                Some(index)
            } else {
                None
            }
        })
        .collect();
    if marker_indices.is_empty() {
        return Ok(Vec::new());
    }

    let mut points: Vec<RawPoint> = Vec::new();
    for (marker_offset, marker_index) in marker_indices.iter().copied().enumerate() {
        let block_start = marker_index + 4;
        let block_end = marker_indices
            .get(marker_offset + 1)
            .copied()
            .unwrap_or(words_i.len());
        let record_words = ((block_end.saturating_sub(block_start)) / 4) * 4;
        if record_words == 0 {
            continue;
        }
        let now = words_u[marker_index + 2] as f64 / 1000.0
            + words_u[marker_index + 1] as f64 * 4294967.296;
        let ts = python_round_to_i64(now);
        let end = block_start + record_words;
        let mut index = block_start;
        while index < end {
            let point0_u = words_u[index];
            let point1_i = words_i[index + 1];
            if point1_i <= 1_073_741_824 {
                let point_id = point0_u & 0x01ff_ffff;
                if point_id <= MAX_ICAO_ID {
                    let lat = words_i[index + 1] as f32 / 1_000_000.0_f32;
                    let lon = words_i[index + 2] as f32 / 1_000_000.0_f32;
                    let point3 = words_i[index + 3];
                    let mut alt_signed = point3 & 65_535;
                    if (alt_signed & 32_768) != 0 {
                        alt_signed |= -65_536;
                    }
                    let on_ground = alt_signed == -123;
                    let alt_ft = if on_ground {
                        None
                    } else {
                        Some((alt_signed as f32 * 25.0_f32) as f64)
                    };
                    let lat64 = lat as f64;
                    let lon64 = lon as f64;
                    points.push(RawPoint {
                        icao_id: point_id,
                        ts,
                        lat: lat64,
                        lon: lon64,
                        alt_ft,
                        on_ground,
                    });
                }
            }
            index += 4;
        }
    }
    if points.is_empty() {
        return Ok(Vec::new());
    }
    points.sort_by_key(|point| point.icao_id);
    let mut summaries = Vec::new();
    let mut index = 0;
    while index < points.len() {
        let icao_id = points[index].icao_id;
        let first = points[index];
        let mut summary = SummaryBuilder::new(
            first.ts,
            first.lat,
            first.lon,
            first.alt_ft,
            first.on_ground,
        );
        index += 1;
        while index < points.len() && points[index].icao_id == icao_id {
            let point = points[index];
            summary.add(
                point.ts,
                point.lat,
                point.lon,
                point.alt_ft,
                point.on_ground,
            );
            index += 1;
        }
        summaries.push(summary.finish(icao_id));
    }
    Ok(summaries)
}

fn summarize_direct_sort(path: &Path) -> Result<Vec<AircraftFileSummary>> {
    let raw = fs::read(path)?;
    if raw.len() < 16 {
        return Ok(Vec::new());
    }
    let word_len = raw.len() / 4;
    let marker_indices = marker_indices_from_bytes(&raw);
    if marker_indices.is_empty() {
        return Ok(Vec::new());
    }

    let mut points: Vec<RawPoint> = Vec::new();
    for (marker_offset, marker_index) in marker_indices.iter().copied().enumerate() {
        let block_start = marker_index + 4;
        let block_end = marker_indices
            .get(marker_offset + 1)
            .copied()
            .unwrap_or(word_len);
        let record_words = ((block_end.saturating_sub(block_start)) / 4) * 4;
        if record_words == 0 {
            continue;
        }
        let now = read_u32_word(&raw, marker_index + 2) as f64 / 1000.0
            + read_u32_word(&raw, marker_index + 1) as f64 * 4294967.296;
        let ts = python_round_to_i64(now);
        let end = block_start + record_words;
        let mut index = block_start;
        while index < end {
            let point0_u = read_u32_word(&raw, index);
            let point1_i = read_i32_word(&raw, index + 1);
            if point1_i <= 1_073_741_824 {
                let point_id = point0_u & 0x01ff_ffff;
                if point_id <= MAX_ICAO_ID {
                    let lat = point1_i as f32 / 1_000_000.0_f32;
                    let lon = read_i32_word(&raw, index + 2) as f32 / 1_000_000.0_f32;
                    let point3 = read_i32_word(&raw, index + 3);
                    let (alt_ft, on_ground) = decode_altitude(point3);
                    points.push(RawPoint {
                        icao_id: point_id,
                        ts,
                        lat: lat as f64,
                        lon: lon as f64,
                        alt_ft,
                        on_ground,
                    });
                }
            }
            index += 4;
        }
    }

    Ok(summaries_from_points(points))
}

fn summarize_streaming_words<S: BuildHasher>(
    path: &Path,
    hasher: S,
) -> Result<Vec<AircraftFileSummary>> {
    let raw = fs::read(path)?;
    if raw.len() < 16 {
        return Ok(Vec::new());
    }
    let (words_i, words_u) = build_word_vectors(&raw);
    let marker_indices: Vec<usize> = words_i
        .iter()
        .enumerate()
        .filter_map(|(index, value)| {
            if *value == SLICE_BEGIN_MARKER {
                Some(index)
            } else {
                None
            }
        })
        .collect();
    if marker_indices.is_empty() {
        return Ok(Vec::new());
    }

    let mut summaries: HashMap<u32, SummaryBuilder, S> =
        HashMap::with_capacity_and_hasher(131_072, hasher);
    for (marker_offset, marker_index) in marker_indices.iter().copied().enumerate() {
        let block_start = marker_index + 4;
        let block_end = marker_indices
            .get(marker_offset + 1)
            .copied()
            .unwrap_or(words_i.len());
        let record_words = ((block_end.saturating_sub(block_start)) / 4) * 4;
        if record_words == 0 {
            continue;
        }
        let now = words_u[marker_index + 2] as f64 / 1000.0
            + words_u[marker_index + 1] as f64 * 4294967.296;
        let ts = python_round_to_i64(now);
        let end = block_start + record_words;
        let mut index = block_start;
        while index < end {
            let point0_u = words_u[index];
            let point1_i = words_i[index + 1];
            if point1_i <= 1_073_741_824 {
                let point_id = point0_u & 0x01ff_ffff;
                if point_id <= MAX_ICAO_ID {
                    let lat = point1_i as f32 / 1_000_000.0_f32;
                    let lon = words_i[index + 2] as f32 / 1_000_000.0_f32;
                    let (alt_ft, on_ground) = decode_altitude(words_i[index + 3]);
                    update_summary(
                        &mut summaries,
                        point_id,
                        ts,
                        lat as f64,
                        lon as f64,
                        alt_ft,
                        on_ground,
                    );
                }
            }
            index += 4;
        }
    }

    Ok(finish_summary_map(summaries))
}

fn summarize_direct_streaming<S: BuildHasher>(
    path: &Path,
    hasher: S,
) -> Result<Vec<AircraftFileSummary>> {
    let raw = fs::read(path)?;
    if raw.len() < 16 {
        return Ok(Vec::new());
    }
    let word_len = raw.len() / 4;
    let marker_indices = marker_indices_from_bytes(&raw);
    if marker_indices.is_empty() {
        return Ok(Vec::new());
    }

    let mut summaries: HashMap<u32, SummaryBuilder, S> =
        HashMap::with_capacity_and_hasher(131_072, hasher);
    for (marker_offset, marker_index) in marker_indices.iter().copied().enumerate() {
        let block_start = marker_index + 4;
        let block_end = marker_indices
            .get(marker_offset + 1)
            .copied()
            .unwrap_or(word_len);
        let record_words = ((block_end.saturating_sub(block_start)) / 4) * 4;
        if record_words == 0 {
            continue;
        }
        let now = read_u32_word(&raw, marker_index + 2) as f64 / 1000.0
            + read_u32_word(&raw, marker_index + 1) as f64 * 4294967.296;
        let ts = python_round_to_i64(now);
        let end = block_start + record_words;
        let mut index = block_start;
        while index < end {
            let point0_u = read_u32_word(&raw, index);
            let point1_i = read_i32_word(&raw, index + 1);
            if point1_i <= 1_073_741_824 {
                let point_id = point0_u & 0x01ff_ffff;
                if point_id <= MAX_ICAO_ID {
                    let lat = point1_i as f32 / 1_000_000.0_f32;
                    let lon = read_i32_word(&raw, index + 2) as f32 / 1_000_000.0_f32;
                    let (alt_ft, on_ground) = decode_altitude(read_i32_word(&raw, index + 3));
                    update_summary(
                        &mut summaries,
                        point_id,
                        ts,
                        lat as f64,
                        lon as f64,
                        alt_ft,
                        on_ground,
                    );
                }
            }
            index += 4;
        }
    }

    Ok(finish_summary_map(summaries))
}

fn build_word_vectors(raw: &[u8]) -> (Vec<i32>, Vec<u32>) {
    let word_len = raw.len() / 4;
    let mut words_i = Vec::with_capacity(word_len);
    let mut words_u = Vec::with_capacity(word_len);
    for chunk in raw.chunks_exact(4) {
        let bytes = [chunk[0], chunk[1], chunk[2], chunk[3]];
        words_i.push(i32::from_le_bytes(bytes));
        words_u.push(u32::from_le_bytes(bytes));
    }
    (words_i, words_u)
}

fn marker_indices_from_bytes(raw: &[u8]) -> Vec<usize> {
    let word_len = raw.len() / 4;
    let mut marker_indices = Vec::new();
    for index in 0..word_len {
        if read_i32_word(raw, index) == SLICE_BEGIN_MARKER {
            marker_indices.push(index);
        }
    }
    marker_indices
}

#[inline]
fn read_i32_word(raw: &[u8], word_index: usize) -> i32 {
    let offset = word_index * 4;
    i32::from_le_bytes([
        raw[offset],
        raw[offset + 1],
        raw[offset + 2],
        raw[offset + 3],
    ])
}

#[inline]
fn read_u32_word(raw: &[u8], word_index: usize) -> u32 {
    let offset = word_index * 4;
    u32::from_le_bytes([
        raw[offset],
        raw[offset + 1],
        raw[offset + 2],
        raw[offset + 3],
    ])
}

#[inline]
fn decode_altitude(point3: i32) -> (Option<f64>, bool) {
    let mut alt_signed = point3 & 65_535;
    if (alt_signed & 32_768) != 0 {
        alt_signed |= -65_536;
    }
    let on_ground = alt_signed == -123;
    let alt_ft = if on_ground {
        None
    } else {
        Some((alt_signed as f32 * 25.0_f32) as f64)
    };
    (alt_ft, on_ground)
}

fn summaries_from_points(mut points: Vec<RawPoint>) -> Vec<AircraftFileSummary> {
    if points.is_empty() {
        return Vec::new();
    }
    points.sort_by_key(|point| point.icao_id);
    let mut summaries = Vec::new();
    let mut index = 0;
    while index < points.len() {
        let icao_id = points[index].icao_id;
        let first = points[index];
        let mut summary = SummaryBuilder::new(
            first.ts,
            first.lat,
            first.lon,
            first.alt_ft,
            first.on_ground,
        );
        index += 1;
        while index < points.len() && points[index].icao_id == icao_id {
            let point = points[index];
            summary.add(
                point.ts,
                point.lat,
                point.lon,
                point.alt_ft,
                point.on_ground,
            );
            index += 1;
        }
        summaries.push(summary.finish(icao_id));
    }
    summaries
}

fn update_summary<S: BuildHasher>(
    summaries: &mut HashMap<u32, SummaryBuilder, S>,
    icao_id: u32,
    ts: i64,
    lat: f64,
    lon: f64,
    alt_ft: Option<f64>,
    on_ground: bool,
) {
    summaries
        .entry(icao_id)
        .and_modify(|summary| summary.add(ts, lat, lon, alt_ft, on_ground))
        .or_insert_with(|| SummaryBuilder::new(ts, lat, lon, alt_ft, on_ground));
}

fn finish_summary_map<S: BuildHasher>(
    mut summaries: HashMap<u32, SummaryBuilder, S>,
) -> Vec<AircraftFileSummary> {
    let mut keys: Vec<u32> = summaries.keys().copied().collect();
    keys.sort_unstable();
    keys.into_iter()
        .map(|icao_id| summaries.remove(&icao_id).unwrap().finish(icao_id))
        .collect()
}

fn iter_heatmap_files(
    cache_dir: &Path,
    start_ts: Option<i64>,
    end_ts: Option<i64>,
) -> Result<Vec<PathBuf>> {
    if let (Some(start), Some(end)) = (start_ts, end_ts) {
        let mut files = Vec::new();
        let mut cursor = floor_to_slot(start);
        if cursor < start {
            cursor += 1800;
        }
        while cursor < end {
            let path = heatmap_path_for(cache_dir, cursor);
            if path.exists() {
                files.push(path);
            }
            cursor += 1800;
        }
        return Ok(files);
    }
    Err(anyhow!("Rust builder currently requires --start and --end"))
}

fn heatmap_path_for(cache_dir: &Path, timestamp: i64) -> PathBuf {
    let dt = Utc.timestamp_opt(timestamp, 0).unwrap();
    let slot = dt.hour() * 2 + dt.minute() / 30;
    cache_dir
        .join(format!("{:04}", dt.year()))
        .join(format!("{:02}", dt.month()))
        .join(format!("{:02}", dt.day()))
        .join(format!("{slot:02}.bin.ttf"))
}

fn slot_timestamp_from_path(path: &Path) -> Result<i64> {
    let slot_text = path
        .file_stem()
        .and_then(|value| value.to_str())
        .and_then(|value| value.split('.').next())
        .ok_or_else(|| anyhow!("invalid slot filename {}", path.display()))?;
    let slot: i64 = slot_text.parse()?;
    let day: u32 = path
        .parent()
        .and_then(|p| p.file_name())
        .and_then(|v| v.to_str())
        .unwrap()
        .parse()?;
    let month: u32 = path
        .parent()
        .and_then(|p| p.parent())
        .and_then(|p| p.file_name())
        .and_then(|v| v.to_str())
        .unwrap()
        .parse()?;
    let year: i32 = path
        .parent()
        .and_then(|p| p.parent())
        .and_then(|p| p.parent())
        .and_then(|p| p.file_name())
        .and_then(|v| v.to_str())
        .unwrap()
        .parse()?;
    let base = Utc
        .with_ymd_and_hms(year, month, day, 0, 0, 0)
        .unwrap()
        .timestamp();
    Ok(base + slot * 1800)
}

fn parse_time_arg(value: Option<&str>) -> Result<Option<i64>> {
    let Some(text) = value else {
        return Ok(None);
    };
    if text.contains('T') {
        let parsed = DateTime::parse_from_rfc3339(&text.replace('Z', "+00:00"))?;
        return Ok(Some(parsed.with_timezone(&Utc).timestamp()));
    }
    let date = NaiveDate::parse_from_str(text, "%Y-%m-%d")?;
    Ok(Some(
        date.and_hms_opt(0, 0, 0).unwrap().and_utc().timestamp(),
    ))
}

fn floor_to_slot(timestamp: i64) -> i64 {
    timestamp - timestamp.rem_euclid(1800)
}

fn cell_for(cell_degrees: f64, lat: f64, lon: f64) -> (i32, i32) {
    (
        (lat / cell_degrees).floor() as i32,
        (lon / cell_degrees).floor() as i32,
    )
}

fn haversine_from_query_km(lat: f64, lon: f64, cos_phi1: f64, airport: &Airport) -> f64 {
    let d_phi = (airport.lat - lat).to_radians();
    let d_lambda = (airport.lon - lon).to_radians();
    let a = (d_phi / 2.0).sin().powi(2)
        + cos_phi1 * airport.cos_lat_rad * (d_lambda / 2.0).sin().powi(2);
    2.0 * EARTH_RADIUS_KM * a.sqrt().atan2((1.0 - a).sqrt())
}

fn endpoint_agl(point: &TrackPoint, airport: &AirportEndpoint) -> Option<f64> {
    if point.on_ground {
        return Some(0.0);
    }
    if let (Some(alt), Some(elevation)) = (point.alt_ft, airport.elevation_ft) {
        return Some((alt - elevation).max(0.0));
    }
    point.alt_ft
}

fn endpoint_altitude_for(candidate: &EndpointCandidate, points: &[TrackPoint]) -> f64 {
    for point in points {
        if point.ts == candidate.ts {
            if let Some(altitude) = point.alt_ft {
                return altitude;
            }
        }
    }
    candidate.airport_elevation_ft.unwrap_or(0.0)
}

fn python_round_to_i64(value: f64) -> i64 {
    let floor = value.floor();
    let fraction = value - floor;
    if fraction > 0.5 {
        floor as i64 + 1
    } else if fraction < 0.5 {
        floor as i64
    } else {
        let floor_i = floor as i64;
        if floor_i % 2 == 0 {
            floor_i
        } else {
            floor_i + 1
        }
    }
}

fn point_number(value: f64) -> String {
    let rounded = python_round_to_i64(value * 1_000_000.0) as f64 / 1_000_000.0;
    serde_json::to_string(&rounded).unwrap()
}

fn points_json(points: &[TrackPoint]) -> String {
    let mut output = String::from("[");
    for (index, point) in points.iter().enumerate() {
        if index > 0 {
            output.push(',');
        }
        output.push('[');
        output.push_str(&point.ts.to_string());
        output.push(',');
        output.push_str(&point_number(point.lat));
        output.push(',');
        output.push_str(&point_number(point.lon));
        output.push(',');
        if let Some(altitude) = point.alt_ft {
            output.push_str(&serde_json::to_string(&altitude).unwrap());
        } else {
            output.push_str("null");
        }
        output.push(',');
        output.push(if point.on_ground { '1' } else { '0' });
        output.push(']');
    }
    output.push(']');
    output
}

fn parse_points_json(value: &str) -> Vec<TrackPoint> {
    let parsed: serde_json::Value =
        serde_json::from_str(value).unwrap_or(serde_json::Value::Array(Vec::new()));
    let Some(items) = parsed.as_array() else {
        return Vec::new();
    };
    items
        .iter()
        .filter_map(|item| {
            let values = item.as_array()?;
            Some(TrackPoint {
                ts: values.first()?.as_i64()?,
                lat: values.get(1)?.as_f64()?,
                lon: values.get(2)?.as_f64()?,
                alt_ft: values.get(3).and_then(|value| value.as_f64()),
                on_ground: values.get(4)?.as_i64()? != 0,
            })
        })
        .collect()
}

fn set_meta(conn: &Connection, key: &str, value: &str) -> Result<()> {
    conn.execute(
        "INSERT INTO meta(key, value) VALUES(?1, ?2) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
        params![key, value],
    )?;
    Ok(())
}

fn ensure_parent(path: &Path) -> Result<()> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)?;
    }
    Ok(())
}

fn remove_sqlite_family(path: &Path) -> Result<()> {
    for candidate in [
        path.to_path_buf(),
        PathBuf::from(format!("{}-wal", path.display())),
        PathBuf::from(format!("{}-shm", path.display())),
    ] {
        if candidate.exists() {
            fs::remove_file(candidate)?;
        }
    }
    Ok(())
}

trait DateParts {
    fn year(&self) -> i32;
    fn month(&self) -> u32;
    fn day(&self) -> u32;
    fn hour(&self) -> u32;
    fn minute(&self) -> u32;
}

impl DateParts for DateTime<Utc> {
    fn year(&self) -> i32 {
        chrono::Datelike::year(self)
    }
    fn month(&self) -> u32 {
        chrono::Datelike::month(self)
    }
    fn day(&self) -> u32 {
        chrono::Datelike::day(self)
    }
    fn hour(&self) -> u32 {
        chrono::Timelike::hour(self)
    }
    fn minute(&self) -> u32 {
        chrono::Timelike::minute(self)
    }
}
