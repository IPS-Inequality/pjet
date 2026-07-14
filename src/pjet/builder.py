from __future__ import annotations

import argparse
import datetime as dt
import json
import os
import sqlite3
import time
from dataclasses import dataclass, field
from pathlib import Path

from .aircraft import rotorcraft_icao_ids
from .airports import AirportEndpoint, AirportIndex, NearestAirportCache
from .heatmap import AircraftFileSummary, iter_heatmap_files, slot_timestamp_from_path, summarize_heatmap_file
from .paths import ADSBX_CACHE_DIR, AIRCRAFT_DB, AIRPORTS_DB, EVENTS_DB, STATE_DB
from .schema import EVENTS_SCHEMA, STATE_SCHEMA, connect, set_meta, vacuum


NON_ROTORCRAFT_EXCLUDED_AIRPORT_TYPES = {"heliport"}


@dataclass(frozen=True)
class TrackPoint:
    ts: int
    lat: float
    lon: float
    alt_ft: float | None
    on_ground: bool

    def to_json(self) -> list:
        return [self.ts, round(self.lat, 6), round(self.lon, 6), self.alt_ft, 1 if self.on_ground else 0]

    @classmethod
    def from_json(cls, values: list) -> "TrackPoint":
        return cls(
            ts=int(values[0]),
            lat=float(values[1]),
            lon=float(values[2]),
            alt_ft=None if values[3] is None else float(values[3]),
            on_ground=bool(values[4]),
        )


@dataclass
class TrackState:
    icao_id: int
    is_rotorcraft: bool
    segment_start_ts: int
    segment_end_ts: int
    last_seen_ts: int
    first_points: list[TrackPoint] = field(default_factory=list)
    last_points: list[TrackPoint] = field(default_factory=list)
    point_count: int = 0
    max_altitude_ft: float | None = None
    max_altitude_ts: int | None = None
    source_first_file: str | None = None
    source_last_file: str | None = None
    open_start: bool = False

    @classmethod
    def from_row(cls, row: sqlite3.Row) -> "TrackState":
        return cls(
            icao_id=int(row["icao_id"]),
            is_rotorcraft=bool(row["is_rotorcraft"]),
            segment_start_ts=int(row["segment_start_ts"]),
            segment_end_ts=int(row["segment_end_ts"]),
            last_seen_ts=int(row["last_seen_ts"]),
            first_points=[TrackPoint.from_json(point) for point in json.loads(row["first_points_json"])],
            last_points=[TrackPoint.from_json(point) for point in json.loads(row["last_points_json"])],
            point_count=int(row["point_count"]),
            max_altitude_ft=float(row["max_altitude_ft"]) if row["max_altitude_ft"] is not None else None,
            max_altitude_ts=int(row["max_altitude_ts"]) if row["max_altitude_ts"] is not None else None,
            source_first_file=row["source_first_file"],
            source_last_file=row["source_last_file"],
            open_start=bool(row["open_start"]),
        )

    def to_row(self) -> tuple:
        return (
            self.icao_id,
            int(self.is_rotorcraft),
            self.segment_start_ts,
            self.segment_end_ts,
            self.last_seen_ts,
            json.dumps([point.to_json() for point in self.first_points], separators=(",", ":")),
            json.dumps([point.to_json() for point in self.last_points], separators=(",", ":")),
            self.point_count,
            self.max_altitude_ft,
            self.max_altitude_ts,
            self.source_first_file,
            self.source_last_file,
            int(self.open_start),
        )

    def add_summary(self, summary: AircraftFileSummary, source_file: Path, endpoint_window_seconds: int) -> None:
        first_point = TrackPoint(
            ts=summary.first_ts,
            lat=summary.first_lat,
            lon=summary.first_lon,
            alt_ft=summary.first_alt_ft,
            on_ground=summary.first_on_ground,
        )
        last_point = TrackPoint(
            ts=summary.last_ts,
            lat=summary.last_lat,
            lon=summary.last_lon,
            alt_ft=summary.last_alt_ft,
            on_ground=summary.last_on_ground,
        )

        self.segment_end_ts = summary.last_ts
        self.last_seen_ts = summary.last_ts
        self.source_last_file = str(source_file)
        self.point_count += summary.point_count

        if summary.first_ts <= self.segment_start_ts + endpoint_window_seconds:
            self.first_points.append(first_point)

        self.last_points.append(last_point)
        cutoff = summary.last_ts - endpoint_window_seconds
        stale_count = 0
        for point in self.last_points:
            if point.ts >= cutoff:
                break
            stale_count += 1
        if stale_count:
            del self.last_points[:stale_count]

        if summary.max_altitude_ft is not None and (
            self.max_altitude_ft is None or summary.max_altitude_ft > self.max_altitude_ft
        ):
            self.max_altitude_ft = summary.max_altitude_ft
            self.max_altitude_ts = summary.max_altitude_ts


@dataclass(frozen=True)
class EndpointCandidate:
    icao_id: int
    ts: int
    airport_id: int
    airport_elevation_ft: float | None
    confidence: float
    score: float
    agl_ft: float | None
    segment_end_ts: int


@dataclass(frozen=True)
class PendingTakeoff:
    icao_id: int
    takeoff_ts: int
    takeoff_airport_id: int
    confidence: float
    segment_end_ts: int

    @classmethod
    def from_row(cls, row: sqlite3.Row) -> "PendingTakeoff":
        return cls(
            icao_id=int(row["icao_id"]),
            takeoff_ts=int(row["takeoff_ts"]),
            takeoff_airport_id=int(row["takeoff_airport_id"]),
            confidence=float(row["confidence"]),
            segment_end_ts=int(row["segment_end_ts"]),
        )

    def to_row(self) -> tuple:
        return (
            self.icao_id,
            self.takeoff_ts,
            self.takeoff_airport_id,
            self.confidence,
            self.segment_end_ts,
        )


class EventBuilder:
    def __init__(
        self,
        events_db: Path = EVENTS_DB,
        airports_db: Path = AIRPORTS_DB,
        aircraft_db: Path = AIRCRAFT_DB,
        state_db: Path = STATE_DB,
        max_gap_minutes: float = 20.0,
        endpoint_window_minutes: float = 8.0,
        min_segment_seconds: float = 120.0,
        min_climb_ft: float = 1500.0,
        max_airport_agl_ft: float = 1500.0,
        fallback_low_alt_ft: float = 1500.0,
        airport_match_radius_km: float = 12.0,
        max_pending_hours: float = 30.0,
    ) -> None:
        self.events_db = events_db
        self.airports_db = airports_db
        self.aircraft_db = aircraft_db
        self.state_db = state_db
        self.max_gap_seconds = int(max_gap_minutes * 60)
        self.endpoint_window_seconds = int(endpoint_window_minutes * 60)
        self.min_segment_seconds = min_segment_seconds
        self.min_climb_ft = min_climb_ft
        self.max_airport_agl_ft = max_airport_agl_ft
        self.fallback_low_alt_ft = fallback_low_alt_ft
        self.max_pending_seconds = int(max_pending_hours * 3600)
        self.airport_match_radius_km = airport_match_radius_km

        self.events_conn = connect(events_db, EVENTS_SCHEMA)
        self.state_conn = connect(state_db, STATE_SCHEMA)
        self.airports_conn = sqlite3.connect(f"file:{airports_db}?mode=ro", uri=True)
        self.airports_conn.row_factory = sqlite3.Row
        self.aircraft_conn = sqlite3.connect(f"file:{aircraft_db}?mode=ro", uri=True)
        self.aircraft_conn.row_factory = sqlite3.Row

        rotorcraft_ids = rotorcraft_icao_ids(self.aircraft_conn)
        self.rotorcraft_ids = rotorcraft_ids
        self.all_airports = NearestAirportCache(
            AirportIndex.from_db(self.airports_conn),
            max_distance_km=airport_match_radius_km,
        )
        self.non_heliport_airports = NearestAirportCache(
            AirportIndex.from_db(self.airports_conn, exclude_types=NON_ROTORCRAFT_EXCLUDED_AIRPORT_TYPES),
            max_distance_km=airport_match_radius_km,
        )

        self.states = self.load_states()
        self.pending_takeoffs = self.load_pending_takeoffs()
        self.processed_paths = self.load_processed_paths()
        self.inserted_events = 0
        self.parse_errors: list[str] = []
        self.files_processed = 0
        self.files_skipped = 0
        self.telemetry_rows = 0
        self.completed_pairs = 0
        self.pending_added = 0
        self.pending_completed = 0
        self.stale_segments = 0
        self.ground_splits = 0
        self._processed_batch: list[tuple[str, int, str]] = []

    def close(self) -> None:
        self.save_state()
        self.events_conn.close()
        self.state_conn.close()
        self.airports_conn.close()
        self.aircraft_conn.close()

    def load_states(self) -> dict[int, TrackState]:
        rows = self.state_conn.execute("SELECT * FROM track_states").fetchall()
        return {int(row["icao_id"]): TrackState.from_row(row) for row in rows}

    def load_pending_takeoffs(self) -> dict[int, PendingTakeoff]:
        rows = self.state_conn.execute("SELECT * FROM pending_takeoffs").fetchall()
        return {int(row["icao_id"]): PendingTakeoff.from_row(row) for row in rows}

    def load_processed_paths(self) -> set[str]:
        rows = self.state_conn.execute("SELECT path FROM processed_files").fetchall()
        return {row["path"] for row in rows}

    def airport_cache_for(self, state: TrackState) -> NearestAirportCache:
        return self.all_airports if state.is_rotorcraft else self.non_heliport_airports

    def choose_endpoint(self, state: TrackState, points: list[TrackPoint]) -> EndpointCandidate | None:
        airport_cache = self.airport_cache_for(state)
        best_point: TrackPoint | None = None
        best_airport: AirportEndpoint | None = None
        best_agl_ft: float | None = None
        best_confidence = 0.0
        best_score: float | None = None
        for point in points:
            airport = airport_cache.nearest(point.lat, point.lon)
            if airport is None:
                continue

            agl_ft = endpoint_agl(point, airport)
            low_enough = point.on_ground
            if agl_ft is not None and agl_ft <= self.max_airport_agl_ft:
                low_enough = True
            if point.alt_ft is not None and point.alt_ft <= self.fallback_low_alt_ft:
                low_enough = True
            if not low_enough:
                continue

            agl_score = 1.0 if agl_ft is None else max(0.0, min(1.0, 1.0 - agl_ft / self.max_airport_agl_ft))
            distance_score = max(0.0, min(1.0, 1.0 - airport.distance_km / self.airport_match_radius_km))
            ground_bonus = 0.15 if point.on_ground else 0.0
            confidence = min(1.0, 0.55 * distance_score + 0.35 * agl_score + ground_bonus)
            score = airport.distance_km + (agl_ft or 0.0) / 1800.0
            if best_score is None or score < best_score:
                best_point = point
                best_airport = airport
                best_agl_ft = agl_ft
                best_confidence = confidence
                best_score = score
        if best_point is None or best_airport is None or best_score is None:
            return None
        return EndpointCandidate(
            icao_id=state.icao_id,
            ts=best_point.ts,
            airport_id=best_airport.airport_id,
            airport_elevation_ft=best_airport.elevation_ft,
            confidence=best_confidence,
            score=best_score,
            agl_ft=best_agl_ft,
            segment_end_ts=state.segment_end_ts,
        )

    def infer_takeoff(self, state: TrackState) -> EndpointCandidate | None:
        if state.open_start or not state.first_points or state.max_altitude_ft is None:
            return None
        candidate = self.choose_endpoint(state, state.first_points)
        if candidate is None:
            return None
        endpoint_alt = endpoint_altitude_for(candidate, state.first_points)
        climbed = state.max_altitude_ft - endpoint_alt
        max_after = state.max_altitude_ts is None or state.max_altitude_ts >= candidate.ts
        if climbed >= self.min_climb_ft and max_after:
            return candidate
        return None

    def infer_landing(self, state: TrackState) -> EndpointCandidate | None:
        if not state.last_points or state.max_altitude_ft is None:
            return None
        candidate = self.choose_endpoint(state, state.last_points)
        if candidate is None:
            return None
        endpoint_alt = endpoint_altitude_for(candidate, state.last_points)
        descended = state.max_altitude_ft - endpoint_alt
        max_before = state.max_altitude_ts is None or state.max_altitude_ts <= candidate.ts
        near_segment_end = state.segment_end_ts - candidate.ts <= self.endpoint_window_seconds
        if descended >= self.min_climb_ft and max_before and near_segment_end:
            return candidate
        return None

    def finalise_segment(self, state: TrackState, landing: EndpointCandidate | None = None) -> None:
        duration = state.segment_end_ts - state.segment_start_ts
        if state.point_count < 3 or duration < self.min_segment_seconds or state.max_altitude_ft is None:
            return

        takeoff = self.infer_takeoff(state)
        if landing is None:
            landing = self.infer_landing(state)

        if takeoff is not None and landing is not None and self.insert_event(takeoff, landing):
            self.pending_takeoffs.pop(state.icao_id, None)
            self.completed_pairs += 1
            return

        if landing is not None:
            pending = self.pending_takeoffs.get(state.icao_id)
            if pending is not None and self.insert_pending_event(pending, landing):
                self.pending_takeoffs.pop(state.icao_id, None)
                self.completed_pairs += 1
                self.pending_completed += 1
                return

        if takeoff is not None:
            self.pending_takeoffs[state.icao_id] = PendingTakeoff(
                icao_id=state.icao_id,
                takeoff_ts=takeoff.ts,
                takeoff_airport_id=takeoff.airport_id,
                confidence=takeoff.confidence,
                segment_end_ts=state.segment_end_ts,
            )
            self.pending_added += 1

    def insert_pending_event(self, takeoff: PendingTakeoff, landing: EndpointCandidate) -> bool:
        if landing.ts <= takeoff.takeoff_ts:
            return False
        if landing.ts - takeoff.takeoff_ts > self.max_pending_seconds:
            return False
        before = self.events_conn.total_changes
        self.events_conn.execute(
            """
            INSERT OR IGNORE INTO events(icao_id, takeoff_ts, takeoff_airport_id, landing_ts, landing_airport_id)
            VALUES (?, ?, ?, ?, ?)
            """,
            (takeoff.icao_id, takeoff.takeoff_ts, takeoff.takeoff_airport_id, landing.ts, landing.airport_id),
        )
        inserted = self.events_conn.total_changes > before
        self.inserted_events += int(inserted)
        return inserted

    def insert_event(self, takeoff: EndpointCandidate, landing: EndpointCandidate) -> bool:
        if landing.ts <= takeoff.ts:
            return False
        if landing.ts - takeoff.ts > self.max_pending_seconds:
            return False
        before = self.events_conn.total_changes
        self.events_conn.execute(
            """
            INSERT OR IGNORE INTO events(icao_id, takeoff_ts, takeoff_airport_id, landing_ts, landing_airport_id)
            VALUES (?, ?, ?, ?, ?)
            """,
            (takeoff.icao_id, takeoff.ts, takeoff.airport_id, landing.ts, landing.airport_id),
        )
        inserted = self.events_conn.total_changes > before
        self.inserted_events += int(inserted)
        return inserted

    def flush_stale(self, current_ts: int) -> None:
        stale_ids = [icao_id for icao_id, state in self.states.items() if current_ts - state.last_seen_ts > self.max_gap_seconds]
        for icao_id in stale_ids:
            state = self.states.pop(icao_id)
            self.finalise_segment(state)
            self.stale_segments += 1
        self.prune_pending(current_ts)

    def maybe_split_ground_segment(self, state: TrackState, summary: AircraftFileSummary) -> bool:
        if not summary.last_on_ground or state.max_altitude_ts is None:
            return False
        if state.max_altitude_ts > summary.last_ts - self.endpoint_window_seconds:
            return False
        landing = self.infer_landing(state)
        if landing is None:
            return False
        self.finalise_segment(state, landing=landing)
        self.states.pop(state.icao_id, None)
        self.ground_splits += 1
        return True

    def prune_pending(self, current_ts: int) -> None:
        expired = [
            icao_id
            for icao_id, pending in self.pending_takeoffs.items()
            if current_ts - pending.takeoff_ts > self.max_pending_seconds
        ]
        for icao_id in expired:
            self.pending_takeoffs.pop(icao_id, None)

    def process_file(self, path: Path, open_start_cutoff_ts: int | None = None) -> None:
        path_key = str(path)
        if path_key in self.processed_paths:
            self.files_skipped += 1
            return

        slot_ts = slot_timestamp_from_path(path)
        try:
            summaries = summarize_heatmap_file(path)
        except Exception as error:
            self.parse_errors.append(f"{path}: {error}")
            summaries = []

        last_observed_ts = slot_ts + 1800
        if summaries:
            last_observed_ts = max(summary.last_ts for summary in summaries)

        for summary in summaries:
            self.telemetry_rows += summary.point_count
            state = self.states.get(summary.icao_id)
            if state is not None and summary.first_ts - state.last_seen_ts > self.max_gap_seconds:
                self.states.pop(summary.icao_id, None)
                self.finalise_segment(state)
                self.stale_segments += 1
                state = None

            if state is None:
                state = TrackState(
                    icao_id=summary.icao_id,
                    is_rotorcraft=summary.icao_id in self.rotorcraft_ids,
                    segment_start_ts=summary.first_ts,
                    segment_end_ts=summary.last_ts,
                    last_seen_ts=summary.last_ts,
                    source_first_file=str(path),
                    source_last_file=str(path),
                    open_start=open_start_cutoff_ts is not None and summary.first_ts <= open_start_cutoff_ts,
                )
                self.states[summary.icao_id] = state

            state.add_summary(summary, path, self.endpoint_window_seconds)
            self.maybe_split_ground_segment(state, summary)

        self.flush_stale(last_observed_ts)
        processed_at = dt.datetime.now(dt.timezone.utc).isoformat()
        self._processed_batch.append((path_key, slot_ts, processed_at))
        self.processed_paths.add(path_key)
        self.files_processed += 1

    def save_state(self) -> None:
        with self.state_conn:
            self.state_conn.execute("DELETE FROM track_states")
            self.state_conn.executemany(
                """
                INSERT INTO track_states(
                    icao_id, is_rotorcraft, segment_start_ts, segment_end_ts, last_seen_ts,
                    first_points_json, last_points_json, point_count, max_altitude_ft,
                    max_altitude_ts, source_first_file, source_last_file, open_start
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                """,
                [state.to_row() for state in self.states.values()],
            )
            self.state_conn.execute("DELETE FROM pending_takeoffs")
            self.state_conn.executemany(
                """
                INSERT INTO pending_takeoffs(
                    icao_id, takeoff_ts, takeoff_airport_id, confidence, segment_end_ts
                ) VALUES (?, ?, ?, ?, ?)
                """,
                [pending.to_row() for pending in self.pending_takeoffs.values()],
            )
            if self._processed_batch:
                self.state_conn.executemany(
                    """
                    INSERT OR IGNORE INTO processed_files(path, slot_ts, processed_at)
                    VALUES (?, ?, ?)
                    """,
                    self._processed_batch,
                )
                self._processed_batch.clear()
            set_meta(self.state_conn, "active_track_states", str(len(self.states)))
            set_meta(self.state_conn, "pending_takeoffs", str(len(self.pending_takeoffs)))
        self.events_conn.commit()

    def run(
        self,
        files: list[Path],
        start_ts: int | None = None,
        commit_every: int = 50,
        progress_every: int = 25,
    ) -> dict:
        started = time.perf_counter()
        open_start_cutoff_ts = None
        if not self.processed_paths and start_ts is not None:
            open_start_cutoff_ts = start_ts + self.max_gap_seconds

        for index, path in enumerate(files, start=1):
            self.process_file(path, open_start_cutoff_ts=open_start_cutoff_ts)
            if index % commit_every == 0:
                self.save_state()
            if progress_every and index % progress_every == 0:
                elapsed = time.perf_counter() - started
                print(
                    "Processed "
                    f"{index:,}/{len(files):,} selected files "
                    f"({self.files_processed:,} new, {self.files_skipped:,} skipped), "
                    f"{self.inserted_events:,} inserted events, "
                    f"{len(self.states):,} active tracks, "
                    f"{len(self.pending_takeoffs):,} pending takeoffs, "
                    f"{elapsed:.1f}s",
                    flush=True,
                )

        self.save_state()
        elapsed = time.perf_counter() - started
        latest_row = self.events_conn.execute(
            "SELECT MIN(takeoff_ts) AS min_ts, MAX(landing_ts) AS max_ts, COUNT(*) AS count FROM events"
        ).fetchone()
        details = {
            "selected_files": len(files),
            "files_processed": self.files_processed,
            "files_skipped": self.files_skipped,
            "telemetry_rows": self.telemetry_rows,
            "inserted_events": self.inserted_events,
            "completed_pairs": self.completed_pairs,
            "pending_added": self.pending_added,
            "pending_completed": self.pending_completed,
            "active_track_states": len(self.states),
            "pending_takeoffs": len(self.pending_takeoffs),
            "stale_segments": self.stale_segments,
            "ground_splits": self.ground_splits,
            "parse_error_count": len(self.parse_errors),
            "parse_errors": self.parse_errors[:20],
            "elapsed_seconds": elapsed,
            "seconds_per_selected_file": elapsed / len(files) if files else None,
            "event_count": int(latest_row["count"] or 0),
            "min_takeoff_ts": int(latest_row["min_ts"]) if latest_row["min_ts"] is not None else None,
            "max_landing_ts": int(latest_row["max_ts"]) if latest_row["max_ts"] is not None else None,
        }
        with self.events_conn:
            set_meta(self.events_conn, "last_build_details", json.dumps(details, sort_keys=True))
            if details["min_takeoff_ts"] is not None:
                set_meta(self.events_conn, "min_takeoff_ts", str(details["min_takeoff_ts"]))
            if details["max_landing_ts"] is not None:
                set_meta(self.events_conn, "max_landing_ts", str(details["max_landing_ts"]))
            set_meta(self.events_conn, "event_count", str(details["event_count"]))
        return details


def endpoint_agl(point: TrackPoint, airport: AirportEndpoint) -> float | None:
    if point.on_ground:
        return 0.0
    if point.alt_ft is not None and airport.elevation_ft is not None:
        return max(0.0, point.alt_ft - airport.elevation_ft)
    if point.alt_ft is not None:
        return point.alt_ft
    return None


def endpoint_altitude_for(candidate: EndpointCandidate, points: list[TrackPoint]) -> float:
    for point in points:
        if point.ts == candidate.ts and point.alt_ft is not None:
            return point.alt_ft
    return candidate.airport_elevation_ft or 0.0


def parse_time_arg(value: str | None) -> int | None:
    if value is None:
        return None
    text = value.strip()
    if "T" in text:
        parsed = dt.datetime.fromisoformat(text.replace("Z", "+00:00"))
        if parsed.tzinfo is None:
            parsed = parsed.replace(tzinfo=dt.timezone.utc)
        return int(parsed.astimezone(dt.timezone.utc).timestamp())
    parsed_date = dt.date.fromisoformat(text)
    return int(dt.datetime(parsed_date.year, parsed_date.month, parsed_date.day, tzinfo=dt.timezone.utc).timestamp())


def remove_sqlite_family(path: Path) -> None:
    for candidate in (path, Path(f"{path}-wal"), Path(f"{path}-shm")):
        try:
            candidate.unlink()
        except FileNotFoundError:
            pass


def build_events_from_args(args: argparse.Namespace) -> dict:
    if args.reset:
        remove_sqlite_family(args.events_db)
        remove_sqlite_family(args.state_db)

    start_ts = parse_time_arg(args.start)
    end_ts = parse_time_arg(args.end)
    files = iter_heatmap_files(args.cache_dir, start_ts=start_ts, end_ts=end_ts)
    if args.max_files:
        files = files[: args.max_files]
    if not files:
        raise FileNotFoundError("No ADS-B Exchange heatmap files matched the requested range.")

    builder = EventBuilder(
        events_db=args.events_db,
        airports_db=args.airports_db,
        aircraft_db=args.aircraft_db,
        state_db=args.state_db,
        max_gap_minutes=args.max_gap_minutes,
        endpoint_window_minutes=args.endpoint_window_minutes,
        min_segment_seconds=args.min_segment_seconds,
        min_climb_ft=args.min_climb_ft,
        max_airport_agl_ft=args.max_airport_agl_ft,
        fallback_low_alt_ft=args.fallback_low_alt_ft,
        airport_match_radius_km=args.airport_match_radius_km,
        max_pending_hours=args.max_pending_hours,
    )
    try:
        details = builder.run(
            files,
            start_ts=start_ts,
            commit_every=args.commit_every,
            progress_every=args.progress_every,
        )
    finally:
        builder.close()

    if args.vacuum:
        vacuum(args.events_db)
        vacuum(args.state_db)
    return details


def add_build_events_parser(subparsers) -> None:
    parser = subparsers.add_parser("build-events", help="Build or update paired takeoff/landing events")
    parser.add_argument("--cache-dir", type=Path, default=ADSBX_CACHE_DIR)
    parser.add_argument("--events-db", type=Path, default=EVENTS_DB)
    parser.add_argument("--airports-db", type=Path, default=AIRPORTS_DB)
    parser.add_argument("--aircraft-db", type=Path, default=AIRCRAFT_DB)
    parser.add_argument("--state-db", type=Path, default=STATE_DB)
    parser.add_argument("--start")
    parser.add_argument("--end")
    parser.add_argument("--max-files", type=int)
    parser.add_argument("--reset", action="store_true")
    parser.add_argument("--vacuum", action="store_true")
    parser.add_argument("--commit-every", type=int, default=50)
    parser.add_argument("--progress-every", type=int, default=25)
    parser.add_argument("--max-gap-minutes", type=float, default=20.0)
    parser.add_argument("--endpoint-window-minutes", type=float, default=8.0)
    parser.add_argument("--min-segment-seconds", type=float, default=120.0)
    parser.add_argument("--min-climb-ft", type=float, default=1500.0)
    parser.add_argument("--max-airport-agl-ft", type=float, default=1500.0)
    parser.add_argument("--fallback-low-alt-ft", type=float, default=1500.0)
    parser.add_argument("--airport-match-radius-km", type=float, default=12.0)
    parser.add_argument("--max-pending-hours", type=float, default=30.0)
    parser.set_defaults(func=build_events_from_args)


def env_threads() -> None:
    os.environ.setdefault("OPENBLAS_NUM_THREADS", "1")
    os.environ.setdefault("MKL_NUM_THREADS", "1")
