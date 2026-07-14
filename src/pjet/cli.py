from __future__ import annotations

import argparse
import json
from pathlib import Path

from .aircraft import import_aircraft
from .airports import import_airports
from .builder import add_build_events_parser, env_threads
from .paths import AIRCRAFT_DB, AIRPORTS_CSV, AIRPORTS_DB, FAA_ZIP


def import_airports_from_args(args: argparse.Namespace) -> dict:
    return import_airports(db_path=args.db, csv_path=args.csv, refresh=args.refresh)


def import_aircraft_from_args(args: argparse.Namespace) -> dict:
    return import_aircraft(
        db_path=args.db,
        faa_zip=args.faa_zip,
        adsbx_path=args.adsbx_basic_db,
        tar1090_path=args.tar1090_db,
        opensky_path=args.opensky_csv,
    )


def main(argv: list[str] | None = None) -> None:
    env_threads()
    parser = argparse.ArgumentParser(prog="pjet")
    subparsers = parser.add_subparsers(dest="command", required=True)

    airports_parser = subparsers.add_parser("import-airports", help="Import compact airport lookup database")
    airports_parser.add_argument("--db", type=Path, default=AIRPORTS_DB)
    airports_parser.add_argument("--csv", type=Path, default=AIRPORTS_CSV)
    airports_parser.add_argument("--refresh", action="store_true")
    airports_parser.set_defaults(func=import_airports_from_args)

    aircraft_parser = subparsers.add_parser("import-aircraft", help="Import compact aircraft lookup database")
    aircraft_parser.add_argument("--db", type=Path, default=AIRCRAFT_DB)
    aircraft_parser.add_argument("--faa-zip", type=Path, default=FAA_ZIP)
    aircraft_parser.add_argument("--adsbx-basic-db", type=Path, default=None)
    aircraft_parser.add_argument("--tar1090-db", type=Path, default=None)
    aircraft_parser.add_argument("--opensky-csv", type=Path, default=None)
    aircraft_parser.set_defaults(func=import_aircraft_from_args)

    add_build_events_parser(subparsers)

    args = parser.parse_args(argv)

    if args.command == "import-aircraft":
        from .paths import ADSBX_BASIC_AIRCRAFT_DB, OPENSKY_AIRCRAFT_DB, TAR1090_AIRCRAFT_DB

        args.adsbx_basic_db = args.adsbx_basic_db or ADSBX_BASIC_AIRCRAFT_DB
        args.tar1090_db = args.tar1090_db or TAR1090_AIRCRAFT_DB
        args.opensky_csv = args.opensky_csv or OPENSKY_AIRCRAFT_DB

    result = args.func(args)
    print(json.dumps(result, indent=2, sort_keys=True))


if __name__ == "__main__":
    main()
