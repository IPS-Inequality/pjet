"""Airport data.

There are many data sources for airports. Authorative data sources such as those
from ICAO and IATA are not freely available. This file parses several freely
available datasets (OurAirports, OpenFlights.org, Wikidata, GADB, and a Yahoo
dump).

The IATA website has a code search tool that can be scraped for all current IATA
codes. The Airport Guide website has an API (paid) which was queried for all
active IATA codes that were not available in the OurAirports dataset.

Other resources that can be used are:

    * Great Circle Mapper: http://www.gcmap.com/
    * World Airport Codes: https://www.world-airport-codes.com/
    * Air-port-codes: https://www.air-port-codes.com/
"""
import csv
import json
from collections.abc import Iterable
from dataclasses import dataclass
from enum import Enum
from pathlib import Path
from typing import TextIO


@dataclass(frozen=True, kw_only=True)
class Airport:
    name: str
    iata_code: str
    latitude: float
    longitude: float
    country: str | None = None


GADB_FIELDS = (
    "ICAO Code",
    "IATA Code",
    "Airport Name",
    "City/Town",
    "Country",
    "Latitude Degrees",
    "Latitude Minutes",
    "Latitude Seconds",
    "Latitude Direction",
    "Longitude Degrees",
    "Longitude Minutes",
    "Longitude Seconds",
    "Longitude Direction",
    "Altitude",
    "Latitude Decimal Degrees",
    "Longitude Decimal Degrees",
)


def load_gadb(f: TextIO) -> Iterable[Airport]:
    """Load Global Airport Database (GADB).

    See https://www.partow.net/miscellaneous/airportdatabase/ for details.

    Note that IATA codes are not unique in this database.
    """
    for row in csv.DictReader(f, fieldnames=GADB_FIELDS, delimiter=":"):
        if row["Airport Name"] == "N/A" or row["IATA Code"] == "N/A":
            continue
        if not (
            float(row["Latitude Decimal Degrees"])
            and float(row["Longitude Decimal Degrees"])
        ):
            continue
        yield Airport(
            name=row["Airport Name"],
            iata_code=row["IATA Code"],
            latitude=float(row["Latitude Decimal Degrees"]),
            longitude=float(row["Longitude Decimal Degrees"]),
        )


def load_ourairports(f: TextIO) -> Iterable[Airport]:
    """Load OurAirports dataset.

    See https://ourairports.com/help/data-dictionary.html for details.

    This seems to be the highest quality database.
    """
    for row in csv.DictReader(f):
        if row["iata_code"] == "":
            continue
        yield Airport(
            name=row["name"],
            iata_code=row["iata_code"],
            latitude=float(row["latitude_deg"]),
            longitude=float(row["longitude_deg"]),
            country=row["iso_country"],
        )


OPENFLIGHTS_FIELDS = (
    "Airport ID",
    "Name",
    "City",
    "Country",
    "IATA",
    "ICAO",
    "Latitude",
    "Longitude",
    "Altitude",
    "Timezone",
    "DST",
    "Tz database time zone",
    "Type",
    "Source",
)


def load_openflights(f: TextIO) -> Iterable[Airport]:
    """Load OpenFlights.org airports dataset.

    See https://openflights.org/data.html for details.

    Some airports in this dataset seem incorrect (BTZ), inaccurately located
    (HUE), or outdated (YNT).
    """
    for row in csv.DictReader(f, fieldnames=OPENFLIGHTS_FIELDS):
        if row["IATA"] == "\\N":
            continue
        yield Airport(
            name=row["Name"],
            iata_code=row["IATA"],
            latitude=float(row["Latitude"]),
            longitude=float(row["Longitude"]),
        )


def load_wikidata(f: TextIO) -> Iterable[Airport]:
    """Load Wikidata airports.

    See https://w.wiki/6AZm for query used.

    Some entries are incorrect, such as BCG, PGN, TAN, TCY, MAL, AFK, etc.
    """
    for row in csv.DictReader(f):
        yield Airport(
            name=row["itemLabel"],
            iata_code=row["iata"],
            latitude=float(row["lat"]),
            longitude=float(row["lon"]),
        )


def load_yahoo(f: TextIO) -> Iterable[Airport]:
    """Load Yahoo! dataset.

    Sources from GitHub: https://gist.github.com/tdreyno/4278655. Has mistakes
    such as XZM and RMT.
    """
    for airport in json.load(f):
        yield Airport(
            name=airport["name"],
            iata_code=airport["code"],
            latitude=float(airport["lat"]),
            longitude=float(airport["lon"]),
        )


class Dataset(Enum):
    GADB = "gadb"
    OURAIRPORTS = "ourairports"
    OPENFLIGHTS = "openflights"
    WIKIDATA = "wikidata"
    YAHOO = "yahoo"


DATASETS = {
    Dataset.GADB: (Path("GlobalAirportDatabase.txt"), load_gadb),
    Dataset.OURAIRPORTS: (Path("ourairports.csv"), load_ourairports),
    Dataset.OPENFLIGHTS: (Path("openflights.dat"), load_openflights),
    Dataset.WIKIDATA: (Path("wikidata.csv"), load_wikidata),
    Dataset.YAHOO: (Path("yahoo.json"), load_yahoo),
}


def load_airports(dataset: Dataset = Dataset.OURAIRPORTS) -> Iterable[Airport]:
    file, load_fn = DATASETS[dataset]
    with open("data/airports" / file) as f:
        yield from load_fn(f)
