from pathlib import Path
from typing import TextIO

import pandas as pd

from ..aircraft import Class
from ..flights import Flight
from ..units import Quantity, ureg
from ..utils import interpolate


def load_load_factors(
    file: Path | TextIO = Path("data/methods/icao_load_factors.csv"),
) -> pd.DataFrame:
    df = pd.read_csv(file, index_col=0)

    def _parse(route_group: str) -> tuple[str, str]:
        pair = route_group.split(" - ")
        if len(pair) == 2:
            return tuple(sorted(pair))
        region = route_group[6:]
        return (region, region)

    df.index = df.index.map(_parse)
    df.index = df.index.set_names(("Origin", "Destination"))
    return df


def load_regions(
    file: Path | TextIO = Path("data/methods/icao_regions.csv"),
) -> pd.DataFrame:
    """Load region definitions.

    Taken from the long-term traffic forecasts:
    https://www.icao.int/sustainability/documents/ltf_charts-results_2018edition.pdf
    """
    return pd.read_csv(file, index_col=3)


def load_fuel_burn(
    fuel_burn_file: Path | TextIO = Path("data/methods/icao_fuel_burn.csv"),
    aircraft_mapping_file: Path
    | TextIO = Path("data/methods/icao_aircraft_mapping.csv"),
):
    fuel_burn_df = pd.read_csv(fuel_burn_file, index_col=0).astype(float)
    columns = fuel_burn_df.columns.to_frame()
    columns.insert(1, None, ["kg"] * 20)
    fuel_burn_df.columns = pd.MultiIndex.from_frame(columns, names=["Distance", "Unit"])
    fuel_burn_df = fuel_burn_df.pint.quantify()

    aircraft_mapping_df = pd.read_csv(aircraft_mapping_file, index_col=0)
    df = pd.merge(
        aircraft_mapping_df,
        fuel_burn_df,
        how="inner",
        left_on=["Equivalent"],
        right_index=True,
    )
    df = df.drop(columns="Equivalent")
    df.columns = df.columns.astype(float).astype("pint[nmi]")
    return df


WEIGHTS = {
    Class.ECONOMY: 1.0,
    Class.PREMIUM_ECONOMY: 2.0,
    Class.BUSINESS: 2.0,
    Class.FIRST: 2.0,
}


def icao_pax(
    flight: Flight,
    co2_factor: Quantity = 3.16 * ureg.kg / ureg.kg,
    load_factors_data: pd.DataFrame | None = None,
    regions_data: pd.DataFrame | None = None,
    fuel_burn_data: pd.DataFrame | None = None,
) -> Quantity:
    if flight.aircraft is None:
        raise ValueError
    if flight.aircraft.seating is None:
        raise ValueError

    passenger_load_factor, passenger_freight_factor = flight_to_load_factor(
        flight, load_factors_data, regions_data
    )
    fuel = icao_flight(flight, fuel_burn_data)

    # The cabin class correction factor only applies on flights of more than
    # 3,000 km; shorter flights are treated as all-economy.
    weights = WEIGHTS if flight.distance > 3000 * ureg.km else dict.fromkeys(WEIGHTS, 1.0)

    total_weighted_seats = sum(
        weights[class_] * num_seats
        for class_, num_seats in flight.aircraft.seating.items()
    )

    co2_per_pax = (
        co2_factor
        * fuel
        * passenger_freight_factor
        / (total_weighted_seats * passenger_load_factor)
    )
    return co2_per_pax * weights[flight.class_]


def flight_to_load_factor(
    flight: Flight,
    load_factors_data: pd.DataFrame | None = None,
    regions_data: pd.DataFrame | None = None,
) -> tuple[float, float]:
    load_factors = (
        load_factors_data if load_factors_data is not None else load_load_factors()
    )
    regions = regions_data if regions_data is not None else load_regions()

    origin_continent, origin_region, _ = regions.loc[flight.origin.country]
    destination_continent, destination_region, _ = regions.loc[
        flight.destination.country
    ]
    for pair in [
        (origin_region, destination_region),
        (origin_continent, destination_region),
        (origin_region, destination_continent),
        (origin_continent, destination_continent),
    ]:
        pair = tuple(sorted(pair))
        if pair in load_factors.index:
            return tuple(load_factors.loc[pair])  # type: ignore
    else:
        raise ValueError


def icao_flight(
    flight: Flight,
    fuel_burn_data: pd.DataFrame | None = None,
) -> Quantity:
    if flight.aircraft is None:
        raise ValueError
    if flight.aircraft.iata_code is None:
        raise ValueError
    if flight.aircraft.seating is None:
        raise ValueError

    fuel_burn = fuel_burn_data if fuel_burn_data is not None else load_fuel_burn()

    distance = flight.distance
    if flight.distance < 550 * ureg.km:
        distance += 50 * ureg.km
    elif flight.distance < 5500 * ureg.km:
        distance += 100 * ureg.km
    else:
        distance += 125 * ureg.km

    fuel = interpolate(
        distance,
        fuel_burn.columns.values,
        fuel_burn.loc[flight.aircraft.iata_code].values,
    )

    return fuel.to("kg")
