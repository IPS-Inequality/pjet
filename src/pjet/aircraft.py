from __future__ import annotations

import argparse
import csv
import gzip
import io
import json
import re
import sqlite3
import zipfile
from dataclasses import dataclass
from pathlib import Path

from .heatmap import hex_to_icao
from .paths import (
    ADSBX_BASIC_AIRCRAFT_DB,
    AIRCRAFT_DB,
    FAA_ZIP,
    OPENSKY_AIRCRAFT_DB,
    TAR1090_AIRCRAFT_DB,
)
from .schema import AIRCRAFT_SCHEMA, connect, set_meta, vacuum


SOURCE_FAA = 1
SOURCE_ADSBX = 2
SOURCE_TAR1090 = 4
SOURCE_OPENSKY = 8

TYPE_AIRCRAFT = {
    "1": "glider",
    "2": "balloon",
    "3": "blimp",
    "4": "fixed_wing_single_engine",
    "5": "fixed_wing_multi_engine",
    "6": "helicopter",
    "7": "weight_shift_control",
    "8": "powered_parachute",
    "9": "gyroplane",
    "H": "hybrid_lift",
    "O": "other",
}

TYPE_REGISTRANT = {
    "1": "individual",
    "2": "partnership",
    "3": "corporation",
    "4": "co_owned",
    "5": "government",
    "7": "llc",
    "8": "non_citizen_corporation",
    "9": "non_citizen_co_owned",
}

TYPE_ENGINE = {
    "0": "none",
    "1": "reciprocating",
    "01": "reciprocating",
    "2": "turboprop",
    "3": "turboshaft",
    "4": "turbojet",
    "5": "turbofan",
    "6": "ramjet",
    "7": "two_cycle",
    "8": "four_cycle",
    "9": "unknown",
    "10": "electric",
    "11": "rotary",
}

AIRLINER_PATTERNS = (
    r"\bA(?:19N|20N|21N|318|319|320|321|332|333|338|339|342|343|346|359|35K|388)\b",
    r"\bA\s?(?:220|300|310|318|319|320|321|330|340|350|380)[A-Z0-9]*\b",
    r"\bAIRBUS\b.*\b(?:220|300|310|318|319|320|321|330|340|350|380)[A-Z0-9]*\b",
    r"\b(?:CS|BCS)\s?(?:100|300|1|3)\b",
    r"\bBD\s?500\s?1A1[01]\b",
    r"\bB(?:37M|38M|39M|3M[89]|3[0-9A-Z]{2}|7(?:0[237]|1[237]|2[237]|3[0-9A-Z]|4[0-9A-Z]|5[0-9A-Z]|6[0-9A-Z]|7[0-9A-Z]|8[0-9A-Z]))\b",
    r"\b7(?:07|17|27|37|47|57|67|77|87)[A-Z0-9]*\b",
    r"\b737\s?MAX\b",
    r"\b(?:DC|MD)\s?(?:8|9|10|11|8[0-9]|9[0-9])\b",
    r"\b(?:E|EJET)\s?(?:170|175|190|195)(?:\s?E2)?\b",
    r"\bERJ\s?(?:135|140|145|170|175|190|195)\b",
    r"\bEMB\s?135(?!\s?(?:BJ|KL|LEGACY))\b",
    r"\bEMB\s?(?:145|170|175|190|195)\b",
    r"\bEMBRAER\b.*\b(?:145|170|175|190|195)\b",
    r"\bCRJ\s?(?:100|200|440|550|700|701|702|705|850|900|1000)\b",
    r"\bREGIONAL\s?JET\b",
    r"\bCL\s?600\s?2(?:B19|C10|D15|D24)\b",
    r"\bFOKKER\b|\bF28\b|\bF70\b|\bF100\b",
    r"\bBAE\s?146\b|\bAVRO\b|\bRJ(?:70|85|100)\b",
    r"\bSSJ\b|\bSUKHOI\b|\bCOMAC\b|\bARJ\s?21\b|\bC919\b",
    r"\bDORNIER\s?328\b|\bDO\s?328\b|\b328\s?300\b",
)

BUSINESS_AIRLINER_DERIVATIVE_PATTERNS = (
    r"\bBBJ\b",
    r"\bBOEING\s?BUSINESS\s?JET\b",
    r"\bACJ\b",
    r"\bAIRBUS\s?CORPORATE\s?JET\b",
)

BUSINESS_JET_PATTERNS = (
    r"\bCITATION\b",
    r"\bCE\s?(?:500|501|510|525|550|560|650|680|700|750)\b",
    r"\b(?:CESSNA|TEXTRON)\b.*\b(?:500|501|510|525|525A|525B|525C|550|551|S550|560|560XL|560XLS|650|680|680A|700|750)\b",
    r"\bGULFSTREAM\b",
    r"\bG\s?(?:II|III|IV|V|VI|100|150|200|280|300|350|400|450|500|550|600|650|700|800)\b",
    r"\bFALCON\b",
    r"\bCHALLENGER\b",
    r"\bGLOBAL\b(?!\s?RANGER)",
    r"\bBD\s?(?:100|700)\b",
    r"\bCL\s?600\s?(?:1A11|2A12|2B16)\b",
    r"\bCL\s?(?:601|604|605|650)\b",
    r"\bLEAR(?:JET)?\b",
    r"\bHAWKER\b",
    r"\bBEECHJET\b",
    r"\b400(?:A|XP)\b(?!.*(?:BALLOON|AIRSHIP))",
    r"\bPREMIER\s?(?:1A?|IA?|II)\b",
    r"\b(?:BEECH|RAYTHEON|HAWKER|TEXTRON)\b.*\bPREMIER\b",
    r"\bPHENOM\b",
    r"\bEMB\s?(?:500|505|545|550)\b",
    r"\bEMBRAER\b.*\b(?:500|505|545|550)\b",
    r"\bLEGACY\s?(?:450|500|600|650)\b",
    r"\bEMBRAER\b.*\bLEGACY\b",
    r"\bPRAETOR\b",
    r"\bEMB\s?135\s?(?:BJ|KL)\b",
    r"\bHONDAJET\b",
    r"\bHA\s?420\b",
    r"\bECLIPSE\s?(?:500|550)\b",
    r"\bEA\s?5[05]0\b",
    r"\bECLIPSE (?:AVIATION|AEROSPACE)\b",
    r"\bVISION JET\b",
    r"\bSF\s?50\b",
    r"\bPC\s?24\b",
    r"\b(?:BAE|HS)\s?125\b",
    r"\b(?:IAI|ISRAEL)\b.*\bWESTWIND\b",
    r"\bASTRA\s?SPX\b|\b(?:IAI|ISRAEL)\b.*\bASTRA\b",
    r"\b112[45]A?\b",
    r"\b(?:IAI|ISRAEL)\b.*\bGALAXY\b",
    r"\bMU\s?300\b",
)

TURBOPROP_AIRLINER_PATTERNS = (
    r"\bATR\s?(?:42|72)\b",
    r"\bDHC\s?8\b",
    r"\bQ(?:100|200|300|400)\b",
    r"\bSAAB\s?340\b",
    r"\bEMB\s?120\b",
)

TURBOPROP_TEXT_PATTERNS = (
    r"\bKING\s?AIR\b",
    r"\b(?:BEECH|BEECHCRAFT|TEXTRON|HAWKER)\b.*\bB(?:200|300|350)[A-Z]*\b",
    r"\bPC\s?12\b",
    r"\bTBM\s?(?:7|8|9)[0-9]{2}\b",
    r"\bCARAVAN\b(?!\s?CO\b)",
)

MILITARY_PATTERNS = (
    r"\bF\s?(?:15|16|18|22|35)\b",
    r"\bC\s?(?:5|17|130|135)\b",
    r"\bKC\s?(?:10|46|135)\b",
    r"\bA\s?(?:4|10|37)\b",
    r"\bTA\s?4\b",
    r"\bT\s?(?:6|33|38|45)\b",
    r"\bCT\s?33\b",
    r"\bL\s?(?:29|39|159)\b",
    r"\bALBATROS\b|\bDELFIN\b",
    r"\bS\s?211\b",
    r"\bMB\s?326\b|\bIMPALA\b",
    r"\bMIG\b|\bMIRAGE\b|\bKFIR\b|\bVAMPIRE\b",
    r"\bHUNTER\b|\bHNTR\b|\bHAWK\b|\bHURRICANE\b",
    r"\bFOUGA\b|\bMAGISTER\b",
)

PISTON_PATTERNS = (
    r"\bCESSNA\b.*\b(?:150|152|170|172|177|182|206|210|310|340|414|421)\b",
    r"\bT?20(?:6|7)[A-Z]*\b",
    r"\b(?:C|T)?(?:150|152|170|172|182|206|210|310|340|414|421)[A-Z]*\b",
    r"\bPA\s?(?:28|31|32)\b",
    r"\bPIPER\b.*\b(?:PA\s?)?(?:28|31|32)\b",
    r"\bSR\s?(?:20|22)[A-Z]*\b",
    r"\bCIRRUS\b.*\bSR\s?(?:20|22)[A-Z]*\b",
    r"\bBEECH\b.*\b(?:A36|B36|G36|G58|95\s?B55|B55)\b",
    r"\bBE(?:35|36|55|58)\b|\bBARON\b|\bBONANZA\b",
    r"\bAA\s?5[AB]?\b",
    r"\bRV\s?(?:3|4|6|7|8|9|10|12|14)[A-Z]*\b",
    r"\bLANCAIR\b|\bGLASAIR\b|\bCOUGAR\b|\bAIR\s?CAM\b",
    r"\bQUAD CITY\b|\bCHALLENGER II\b",
    r"\bWITTMAN\b|\bLEGACY\s?(?:L2K|2000|FG|RG)\b",
)

UNCREWED_OR_EXPERIMENTAL_PATTERNS = (
    r"\bZIPLINE\b|\bP2\s?ZIP\b",
    r"\bANDURIL\b|\bROADRUNNER\b|\bHAVOC\b",
    r"\bDJI\b|\bAGRAS\b",
    r"\bSHARK\b|\bM\s?8\s?EAGLE\b|\bP\s?MENTOR\b",
    r"\bPARAMOTOR\b|\bWEEDHOPPER\b|\bULTRALAIR\b",
)


@dataclass
class AircraftRecord:
    icao_id: int
    registration: str | None = None
    n_number: str | None = None
    manufacturer: str | None = None
    model: str | None = None
    aircraft_type: str = "unknown"
    source_mask: int = 0
    type_aircraft_code: str | None = None
    type_engine_code: str | None = None
    seat_count: int | None = None
    weight_class: int | None = None
    icao_type: str | None = None
    short_type: str | None = None
    military: bool = False
    owner_name: str | None = None
    owner_city: str | None = None
    owner_state: str | None = None
    owner_country: str | None = None
    owner_type: str | None = None
    year_mfr: int | None = None


def clean(value: object) -> str | None:
    text = re.sub(r"\s+", " ", str(value or "")).strip()
    return text or None


def normalize_hex(value: object) -> str | None:
    text = str(value or "").strip().lower()
    if re.fullmatch(r"[0-9a-f]{6}", text):
        return text
    return None


def normalize_icao_type(value: object) -> str | None:
    """Normalize a registry-reported ICAO type designator (e.g. "GLF6").

    Returns None for values that cannot be a Doc 8643 designator, including
    ZZZZ ("type not assigned").
    """
    text = str(value or "").strip().upper()
    if not re.fullmatch(r"[A-Z0-9]{2,4}", text) or text == "ZZZZ":
        return None
    return text


def normalize_registration(value: object) -> str | None:
    text = clean(value)
    if not text:
        return None
    text = text.upper().replace(" ", "")
    if text in {"UNKNOWN", "NONE", "NA", "N/A", "NOTAVAILABLE"}:
        return None
    return text


def normalize_n_number(value: object) -> str | None:
    text = normalize_registration(value)
    if not text:
        return None
    return text if text.startswith("N") else f"N{text}"


def model_text(manufacturer: str | None, model: str | None, icao_type: str | None = None) -> str:
    parts = [manufacturer or "", model or "", icao_type or ""]
    return " ".join(part for part in parts if part).upper()


def normalize_match_text(value: object) -> str:
    return re.sub(r"\s+", " ", re.sub(r"[^A-Z0-9]+", " ", str(value or "").upper())).strip()


def compact_match_text(value: object) -> str:
    return re.sub(r"[^A-Z0-9]+", "", str(value or "").upper())


def classifier_text(manufacturer: str | None, model: str | None, icao_type: str | None = None) -> str:
    raw = model_text(manufacturer, model, icao_type)
    normalized = normalize_match_text(raw)
    compact = compact_match_text(raw)
    return " ".join(part for part in (normalized, compact) if part)


def matches_any(text: str, patterns: tuple[str, ...]) -> bool:
    return any(re.search(pattern, text, flags=re.IGNORECASE) for pattern in patterns)


def prefer_text(current: str | None, incoming: str | None) -> str | None:
    if not incoming:
        return current
    if not current:
        return incoming
    current_normalized = normalize_match_text(current)
    incoming_normalized = normalize_match_text(incoming)
    if current_normalized == incoming_normalized:
        return current
    if current_normalized and current_normalized in incoming_normalized:
        return incoming
    return current


def classify_aircraft(
    manufacturer: str | None = None,
    model: str | None = None,
    type_aircraft_code: str | None = None,
    type_engine_code: str | None = None,
    seat_count: int | None = None,
    weight_class: int | None = None,
    icao_type: str | None = None,
    short_type: str | None = None,
    military: bool = False,
) -> str:
    text = classifier_text(manufacturer, model, icao_type)
    short = classifier_text(None, short_type)

    if military or matches_any(text, MILITARY_PATTERNS):
        return "military"
    if type_aircraft_code == "6" or short.startswith("H"):
        return "helicopter"
    if type_aircraft_code == "9":
        return "gyroplane"
    if type_aircraft_code == "1":
        return "glider"
    if type_aircraft_code in {"2", "3"}:
        return "lighter_than_air"
    if matches_any(text, UNCREWED_OR_EXPERIMENTAL_PATTERNS):
        return "unknown"
    if matches_any(text, PISTON_PATTERNS):
        return "piston"
    if matches_any(text, TURBOPROP_AIRLINER_PATTERNS):
        return "commercial_turboprop"
    if type_engine_code == "2" or "T" in short:
        return "turboprop"
    if matches_any(text, TURBOPROP_TEXT_PATTERNS):
        return "turboprop"
    if matches_any(text, BUSINESS_AIRLINER_DERIVATIVE_PATTERNS):
        return "business_jet"
    if matches_any(text, AIRLINER_PATTERNS):
        return "commercial_jet"
    if matches_any(text, BUSINESS_JET_PATTERNS):
        return "business_jet"
    if type_engine_code in {"4", "5"} or "J" in short:
        if (seat_count is not None and seat_count >= 35) or (weight_class is not None and weight_class >= 3):
            return "commercial_jet"
        if seat_count is not None or weight_class is not None:
            return "business_jet"
        return "unknown_jet"
    if type_engine_code in {"1", "01", "7", "8", "11"}:
        return "piston"
    if type_engine_code == "10":
        return "electric"
    if type_aircraft_code in {"4", "5"}:
        return "fixed_wing"
    return "unknown"


def parse_int(value: object) -> int | None:
    text = clean(value)
    if not text:
        return None
    if text.upper().startswith("CLASS"):
        text = text[5:].strip()
    try:
        return int(text)
    except ValueError:
        return None


def load_aircraft_reference(archive: zipfile.ZipFile) -> dict[str, dict[str, str | None]]:
    with archive.open("ACFTREF.txt") as raw:
        reader = csv.DictReader(io.TextIOWrapper(raw, encoding="utf-8-sig", newline=""))
        return {
            clean(row.get("CODE")) or "": {
                "manufacturer": clean(row.get("MFR")),
                "model": clean(row.get("MODEL")),
                "type_aircraft": clean(row.get("TYPE-ACFT")),
                "type_engine": clean(row.get("TYPE-ENG")),
                "seat_count": clean(row.get("NO-SEATS")),
                "weight_class": clean(row.get("AC-WEIGHT")),
            }
            for row in reader
        }


def merge_record(records: dict[int, AircraftRecord], incoming: AircraftRecord) -> None:
    refresh_record_classification(incoming)
    record = records.get(incoming.icao_id)
    if record is None:
        records[incoming.icao_id] = incoming
        return

    record.registration = record.registration or incoming.registration
    record.n_number = record.n_number or incoming.n_number
    record.manufacturer = prefer_text(record.manufacturer, incoming.manufacturer)
    record.model = prefer_text(record.model, incoming.model)
    record.type_aircraft_code = record.type_aircraft_code or incoming.type_aircraft_code
    record.type_engine_code = record.type_engine_code or incoming.type_engine_code
    record.seat_count = record.seat_count if record.seat_count is not None else incoming.seat_count
    record.weight_class = record.weight_class if record.weight_class is not None else incoming.weight_class
    record.icao_type = prefer_text(record.icao_type, incoming.icao_type)
    record.short_type = prefer_text(record.short_type, incoming.short_type)
    record.military = record.military or incoming.military
    record.owner_name = record.owner_name or incoming.owner_name
    record.owner_city = record.owner_city or incoming.owner_city
    record.owner_state = record.owner_state or incoming.owner_state
    record.owner_country = record.owner_country or incoming.owner_country
    record.owner_type = record.owner_type or incoming.owner_type
    record.year_mfr = record.year_mfr if record.year_mfr is not None else incoming.year_mfr
    record.source_mask |= incoming.source_mask
    refresh_record_classification(record)


def refresh_record_classification(record: AircraftRecord) -> None:
    record.aircraft_type = classify_aircraft(
        manufacturer=record.manufacturer,
        model=record.model,
        type_aircraft_code=record.type_aircraft_code,
        type_engine_code=record.type_engine_code,
        seat_count=record.seat_count,
        weight_class=record.weight_class,
        icao_type=record.icao_type,
        short_type=record.short_type,
        military=record.military,
    )


def load_faa_records(zip_path: Path, records: dict[int, AircraftRecord]) -> int:
    count = 0
    with zipfile.ZipFile(zip_path) as archive:
        aircraft_reference = load_aircraft_reference(archive)
        with archive.open("MASTER.txt") as raw:
            reader = csv.DictReader(io.TextIOWrapper(raw, encoding="utf-8-sig", newline=""))
            for row in reader:
                hex_value = normalize_hex(row.get("MODE S CODE HEX"))
                if hex_value is None:
                    continue
                model_code = clean(row.get("MFR MDL CODE")) or ""
                reference = aircraft_reference.get(model_code, {})
                manufacturer = reference.get("manufacturer")
                model = reference.get("model")
                n_number = normalize_n_number(row.get("N-NUMBER"))
                record = AircraftRecord(
                    icao_id=hex_to_icao(hex_value),
                    registration=n_number,
                    n_number=n_number,
                    manufacturer=manufacturer,
                    model=model,
                    source_mask=SOURCE_FAA,
                    type_aircraft_code=reference.get("type_aircraft"),
                    type_engine_code=reference.get("type_engine"),
                    seat_count=parse_int(reference.get("seat_count")),
                    weight_class=parse_int(reference.get("weight_class")),
                    owner_name=clean(row.get("NAME")),
                    owner_city=clean(row.get("CITY")),
                    owner_state=clean(row.get("STATE")),
                    owner_country=clean(row.get("COUNTRY")),
                    owner_type=TYPE_REGISTRANT.get(clean(row.get("TYPE REGISTRANT")) or ""),
                    year_mfr=parse_int(row.get("YEAR MFR")),
                )
                merge_record(records, record)
                count += 1
    return count


def load_adsbx_records(path: Path, records: dict[int, AircraftRecord]) -> int:
    if not path.exists():
        return 0
    count = 0
    with gzip.open(path, "rt", encoding="utf-8") as file_handle:
        for line in file_handle:
            if not line.strip():
                continue
            row = json.loads(line)
            hex_value = normalize_hex(row.get("icao"))
            if hex_value is None:
                continue
            registration = normalize_registration(row.get("reg"))
            manufacturer = clean(row.get("manufacturer"))
            model = clean(row.get("model"))
            record = AircraftRecord(
                icao_id=hex_to_icao(hex_value),
                registration=registration,
                n_number=registration if registration and registration.startswith("N") else None,
                manufacturer=manufacturer,
                model=model,
                source_mask=SOURCE_ADSBX,
                icao_type=normalize_icao_type(row.get("icaotype")),
                short_type=clean(row.get("short_type")),
                military=bool(row.get("mil")),
            )
            merge_record(records, record)
            count += 1
    return count


def load_tar1090_records(path: Path, records: dict[int, AircraftRecord]) -> int:
    if not path.exists():
        return 0
    count = 0
    with gzip.open(path, "rt", encoding="utf-8", newline="") as file_handle:
        reader = csv.reader(file_handle, delimiter=";")
        for row in reader:
            if len(row) < 5:
                continue
            hex_value = normalize_hex(row[0])
            if hex_value is None:
                continue
            registration = normalize_registration(row[1])
            icao_type = normalize_icao_type(row[2])
            model = clean(row[4])
            record = AircraftRecord(
                icao_id=hex_to_icao(hex_value),
                registration=registration,
                n_number=registration if registration and registration.startswith("N") else None,
                model=model,
                source_mask=SOURCE_TAR1090,
                icao_type=icao_type,
            )
            merge_record(records, record)
            count += 1
    return count


def open_maybe_gzip(path: Path):
    if path.suffix == ".gz":
        return gzip.open(path, "rt", encoding="utf-8", newline="")
    return path.open("rt", encoding="utf-8", newline="")


def load_opensky_records(path: Path, records: dict[int, AircraftRecord]) -> int:
    if not path.exists():
        return 0
    count = 0
    with open_maybe_gzip(path) as file_handle:
        reader = csv.DictReader(file_handle)
        for row in reader:
            hex_value = normalize_hex(row.get("icao24") or row.get("icao"))
            if hex_value is None:
                continue
            registration = normalize_registration(row.get("registration") or row.get("regid") or row.get("reg"))
            icao_type = normalize_icao_type(row.get("typecode") or row.get("icaotype"))
            model = clean(row.get("model") or row.get("type"))
            record = AircraftRecord(
                icao_id=hex_to_icao(hex_value),
                registration=registration,
                n_number=registration if registration and registration.startswith("N") else None,
                model=model,
                source_mask=SOURCE_OPENSKY,
                icao_type=icao_type,
            )
            merge_record(records, record)
            count += 1
    return count


def write_aircraft_db(db_path: Path, records: dict[int, AircraftRecord], details: dict) -> dict:
    for record in records.values():
        refresh_record_classification(record)
    type_labels = sorted({record.aircraft_type for record in records.values()} | {"unknown"})
    type_ids = {label: index for index, label in enumerate(type_labels, start=1)}
    type_rows = [(type_id, label) for label, type_id in type_ids.items()]
    rows = [
        (
            record.icao_id,
            record.registration,
            record.n_number,
            record.manufacturer,
            record.model,
            record.icao_type,
            type_ids.get(record.aircraft_type, type_ids["unknown"]),
            record.source_mask,
            record.owner_name,
            record.owner_city,
            record.owner_state,
            record.owner_country,
            record.owner_type,
            record.year_mfr,
        )
        for record in sorted(records.values(), key=lambda item: item.icao_id)
    ]

    connection = connect(db_path, AIRCRAFT_SCHEMA)
    try:
        with connection:
            existing_columns = {row[1] for row in connection.execute("PRAGMA table_info(aircraft)")}
            if "icao_type" not in existing_columns:
                connection.execute("ALTER TABLE aircraft ADD COLUMN icao_type TEXT")
            connection.execute("DELETE FROM aircraft")
            connection.execute("DELETE FROM aircraft_types")
            connection.executemany("INSERT INTO aircraft_types(aircraft_type_id, label) VALUES (?, ?)", type_rows)
            connection.executemany(
                """
                INSERT INTO aircraft(
                    icao_id, registration, n_number, manufacturer, model, icao_type, aircraft_type_id, source_mask,
                    owner_name, owner_city, owner_state, owner_country, owner_type, year_mfr
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                """,
                rows,
            )
            set_meta(connection, "aircraft_count", str(len(rows)))
            set_meta(connection, "aircraft_type_count", str(len(type_rows)))
            set_meta(connection, "aircraft_import_details", json.dumps(details, sort_keys=True))
    finally:
        connection.close()
    vacuum(db_path)
    return {"aircraft": len(rows), "aircraft_types": len(type_rows), "db_path": str(db_path), **details}


def import_aircraft(
    db_path: Path = AIRCRAFT_DB,
    faa_zip: Path = FAA_ZIP,
    adsbx_path: Path = ADSBX_BASIC_AIRCRAFT_DB,
    tar1090_path: Path = TAR1090_AIRCRAFT_DB,
    opensky_path: Path = OPENSKY_AIRCRAFT_DB,
) -> dict:
    records: dict[int, AircraftRecord] = {}
    details = {
        "faa_rows": load_faa_records(faa_zip, records) if faa_zip.exists() else 0,
        "adsbx_rows": load_adsbx_records(adsbx_path, records),
        "tar1090_rows": load_tar1090_records(tar1090_path, records),
        "opensky_rows": load_opensky_records(opensky_path, records),
    }
    return write_aircraft_db(db_path, records, details)


def rotorcraft_icao_ids(connection: sqlite3.Connection) -> set[int]:
    rows = connection.execute(
        """
        SELECT a.icao_id
        FROM aircraft a
        JOIN aircraft_types t ON t.aircraft_type_id = a.aircraft_type_id
        WHERE t.label IN ('helicopter', 'gyroplane')
        """
    ).fetchall()
    return {int(row["icao_id"]) for row in rows}


def main(argv: list[str] | None = None) -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--db", type=Path, default=AIRCRAFT_DB)
    parser.add_argument("--faa-zip", type=Path, default=FAA_ZIP)
    parser.add_argument("--adsbx-basic-db", type=Path, default=ADSBX_BASIC_AIRCRAFT_DB)
    parser.add_argument("--tar1090-db", type=Path, default=TAR1090_AIRCRAFT_DB)
    parser.add_argument("--opensky-csv", type=Path, default=OPENSKY_AIRCRAFT_DB)
    args = parser.parse_args(argv)
    print(import_aircraft(args.db, args.faa_zip, args.adsbx_basic_db, args.tar1090_db, args.opensky_csv))


if __name__ == "__main__":
    main()
