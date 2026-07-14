"""Calculate flight emissions using the UK's GHG conversion factors.

This methodology^[1] is a bottom-up approach: EUROCONTROL's small emitter
tool^[2] (2019) was used to calculate the emissions of all flights in a
non-public dataset of UK flights (see table 34). The following is then used to
come to a conversion factor for passenger kilometers:

* Average load factor of aircraft (table 34)
* Proportion of passenger kms of aircraft (table 34)
* Allocating flights into haul categories (8.8)
* Taking account of freight (table 36)
* Scaling seating classes (8.18)
* Adding CH4 and N2O emissions using a top-down calculation (table 43)

The final numbers in table 44 are excluding two more correction factors:

* Increase great circle distance by 8% (8.37)
* Take into account non-CO2 effects (e.g., contrails; 8.42) by multiplying CO2
  emissions by 1.9

[1]: https://www.gov.uk/government/publications/greenhouse-gas-reporting-conversion-factors-2022.
[2]: https://www.eurocontrol.int/tool/small-emitters-tool
"""
from collections.abc import Callable
from enum import StrEnum
from pathlib import Path
from typing import TextIO

import pandas as pd

from ..aircraft import Class
from ..flights import Flight
from ..units import Quantity, ureg


class Haul(StrEnum):
    DOMESTIC = "D"
    LONG = "Long"
    SHORT = "Short"
    INTERNATIONAL = "International"


def load_data(file: Path | TextIO = Path("data/methods/uk_ghg_factors.csv")):
    df = pd.read_csv(file, index_col=[0, 1], header=[0, 1])
    df.index.names = ["Haul", "Class"]

    # Parse haul and seating class
    # TODO: Update CSV instead
    def _to_enum(index):
        haul_str, class_str = index
        haul = next(haul for haul in Haul if haul_str.startswith(haul))
        try:
            class_ = next(
                class_ for class_ in Class if class_str.lower().startswith(class_)
            )
        except StopIteration:
            class_ = Class.UNKNOWN
        return haul, class_

    df.index = df.index.map(_to_enum)

    # Add units
    columns = df.columns.to_frame()
    columns.insert(2, None, ["kgCO2e / km"] * 8)
    df.columns = pd.MultiIndex.from_frame(columns, names=["RF", "Compound", "Unit"])

    return df.pint.quantify()


def load_hauls(
    file: Path | TextIO = Path("data/methods/uk_ghg_haul.csv"),
) -> pd.DataFrame:
    return pd.read_csv(file, converters={"Haul": Haul}, index_col=2)


def all_international(_: Flight) -> Haul:
    """Use same conversion factors for all flights."""
    return Haul.INTERNATIONAL


def short_long(flight: Flight) -> Haul:
    """Allocate flights to short or long haul based on distance.

    This was used in older versions of the methodology (see methodology, 8.8).
    """
    if flight.distance < 3700 * ureg.km:
        return Haul.SHORT
    else:
        return Haul.LONG


def exact(flight: Flight, data: pd.DataFrame | None = None) -> Haul:
    """Allocate flights based on origin and destination countries.

    See methodology (8.9) and the Haul_definition tab for details.
    """
    hauls = data if data is not None else load_hauls()
    if flight.origin.country in ("IM", "GB"):
        return hauls.loc[flight.destination.country]["Haul"]
    elif flight.destination.country in ("IM", "GB"):
        return hauls.loc[flight.origin.country]["Haul"]
    else:
        return Haul.INTERNATIONAL


def uk_ghg(
    flight: Flight,
    distance_uplift: float = 1.08,
    radiative_forcing_uplift: float = 1.9,
    allocate: Callable[[Flight], Haul] = exact,
    data: pd.DataFrame | None = None,
) -> Quantity:

    if flight.aircraft is not None:
        # Although not part of the methodology, enough data is available to
        # calculate aircraft-specific emissions:
        # aircraft_co2_per_km / num_seats (34) / load_factor (34) *
        # passenger_allocation (36) * class_weight (38) +
        # ch4_per_km + n2o_per_km (44)
        pass

    df = data if data is not None else load_data()

    haul = allocate(flight)
    df: pd.DataFrame = df.loc[haul, flight.class_]["Without RF"]  # type: ignore

    with ureg.context("AR4"):
        co2 = (df["kg CO2e of CO2 per unit"] / 1.08).to("gCO2 / km")
        ch4 = (df["kg CO2e of CH4 per unit"] / 1.08).to("gCH4 / km")
        n2o = (df["kg CO2e of N2O per unit"] / 1.08).to("gN2O / km")
        co2_with_rf = co2 * radiative_forcing_uplift
        co2e = co2_with_rf + ch4 + n2o
        return co2e * flight.distance * distance_uplift
