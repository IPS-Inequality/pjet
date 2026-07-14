from ..aircraft import Class
from ..flights import Flight, Service
from ..units import Quantity, ureg

WEIGHTS = {
    Service.SCHEDULED: {
        Class.ECONOMY: 0.84,
        Class.PREMIUM_ECONOMY: 1.0,
        Class.BUSINESS: 1.9,
    },
    Service.CHARTER: {
        Class.ECONOMY: 0.97,
        Class.PREMIUM_ECONOMY: 1.2,
    },
}


def air(flight: Flight, wtt: float = 0.24, non_co2: float = 0.7) -> Quantity:
    if flight.service is None:
        raise ValueError
    ttw = (0.063 if flight.service is Service.CHARTER else 0.082) * ureg.kg / ureg.km

    return (
        ttw
        * (1 + wtt + non_co2)
        * WEIGHTS[flight.service][flight.class_]
        * flight.distance
    )
