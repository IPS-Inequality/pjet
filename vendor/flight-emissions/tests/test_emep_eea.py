import unittest
from math import isclose

from ghgc.aircraft import Aircraft
from ghgc.airports import load_airports
from ghgc.flights import Flight
from ghgc.methods import emep_eea


class TestUKGHG(unittest.TestCase):
    def setUp(self) -> None:
        self.airports = {ap.iata_code: ap for ap in load_airports()}
        self.aircraft = {
            "B738": Aircraft(name="Boeing 737-800", iata_code="738", icao_code="B738")
        }

    def test_emep_eea(self):
        flight = Flight(
            origin=self.airports["LHR"],
            destination=self.airports["AMS"],
            aircraft=self.aircraft["B738"],
        )
        self.assertTrue(isclose(emep_eea.emep_eea(flight).m, 7328.02, rel_tol=1e-4))
