from __future__ import annotations

import argparse
import csv
import datetime as dt
import math
import sqlite3
import urllib.request
from collections import defaultdict
from dataclasses import dataclass
from pathlib import Path

from .paths import AIRPORTS_CSV, AIRPORTS_DB
from .schema import AIRPORTS_SCHEMA, connect, set_meta, vacuum


AIRPORTS_URL = "https://davidmegginson.github.io/ourairports-data/airports.csv"
AIRPORTS_SOURCE_PAGE = "https://ourairports.com/data/"
CLOSED_TYPES = {"closed", "closed_airport"}


@dataclass(frozen=True)
class Airport:
    airport_id: int
    code: str
    name: str
    airport_type: str
    lat: float
    lon: float
    elevation_ft: float | None
    cos_lat_rad: float
    distance_km: float = 0.0


@dataclass(frozen=True)
class AirportEndpoint:
    airport_id: int
    airport_type: str
    elevation_ft: float | None
    distance_km: float


class AirportIndex:
    def __init__(self, airports: list[Airport], cell_degrees: float = 0.1) -> None:
        self.airports = airports
        self.cell_degrees = cell_degrees
        self.grid: dict[tuple[int, int], list[Airport]] = defaultdict(list)
        for airport in airports:
            self.grid[self.cell_for(airport.lat, airport.lon)].append(airport)

    @classmethod
    def from_db(cls, connection: sqlite3.Connection, exclude_types: set[str] | None = None) -> "AirportIndex":
        exclude_types = {value.lower() for value in (exclude_types or set())}
        rows = connection.execute(
            """
            SELECT a.airport_id, a.code, a.name, a.lat_e7, a.lon_e7, a.elevation_ft, t.label AS airport_type
            FROM airports a
            JOIN airport_types t ON t.airport_type_id = a.airport_type_id
            ORDER BY a.airport_id
            """
        ).fetchall()
        airports = [
            Airport(
                airport_id=int(row["airport_id"]),
                code=row["code"],
                name=row["name"],
                airport_type=row["airport_type"],
                lat=int(row["lat_e7"]) / 1e7,
                lon=int(row["lon_e7"]) / 1e7,
                elevation_ft=float(row["elevation_ft"]) if row["elevation_ft"] is not None else None,
                cos_lat_rad=math.cos(math.radians(int(row["lat_e7"]) / 1e7)),
            )
            for row in rows
            if row["airport_type"].lower() not in CLOSED_TYPES
            and row["airport_type"].lower() not in exclude_types
        ]
        return cls(airports)

    def cell_for(self, lat: float, lon: float) -> tuple[int, int]:
        return (math.floor(lat / self.cell_degrees), math.floor(lon / self.cell_degrees))

    def nearest(self, lat: float, lon: float, max_distance_km: float) -> AirportEndpoint | None:
        lat_radius = max_distance_km / 111.0
        phi1 = math.radians(lat)
        cos_phi1 = math.cos(phi1)
        cos_lat = max(0.15, abs(cos_phi1))
        lon_radius = max_distance_km / (111.0 * cos_lat)
        min_cell = self.cell_for(lat - lat_radius, lon - lon_radius)
        max_cell = self.cell_for(lat + lat_radius, lon + lon_radius)
        best: AirportEndpoint | None = None
        for lat_cell in range(min_cell[0], max_cell[0] + 1):
            for lon_cell in range(min_cell[1], max_cell[1] + 1):
                for airport in self.grid.get((lat_cell, lon_cell), ()):
                    distance = haversine_from_query_km(lat, lon, cos_phi1, airport)
                    if distance <= max_distance_km and (best is None or distance < best.distance_km):
                        best = AirportEndpoint(
                            airport_id=airport.airport_id,
                            airport_type=airport.airport_type,
                            elevation_ft=airport.elevation_ft,
                            distance_km=distance,
                        )
        return best


class NearestAirportCache:
    def __init__(self, index: AirportIndex, max_distance_km: float) -> None:
        self.index = index
        self.max_distance_km = max_distance_km
        self.cache: dict[tuple[int, int], AirportEndpoint | None] = {}

    def nearest(self, lat: float, lon: float) -> AirportEndpoint | None:
        key = (round(lat, 3), round(lon, 3))
        if key not in self.cache:
            self.cache[key] = self.index.nearest(lat, lon, self.max_distance_km)
        return self.cache[key]


def download_airports(destination: Path = AIRPORTS_CSV, refresh: bool = False) -> Path:
    destination.parent.mkdir(parents=True, exist_ok=True)
    if destination.exists() and not refresh:
        return destination

    request = urllib.request.Request(AIRPORTS_URL, headers={"User-Agent": "pjet/0.1"})
    with urllib.request.urlopen(request, timeout=120) as response:
        destination.write_bytes(response.read())
    return destination


def parse_float(value: str | None) -> float | None:
    value = (value or "").strip()
    if not value:
        return None
    try:
        return float(value)
    except ValueError:
        return None


def parse_int(value: str | None) -> int | None:
    parsed = parse_float(value)
    return None if parsed is None else int(round(parsed))


def import_airports(db_path: Path = AIRPORTS_DB, csv_path: Path = AIRPORTS_CSV, refresh: bool = False) -> dict:
    csv_path = download_airports(csv_path, refresh=refresh)
    airport_rows = []
    type_labels: dict[str, int] = {}

    with csv_path.open("r", encoding="utf-8-sig", newline="") as file_handle:
        reader = csv.DictReader(file_handle)
        for row in reader:
            code = (row.get("ident") or "").strip()
            name = (row.get("name") or "").strip()
            airport_type = (row.get("type") or "").strip().lower()
            lat = parse_float(row.get("latitude_deg"))
            lon = parse_float(row.get("longitude_deg"))
            if not code or not name or not airport_type or lat is None or lon is None:
                continue
            if airport_type not in type_labels:
                type_labels[airport_type] = len(type_labels) + 1
            airport_rows.append(
                (
                    code,
                    name,
                    int(round(lat * 1e7)),
                    int(round(lon * 1e7)),
                    type_labels[airport_type],
                    parse_int(row.get("elevation_ft")),
                )
            )

    airport_rows.sort(key=lambda item: item[0])
    rows_with_ids = [(index, *row) for index, row in enumerate(airport_rows, start=1)]
    type_rows = [(type_id, label) for label, type_id in sorted(type_labels.items(), key=lambda item: item[1])]

    connection = connect(db_path, AIRPORTS_SCHEMA)
    try:
        with connection:
            connection.execute("DELETE FROM airports")
            connection.execute("DELETE FROM airport_types")
            connection.executemany("INSERT INTO airport_types(airport_type_id, label) VALUES (?, ?)", type_rows)
            connection.executemany(
                """
                INSERT INTO airports(airport_id, code, name, lat_e7, lon_e7, airport_type_id, elevation_ft)
                VALUES (?, ?, ?, ?, ?, ?, ?)
                """,
                rows_with_ids,
            )
            set_meta(connection, "airports_source_url", AIRPORTS_URL)
            set_meta(connection, "airports_source_page", AIRPORTS_SOURCE_PAGE)
            set_meta(connection, "airports_csv_path", str(csv_path))
            set_meta(connection, "airports_imported_at", dt.datetime.now(dt.timezone.utc).isoformat())
            set_meta(connection, "airports_count", str(len(rows_with_ids)))
    finally:
        connection.close()
    vacuum(db_path)
    return {"airports": len(rows_with_ids), "airport_types": len(type_rows), "db_path": str(db_path)}


def haversine_km(lat1: float, lon1: float, lat2: float, lon2: float) -> float:
    radius_km = 6371.0088
    phi1 = math.radians(lat1)
    phi2 = math.radians(lat2)
    d_phi = math.radians(lat2 - lat1)
    d_lambda = math.radians(lon2 - lon1)
    a = math.sin(d_phi / 2) ** 2 + math.cos(phi1) * math.cos(phi2) * math.sin(d_lambda / 2) ** 2
    return 2 * radius_km * math.atan2(math.sqrt(a), math.sqrt(1 - a))


def haversine_from_query_km(lat: float, lon: float, cos_phi1: float, airport: Airport) -> float:
    radius_km = 6371.0088
    d_phi = math.radians(airport.lat - lat)
    d_lambda = math.radians(airport.lon - lon)
    a = math.sin(d_phi / 2) ** 2 + cos_phi1 * airport.cos_lat_rad * math.sin(d_lambda / 2) ** 2
    return 2 * radius_km * math.atan2(math.sqrt(a), math.sqrt(1 - a))


def main(argv: list[str] | None = None) -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--db", type=Path, default=AIRPORTS_DB)
    parser.add_argument("--csv", type=Path, default=AIRPORTS_CSV)
    parser.add_argument("--refresh", action="store_true")
    args = parser.parse_args(argv)
    print(import_airports(args.db, args.csv, args.refresh))


if __name__ == "__main__":
    main()
