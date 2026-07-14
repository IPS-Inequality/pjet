"""Google's Travel Impact Model (TIM).

This is a partial implementation of TIM's flight-level and per-passenger
emission estimates. Known deviations from the original methodology:

* Fuel burn is taken from the EMEP/EEA Tier 3A data bundled with this
  repository, rather than the EMEP/EEA 2023 Annex 1 v1.5_18_09_2024 dataset
  used by TIM. The two are from the same data family but may not be
  identical, and aircraft types not supported by EMEP/EEA do not benefit from
  TIM's winglet/fallback substitution rules.
* The distance adjustment always falls back to the flat 1.052 factor (the
  global mean lateral inefficiency for 2019). TIM prefers route- or
  country-specific adjustment factors derived from ADS-B tracking data
  (Teoh et al.), which are not available in this repository.
* The cargo mass fraction defaults to TIM's worked-example value of 8% when
  ``flight.cargo_weight`` is not provided. TIM instead derives this fraction
  from historical cargo statistics (by carrier, route, and aircraft class,
  with coarser fallbacks).
* The passenger load factor uses TIM's global default of 84.5% rather than
  TIM's route- and carrier-specific historical load factors.
"""
from ..aircraft import Class
from ..flights import Flight
from ..units import Quantity, ureg
from .emep_eea import emep_eea
from .iata import WEIGHTS

#: Tank-to-wake CO2e factor (CORSIA carbon intensity * ISO 14083 LHV).
TTW_FACTOR = 3.1894 * ureg.kg / ureg.kg
#: Well-to-tank CO2e factor (CORSIA life cycle assessment).
WTT_FACTOR = 0.6465 * ureg.kg / ureg.kg
#: Mean lateral inefficiency increase (actual flown distance vs. great-circle
#: distance) used when no route- or country-specific factor is available.
DISTANCE_ADJUSTMENT = 1.052
#: Default cargo mass fraction used when the flight's cargo weight is unknown.
CARGO_MASS_FRACTION = 0.08
#: Passenger mass (including baggage), as defined in ISO 14083, Section A.4.2.
PASSENGER_MASS = 100 * ureg.kg


def tim(flight: Flight, load_factor: float = 0.845) -> Quantity:
    if flight.class_ is Class.UNKNOWN:
        raise ValueError
    if flight.aircraft is None:
        raise ValueError
    if flight.aircraft.type_ is None or flight.aircraft.seating is None:
        raise ValueError
    fuel = emep_eea(
        flight,
        co2_factor=1 * ureg.kg / ureg.kg,
        distance=flight.distance * DISTANCE_ADJUSTMENT,
    )
    wtw = fuel * (TTW_FACTOR + WTT_FACTOR)

    if flight.cargo_weight is not None:
        total_seats = sum(flight.aircraft.seating.values())
        passenger_weight = total_seats * PASSENGER_MASS
        cargo_mass_fraction = flight.cargo_weight / (
            flight.cargo_weight + passenger_weight
        )
    else:
        cargo_mass_fraction = CARGO_MASS_FRACTION
    co2e = wtw * (1 - cargo_mass_fraction)

    weights = WEIGHTS[flight.aircraft.type_]
    total_weighted_seats = sum(
        weights[class_] * num_seats
        for class_, num_seats in flight.aircraft.seating.items()
    )
    return co2e / total_weighted_seats * weights[flight.class_] / load_factor
