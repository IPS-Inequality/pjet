import unittest
from math import isclose

from ghgc.aircraft import Aircraft
from ghgc.airports import load_airports
from ghgc.flights import Flight
from ghgc.methods import uk_ghg
from ghgc.units import ureg


class TestUKGHG(unittest.TestCase):
    def setUp(self) -> None:
        self.airports = {ap.iata_code: ap for ap in load_airports()}
        self.aircraft = {
            "B738": Aircraft(name="Boeing 737-800", iata_code="738", icao_code="B738")
        }

    def test_exact_haul(self):
        flight = Flight(origin=self.airports["LHR"], destination=self.airports["CDG"])
        self.assertEqual(uk_ghg.exact(flight), uk_ghg.Haul.SHORT)

        flight = Flight(origin=self.airports["AMS"], destination=self.airports["CDG"])
        self.assertEqual(uk_ghg.exact(flight), uk_ghg.Haul.INTERNATIONAL)

        flight = Flight(origin=self.airports["LHR"], destination=self.airports["LGA"])
        self.assertEqual(uk_ghg.exact(flight), uk_ghg.Haul.LONG)

        flight = Flight(origin=self.airports["LHR"], destination=self.airports["EDI"])
        self.assertEqual(uk_ghg.exact(flight), uk_ghg.Haul.DOMESTIC)

    def test_international_haul(self):
        flight = Flight(origin=self.airports["LHR"], destination=self.airports["EDI"])
        self.assertEqual(uk_ghg.all_international(flight), uk_ghg.Haul.INTERNATIONAL)

    def test_distance_haul(self):
        flight = Flight(origin=self.airports["LHR"], destination=self.airports["EDI"])
        self.assertEqual(uk_ghg.short_long(flight), uk_ghg.Haul.SHORT)

        flight = Flight(origin=self.airports["AMS"], destination=self.airports["LGA"])
        self.assertEqual(uk_ghg.short_long(flight), uk_ghg.Haul.LONG)

    def test_co2e(self):
        flight = Flight(origin=self.airports["LHR"], destination=self.airports["LGA"])
        with ureg.context("AR4"):
            # Check against factors from spreadsheet
            self.assertTrue(
                isclose(
                    uk_ghg.uk_ghg(flight).to("kgCO2e").m,
                    flight.distance.m * 0.19309,
                    rel_tol=1e-4,
                )
            )

            self.assertTrue(
                isclose(
                    uk_ghg.uk_ghg(flight, radiative_forcing_uplift=1.0).to("kgCO2e").m,
                    flight.distance.m * 0.10208,
                    rel_tol=1e-4,
                )
            )
