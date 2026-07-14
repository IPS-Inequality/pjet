from __future__ import annotations

import datetime as dt
from dataclasses import dataclass
from pathlib import Path

import numpy as np


SLICE_BEGIN_MARKER = 0x0E7F7C9D
MAX_ICAO_ID = 0xFFFFFF


@dataclass(frozen=True)
class AircraftFileSummary:
    icao_id: int
    first_ts: int
    first_lat: float
    first_lon: float
    first_alt_ft: float | None
    first_on_ground: bool
    last_ts: int
    last_lat: float
    last_lon: float
    last_alt_ft: float | None
    last_on_ground: bool
    max_altitude_ft: float | None
    max_altitude_ts: int | None
    point_count: int


def icao_to_hex(icao_id: int) -> str:
    return f"{icao_id & MAX_ICAO_ID:06x}"


def hex_to_icao(value: str) -> int:
    return int(value.strip().lower().removeprefix("~"), 16)


def slot_timestamp_from_path(path: Path) -> int:
    slot = int(path.stem.split(".")[0])
    day = int(path.parent.name)
    month = int(path.parent.parent.name)
    year = int(path.parent.parent.parent.name)
    timestamp = dt.datetime(year, month, day, tzinfo=dt.timezone.utc) + dt.timedelta(minutes=slot * 30)
    return int(timestamp.timestamp())


def heatmap_path_for(cache_dir: Path, timestamp: int) -> Path:
    value = dt.datetime.fromtimestamp(timestamp, tz=dt.timezone.utc)
    slot = value.hour * 2 + value.minute // 30
    return cache_dir / f"{value.year:04d}" / f"{value.month:02d}" / f"{value.day:02d}" / f"{slot:02d}.bin.ttf"


def floor_to_slot(timestamp: int) -> int:
    return timestamp - (timestamp % 1800)


def iter_heatmap_files(
    cache_dir: Path,
    start_ts: int | None = None,
    end_ts: int | None = None,
) -> list[Path]:
    if start_ts is not None and end_ts is not None:
        files = []
        cursor = floor_to_slot(start_ts)
        if cursor < start_ts:
            cursor += 1800
        while cursor < end_ts:
            path = heatmap_path_for(cache_dir, cursor)
            if path.exists():
                files.append(path)
            cursor += 1800
        return files

    selected: list[tuple[int, Path]] = []
    for path in cache_dir.rglob("*.bin.ttf"):
        try:
            slot_ts = slot_timestamp_from_path(path)
        except (ValueError, IndexError):
            continue
        if start_ts is not None and slot_ts < start_ts:
            continue
        if end_ts is not None and slot_ts >= end_ts:
            continue
        selected.append((slot_ts, path))
    return [path for _, path in sorted(selected)]


def latest_heatmap_file(cache_dir: Path) -> Path | None:
    years = sorted((path for path in cache_dir.iterdir() if path.is_dir() and path.name.isdigit()), reverse=True)
    for year_dir in years:
        months = sorted((path for path in year_dir.iterdir() if path.is_dir() and path.name.isdigit()), reverse=True)
        for month_dir in months:
            days = sorted((path for path in month_dir.iterdir() if path.is_dir() and path.name.isdigit()), reverse=True)
            for day_dir in days:
                slots = sorted(day_dir.glob("*.bin.ttf"), reverse=True)
                for slot_path in slots:
                    try:
                        slot_timestamp_from_path(slot_path)
                    except (ValueError, IndexError):
                        continue
                    return slot_path
    return None


def summarize_heatmap_file(filename: str | Path) -> list[AircraftFileSummary]:
    with open(filename, "rb") as file_handle:
        raw = file_handle.read()

    points_u8 = np.frombuffer(raw, dtype=np.uint8)
    points_i = points_u8.view(np.int32)
    points_u = points_u8.view(np.uint32)
    marker_indices = np.flatnonzero(points_i == SLICE_BEGIN_MARKER)
    if marker_indices.size == 0:
        return []

    id_parts = []
    time_parts = []
    lat_parts = []
    lon_parts = []
    alt_parts = []
    ground_parts = []

    for marker_offset, marker_index in enumerate(marker_indices):
        block_start = int(marker_index) + 4
        block_end = int(marker_indices[marker_offset + 1]) if marker_offset + 1 < marker_indices.size else len(points_i)
        record_words = ((block_end - block_start) // 4) * 4
        if record_words <= 0:
            continue

        now = points_u[marker_index + 2] / 1000 + points_u[marker_index + 1] * 4294967.296
        block_i = points_i[block_start : block_start + record_words].reshape(-1, 4)
        block_u = points_u[block_start : block_start + record_words].reshape(-1, 4)

        telemetry_mask = block_i[:, 1] <= 1073741824
        if not np.any(telemetry_mask):
            continue

        telemetry_i = block_i[telemetry_mask]
        telemetry_u = block_u[telemetry_mask]
        point_ids = telemetry_u[:, 0] & 0x1FFFFFF
        icao_mask = point_ids <= MAX_ICAO_ID
        if not np.any(icao_mask):
            continue

        telemetry_i = telemetry_i[icao_mask]
        point_ids = point_ids[icao_mask]
        lat = telemetry_i[:, 1].astype(np.float32) / 1e6
        lon = telemetry_i[:, 2].astype(np.float32) / 1e6

        alt_raw = (telemetry_i[:, 3] & 65535).astype(np.int32)
        alt_signed = np.where((alt_raw & 32768) != 0, alt_raw | -65536, alt_raw)
        on_ground = alt_signed == -123
        alt = alt_signed.astype(np.float32) * 25.0
        alt[on_ground] = np.nan

        id_parts.append(point_ids.astype(np.uint32))
        time_parts.append(np.full(point_ids.shape, now, dtype=np.float64))
        lat_parts.append(lat)
        lon_parts.append(lon)
        alt_parts.append(alt)
        ground_parts.append(on_ground)

    if not id_parts:
        return []

    ids = np.concatenate(id_parts)
    times = np.concatenate(time_parts)
    lats = np.concatenate(lat_parts)
    lons = np.concatenate(lon_parts)
    alts = np.concatenate(alt_parts)
    grounds = np.concatenate(ground_parts)

    order = np.argsort(ids, kind="stable")
    sorted_ids = ids[order]
    starts = np.r_[0, np.flatnonzero(sorted_ids[1:] != sorted_ids[:-1]) + 1]
    ends = np.r_[starts[1:], sorted_ids.size]

    summaries: list[AircraftFileSummary] = []
    sorted_alts = alts[order]
    for start, end in zip(starts, ends, strict=False):
        group_order = order[start:end]
        first = int(group_order[0])
        last = int(group_order[-1])
        group_alts = sorted_alts[start:end]
        finite_alt_mask = np.isfinite(group_alts)
        if np.any(finite_alt_mask):
            finite_indices = np.flatnonzero(finite_alt_mask)
            max_relative = int(finite_indices[np.argmax(group_alts[finite_alt_mask])])
            max_index = int(group_order[max_relative])
            max_altitude = float(alts[max_index])
            max_ts = int(round(float(times[max_index])))
        else:
            max_altitude = None
            max_ts = None

        point_id = int(sorted_ids[start])
        summaries.append(
            AircraftFileSummary(
                icao_id=point_id,
                first_ts=int(round(float(times[first]))),
                first_lat=float(lats[first]),
                first_lon=float(lons[first]),
                first_alt_ft=None if not np.isfinite(alts[first]) else float(alts[first]),
                first_on_ground=bool(grounds[first]),
                last_ts=int(round(float(times[last]))),
                last_lat=float(lats[last]),
                last_lon=float(lons[last]),
                last_alt_ft=None if not np.isfinite(alts[last]) else float(alts[last]),
                last_on_ground=bool(grounds[last]),
                max_altitude_ft=max_altitude,
                max_altitude_ts=max_ts,
                point_count=int(end - start),
            )
        )

    return summaries
