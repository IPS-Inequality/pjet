import unittest
from math import isclose

from ghgc.aircraft import Aircraft
from ghgc.airports import load_airports
from ghgc.flights import Flight
from ghgc.methods import eurocontrol


class TestUKGHG(unittest.TestCase):
    def setUp(self) -> None:
        self.airports = {ap.iata_code: ap for ap in load_airports()}
        self.aircraft = {
            "B738": Aircraft(name="Boeing 737-800", iata_code="738", icao_code="B738")
        }

    def test_set_(self):
        flight = Flight(
            origin=self.airports["LHR"],
            destination=self.airports["AMS"],
            aircraft=self.aircraft["B738"],
        )
        self.assertTrue(
            # NOTE: EUROCONTROL rounds the nautical miles flown and the fuel
            isclose(eurocontrol.set_(flight).m, 6731.55, rel_tol=1e-3)
        )
