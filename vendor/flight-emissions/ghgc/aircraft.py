import csv
import json
from collections.abc import Iterable
from dataclasses import dataclass
from enum import StrEnum
from typing import TextIO


class Class(StrEnum):
    ECONOMY = "economy"
    PREMIUM_ECONOMY = "premium"
    BUSINESS = "business"
    FIRST = "first"
    UNKNOWN = "unknown"


@dataclass(frozen=True, kw_only=True)
class Aircraft:
    class Type(StrEnum):
        NARROW_BODY = "narrow_body"
        WIDE_BODY = "wide_body"

    name: str
    icao_code: str | None = None
    iata_code: str | None = None
    type_: Type | None = None
    seating: dict[Class, int] | None = None


def load_icao(file: TextIO) -> Iterable[Aircraft]:
    for aircraft in json.load(file):
        yield Aircraft(name=aircraft["ModelFullName"], icao_code=aircraft["Designator"])


def load_iata(file: TextIO) -> Iterable[Aircraft]:
    for aircraft in csv.DictReader(file):
        icao_code = aircraft["ICAO Code"]
        icao_code = None if not icao_code or icao_code == "*" else icao_code
        yield Aircraft(
            name=aircraft["Manufacturer and Aircraft Name/Model"],
            iata_code=aircraft["Aircraft Type"] or aircraft["Aircraft Group"],
            icao_code=icao_code,
        )
