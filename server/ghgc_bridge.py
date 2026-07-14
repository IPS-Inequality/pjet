#!/usr/bin/env python3
"""Bridge Node API requests to the vendored ghgc flight-emissions package."""

from __future__ import annotations

import csv
import json
import os
import re
import sys
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Callable


ROOT_DIR = Path(__file__).resolve().parents[1]
VENDOR_DIR = ROOT_DIR / "vendor" / "flight-emissions"

sys.path.insert(0, str(VENDOR_DIR))
os.chdir(VENDOR_DIR)

from ghgc.aircraft import Aircraft  # noqa: E402
from ghgc.airports import Airport  # noqa: E402
from ghgc.flights import Flight  # noqa: E402
from ghgc.methods import eurocontrol  # noqa: E402


DEFAULT_COUNTRY = "US"


@dataclass(frozen=True)
class MethodSpec:
    value: str
    label: str
    fn: Callable[[Flight], Any]


METHODS = {
    "ghgc.methods.eurocontrol": MethodSpec(
        value="ghgc.methods.eurocontrol",
        label="EUROCONTROL Small Emitters Tool",
        fn=eurocontrol.set_,
    ),
}


AIRCRAFT_CODE_PATTERNS: tuple[tuple[re.Pattern[str], str], ...] = tuple(
    (re.compile(pattern), code)
    for pattern, code in [
        (r"\b560XLS?\b|CITATION (EXCEL|XLS)", "C56X"),
        (r"\bEMB\s*505\b|PHENOM 300", "E55P"),
        (r"\b525B\b|CITATION CJ3", "C25B"),
        (r"LEARJET.*\b45\b|\bLEAR\s*45\b", "LJ45"),
        (r"\bGULFSTREAM G280\b|\bG280\b", "G280"),
        (r"\bTEXTRON.*\b700\b|\bCESSNA.*\b700\b|CITATION LONGITUDE", "C700"),
        (r"\bFALCON 2000(EX|LX|LXS)?\b|MYSTERE FALCON 2000", "F2TH"),
        (r"\bCITATION X\b|\bCESSNA.*\b750\b|\b750\b", "C750"),
        (r"\b525A\b|CITATION CJ2", "C25A"),
        (r"\b525C\b|CITATION CJ4", "C25C"),
        (r"\bCESSNA.*\b525\b|\bTEXTRON.*\b525\b|CITATIONJET|CITATION JET|CITATION CJ1\b", "C525"),
        (r"\bBEECHJET\b|\b400A\b|HAWKER 400", "BE40"),
        (r"\bGVII[\s-]?G600\b|\bGULFSTREAM G600\b|\bG600\b", "GA6C"),
        (r"\bGVII[\s-]?G500\b|\bGULFSTREAM G500\b|\bG500\b", "GA5C"),
        (r"\bGVI\b|\bGULFSTREAM G650(ER)?\b|\bG650(ER)?\b", "GLF6"),
        (r"\bGV[\s-]?SP\b|\bGULFSTREAM G550\b|\bG550\b|\bGULFSTREAM G5\b|\bGULFSTREAM G-V\b|\bG-V\b", "GLF5"),
        (r"\bGIV[\s-]?X\b|\bGULFSTREAM G450\b|\bG450\b|\bGULFSTREAM G400\b|\bG[\s-]?IV\b|\bGIV\b", "GLF4"),
        (r"\bG[\s-]?V\b", "GLF5"),
        (r"\bHAWKER 4000\b|\b4000\b", "HA4T"),
        (r"\bHAWKER (750|800|800XP|850XP|900XP)\b|\b800XP\b|\b850XP\b|\b900XP\b", "H25B"),
        (r"\bEMB\s*545\b|LEGACY 450|PRAETOR 500", "E545"),
        (r"\bEMB\s*550\b|LEGACY 500|PRAETOR 600", "E550"),
        (r"\bPC[\s-]?24\b", "PC24"),
        (r"\bFALCON 900", "F900"),
        (r"\bSF[\s-]?50\b|VISION JET", "SF50"),
        (r"\bCESSNA.*\b680A\b|\bTEXTRON.*\b680A\b|CITATION LATITUDE", "C68A"),
        (r"\bCESSNA.*\b680\b|\bTEXTRON.*\b680\b|CITATION SOVEREIGN", "C680"),
        (r"\bCESSNA.*\b650\b|CITATION III|CITATION VII", "C650"),
        (r"\bHA[\s-]?420\b|HONDAJET|HONDA JET", "HDJT"),
        (r"\bEMB\s*500\b|PHENOM 100", "E50P"),
        (r"\bFALCON 7X\b", "FA7X"),
        (r"LEARJET.*\b60\b|\bLEAR\s*60\b", "LJ60"),
        (r"\bCESSNA.*\b510\b|CITATION MUSTANG|MUSTANG", "C510"),
        (r"\bGULFSTREAM 200\b|\bGULFSTREAM G200\b|\bG200\b|\bGALAXY\b", "G200"),
        (r"\bGULFSTREAM G150\b|\bG150\b", "G150"),
        (r"\bPREMIER\b|\bHAWKER 200\b|\bRAYTHEON.*\b390\b|\bBEECH.*\b390\b|\b390\b", "PRM1"),
        (r"\bEMB[\s-]?135BJ\b|LEGACY 600|LEGACY 650", "E35L"),
        (r"\bCL[\s-]?600[\s-]?2B16\b|\bCL[\s-]?600 CHALLENGER\b|CHALLENGER (604|605|650)|CANADAIR CHALLENGER", "CL60"),
        (r"LEARJET.*\b31A?\b|\bLEAR\s*31A?\b", "LJ31"),
        (r"LEARJET.*\b35A?\b|\bLEAR\s*35A?\b", "LJ35"),
        (r"LEARJET.*\b55[BC]?\b|\bLEAR\s*55[BC]?\b", "LJ55"),
        (r"\bFALCON 10\b", "FA10"),
        (r"\bFALCON 20\b", "FA20"),
        (r"\bFALCON 50\b|MYSTERE[\s-]?FALCON 50", "FA50"),
        (r"\bBAE 125 800A\b|\bBAE 125 800\b|\b125 800A\b|\b125 800\b", "H25B"),
        (r"\b1125\b|WESTWIND ASTRA|\bASTRA\b", "ASTR"),
        (r"\bEA500\b|\bEA\s*500\b|ECLIPSE 500", "EA50"),
        (r"\bBD[\s-]?100.*CHALLENGER 350|CHALLENGER 350|CHALLENGER 3500|\bCL35\b", "CL35"),
        (r"\bBD[\s-]?100|CHALLENGER 300|\bCL30\b", "CL30"),
        (r"\bBD[\s-]?700\b|GLOBAL (5000|5500|6000|6500|EXPRESS)|\bGLEX\b", "GLEX"),
        (r"\bGLOBAL (7000|7500)\b|\bGL7T\b", "GL7T"),
        (r"\bGULFSTREAM G700\b|\bG700\b", "GA7C"),
        (r"\bGULFSTREAM G800\b|\bG800\b", "GA8C"),
        (r"\bCESSNA.*\bS550\b|\bS550\b|CITATION S2", "C551"),
        (r"\bCESSNA.*\b550\b|CITATION II\b|CITATION BRAVO|\b550\b|\b551\b", "C550"),
        (r"\bCESSNA.*\b560\b|CITATION V\b|CITATION ULTRA|CITATION ENCORE|\b560\b", "C560"),
    ]
)


def normalize_aircraft_text(value: Any) -> str:
    return re.sub(r"\s+", " ", re.sub(r"[^A-Z0-9]+", " ", str(value or "").upper())).strip()


def load_iata_by_icao() -> dict[str, str]:
    path = VENDOR_DIR / "data" / "aircraft" / "iata.csv"
    with path.open(newline="") as handle:
        rows = csv.DictReader(handle)
        return {
            row["ICAO Code"].strip().upper(): (row["Aircraft Type"] or row["Aircraft Group"]).strip()
            for row in rows
            if row["ICAO Code"].strip()
        }


IATA_BY_ICAO = load_iata_by_icao()


def resolve_icao_code(event: dict[str, Any]) -> str | None:
    combined = normalize_aircraft_text(f"{event.get('manufacturer', '')} {event.get('model', '')}")
    if not combined:
        return None
    for pattern, code in AIRCRAFT_CODE_PATTERNS:
        if pattern.search(combined):
            return code
    return None


def build_airport(data: dict[str, Any], fallback_code: str) -> Airport:
    return Airport(
        name=str(data.get("name") or data.get("code") or fallback_code),
        iata_code=str(data.get("code") or fallback_code),
        latitude=float(data["latitude"]),
        longitude=float(data["longitude"]),
        country=str(data.get("country") or DEFAULT_COUNTRY),
    )


def build_aircraft(event: dict[str, Any]) -> tuple[Aircraft | None, str | None, str | None]:
    icao_code = resolve_icao_code(event)
    if icao_code is None:
        return None, None, None

    iata_code = IATA_BY_ICAO.get(icao_code)

    return (
        Aircraft(
            name=" ".join(str(event.get(key) or "").strip() for key in ("manufacturer", "model")).strip()
            or icao_code,
            icao_code=icao_code,
            iata_code=iata_code,
        ),
        icao_code,
        iata_code,
    )


def build_flight(event: dict[str, Any]) -> tuple[Flight | None, dict[str, Any]]:
    aircraft, icao_code, iata_code = build_aircraft(event)
    metadata = {
        "aircraftIcaoCode": icao_code,
        "aircraftIataCode": iata_code,
    }
    if aircraft is None:
        metadata["unsupportedReason"] = "aircraft_not_supported"
        return None, metadata

    flight = Flight(
        origin=build_airport(event["origin"], "ORIGIN"),
        destination=build_airport(event["destination"], "DEST"),
        aircraft=aircraft,
    )
    return flight, metadata


def quantity_to_kg(value: Any) -> float:
    try:
        return float(value.to("kgCO2e").m)
    except Exception:
        return float(value.to("kg").m)


def estimate_event(event: dict[str, Any], spec: MethodSpec) -> dict[str, Any]:
    result: dict[str, Any] = {
        "eventId": event.get("eventId"),
        "methodology": spec.value,
        "label": spec.label,
        "scope": "whole_flight",
        "scopeLabel": "Whole flight",
        "gasBasis": "CO2 from fuel burn",
    }
    try:
        flight, metadata = build_flight(event)
        result.update(metadata)
        if flight is None:
            result["totalCo2eKg"] = None
            return result
        total = spec.fn(flight)
        result["totalCo2eKg"] = quantity_to_kg(total)
        return result
    except KeyError:
        result["totalCo2eKg"] = None
        result["unsupportedReason"] = "aircraft_not_in_method_dataset"
        return result
    except Exception as exc:  # noqa: BLE001 - external model failures become unsupported rows
        result["totalCo2eKg"] = None
        result["unsupportedReason"] = type(exc).__name__
        return result


def main() -> int:
    payload = json.load(sys.stdin)
    methodology = payload.get("methodology")
    spec = METHODS.get(methodology)
    if spec is None:
        raise SystemExit(f"Unsupported ghgc methodology: {methodology}")

    estimates = [estimate_event(event, spec) for event in payload.get("events", [])]
    json.dump({"estimates": estimates}, sys.stdout, separators=(",", ":"))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
