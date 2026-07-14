from dataclasses import dataclass
from enum import StrEnum
from math import asin, cos, radians, sin, sqrt

from .aircraft import Aircraft, Class
from .airports import Airport
from .units import Quantity, ureg


class Service(StrEnum):
    SCHEDULED = "scheduled"
    CHARTER = "charter"


@dataclass
class Flight:
    origin: Airport
    destination: Airport
    class_: Class = Class.UNKNOWN
    aircraft: Aircraft | None = None
    cargo_weight: Quantity | None = None
    service: Service | None = None

    @property
    def distance(self) -> Quantity:
        return great_circle_distance(self.origin, self.destination)


EARTH_RADIUS = 6_371 * ureg.km


def hav(x: float, /) -> float:
    """Return the haversine of x radians."""
    return sin(x / 2) ** 2


def great_circle_distance(
    x: Airport, y: Airport, /, radius: Quantity = EARTH_RADIUS
) -> Quantity:
    """Calculate the great cirle distance between two airports in meters."""
    lat1, lon1, lat2, lon2 = map(
        radians, (x.latitude, x.longitude, y.latitude, y.longitude)
    )
    d = 2 * asin(sqrt(hav(lat2 - lat1) + cos(lat1) * cos(lat2) * hav(lon2 - lon1)))
    return radius * d
