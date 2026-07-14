"""Script that queries all codes on IATA website."""
from itertools import product
from string import ascii_uppercase

import requests
from bs4 import BeautifulSoup, Tag
from requests.adapters import HTTPAdapter, Retry

with open("data/aircraft/iata.csv", "w") as f:
    for letters in product(ascii_uppercase, repeat=3):
        code = "".join(letters)
        s = requests.Session()
        s.mount("https://", HTTPAdapter(max_retries=Retry(total=5, backoff_factor=1.0)))
        r = s.get(
            "https://www.iata.org/AirportCodesSearch/Search"
            f"?currentBlock=314384&currentPage=12572&airport.search={code}"
        )

        if r.status_code != 200:
            print(f"Failed {code}")
        else:
            soup = BeautifulSoup(r.text, "html.parser")
            tbody = soup.find("tbody")
            if not isinstance(tbody, Tag):
                continue
            for row in tbody.find_all("tr"):
                city, location, matched_code = row.find_all("td")
                if matched_code.text == code:
                    f.write(",".join((city.text, location.text, code)))
                    f.write("\n")
                    f.flush()