"""Query Airport Guide API for IATA codes missing from OurAirports.

Modified by PJET to require the RapidAPI credential from ``RAPIDAPI_KEY``.
"""
import csv
import json
import os

import requests

api_endpoint = "https://forteweb-airportguide-airport-basic-info-v1.p.rapidapi.com/get_airport_by_iata"

headers = {
    "X-RapidAPI-Key": os.environ["RAPIDAPI_KEY"],
    "X-RapidAPI-Host": "forteweb-airportguide-airport-basic-info-v1.p.rapidapi.com",
}

with open("data/airports/iata.csv") as f:
    codes = {
        airport["code"]
        for airport in csv.DictReader(f, fieldnames=("city", "location", "code"))
    }

with open("data/airports/ourairports.csv") as f:
    ourairports_codes = {airport["iata_code"] for airport in csv.DictReader(f)}

missing_codes = codes - ourairports_codes

with open("data/airports/airport_guide.jsonl", "w") as f:

    for missing_code in missing_codes:

        querystring = {"airport_id": missing_code, "auth": "authairport567"}

        response = requests.request(
            "GET", api_endpoint, headers=headers, params=querystring
        )
        for airport in response.json().get("airport", []):
            f.write(json.dumps(airport))
            f.write("\n")
            f.flush()
