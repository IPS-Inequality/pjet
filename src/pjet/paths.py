from __future__ import annotations

import os
from pathlib import Path


REPO_ROOT = Path(__file__).resolve().parents[2]


def env_path(name: str, default: Path) -> Path:
    """Return a configurable path without baking a workstation layout into the code."""
    value = os.environ.get(name)
    return Path(value).expanduser() if value else default


# Project-local data is the safe default. A full cache is usually kept on an external
# volume; set PJET_DATA_DIR and/or the more specific PJET_*_DIR variables for that.
DATA_DIR = env_path("PJET_DATA_DIR", REPO_ROOT / "data")
DB_DIR = env_path("PJET_DB_DIR", DATA_DIR / "pjet")
ADSBX_CACHE_DIR = env_path("PJET_ADSBX_CACHE_DIR", DATA_DIR / "adsbx")
AIRCRAFT_CACHE_DIR = env_path("PJET_AIRCRAFT_CACHE_DIR", DATA_DIR / "aircraft")
FAA_ZIP = env_path("PJET_FAA_ZIP", DATA_DIR / "faa" / "ReleasableAircraft.zip")

EVENTS_DB = DB_DIR / "events.sqlite"
AIRPORTS_DB = DB_DIR / "airports.sqlite"
AIRCRAFT_DB = DB_DIR / "aircraft.sqlite"
STATE_DB = DB_DIR / "build_state.sqlite"

REFERENCE_DIR = DB_DIR / "reference"
AIRPORTS_CSV = REFERENCE_DIR / "ourairports-airports.csv"
ADSBX_BASIC_AIRCRAFT_DB = AIRCRAFT_CACHE_DIR / "basic-ac-db.json.gz"
TAR1090_AIRCRAFT_DB = AIRCRAFT_CACHE_DIR / "tar1090-aircraft.csv.gz"
OPENSKY_AIRCRAFT_DB = AIRCRAFT_CACHE_DIR / "opensky-aircraft-database.csv"


def ensure_parent(path: Path) -> Path:
    path.parent.mkdir(parents=True, exist_ok=True)
    return path


def ensure_db_dir(db_dir: Path = DB_DIR) -> Path:
    db_dir.mkdir(parents=True, exist_ok=True)
    return db_dir
