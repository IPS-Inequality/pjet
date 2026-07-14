from collections.abc import Callable
from functools import partial

from ..aircraft import Aircraft, Class
from ..flights import Flight
from ..units import Quantity, ureg
from .emep_eea import emep_eea

WEIGHTS = {
    Aircraft.Type.NARROW_BODY: {
        Class.ECONOMY: 1.0,
        Class.PREMIUM_ECONOMY: 1.0,
        Class.BUSINESS: 1.5,
        Class.FIRST: 1.5,
    },
    Aircraft.Type.WIDE_BODY: {
        Class.ECONOMY: 1.0,
        Class.PREMIUM_ECONOMY: 1.5,
        Class.BUSINESS: 4,
        Class.FIRST: 5,
    },
}

EMEP_EEA = partial(emep_eea, co2_factor=3.16 * ureg.kg / ureg.kg)


def rp1726(
    flight: Flight, flight_estimator: Callable[[Flight], Quantity] = EMEP_EEA
) -> Quantity:
    if flight.class_ is Class.UNKNOWN:
        raise ValueError
    if flight.aircraft is None:
        raise ValueError
    if flight.aircraft.type_ is None or flight.aircraft.seating is None:
        raise ValueError
    if flight.cargo_weight is None:
        raise ValueError
    co2e = flight_estimator(flight)
    weights = WEIGHTS[flight.aircraft.type_]
    total_seats = sum(flight.aircraft.seating.values())
    total_weighted_seats = sum(
        weights[class_] * num_seats
        for class_, num_seats in flight.aircraft.seating.items()
    )
    passenger_weight = total_seats * 100 * ureg.kg
    passenger_allocation = passenger_weight / (passenger_weight + flight.cargo_weight)
    return co2e * weights[flight.class_] / total_weighted_seats * passenger_allocation
