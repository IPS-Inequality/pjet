"""Tier 3A method from EMEP/EEA air pollutant emission inventory guidebook.

This method uses data from EUROCONTROL, so its results should be similar. Note
that this method focuses on air pollution rather than greenhouse gases, so it
does not calculate methane (CH4) or nitrous ocide (N2O) emissions. These should
be relatively minor however.

The method does not explicitly correct for non-direct flight paths, so using the
great circle distance (GCD) of a scheduled flight might be a small
underestimation.
"""
from enum import StrEnum
from pathlib import Path
from typing import TextIO

import pandas as pd

from ..flights import Flight
from ..units import Quantity
from ..utils import interpolate


def load_data(file: Path | TextIO = Path("data/methods/emep_eea.csv")) -> pd.DataFrame:
    df = pd.read_csv(file, index_col=[0, 1])
    df.columns = pd.MultiIndex.from_arrays([df.columns, ["nmi", "kg", "kg / kg"]])
    return df.pint.quantify()


class LTO(StrEnum):
    ICAO = "LTO"
    EU = "LTO-2"


def emep_eea(
    flight: Flight,
    lto: LTO = LTO.ICAO,
    co2_factor: Quantity | None = None,
    data: pd.DataFrame | None = None,
    distance: Quantity | None = None,
) -> Quantity:
    if flight.aircraft is None:
        raise ValueError
    df = data if data is not None else load_data()
    df = df.loc[flight.aircraft.icao_code]
    # TODO: Don't extrapolate below 125 but interpolate with origin
    fuel = (
        interpolate(
            distance if distance is not None else flight.distance,
            df.loc["CCD"]["DISTANCE NM"].values,
            df.loc["CCD"]["FUEL BURNT KG"].values,
        )
        + df.loc[lto]["FUEL BURNT KG"]
    )
    return (fuel * (co2_factor or df["CO2 (3,15 or 3,05)"].iloc[0])).to("kg")
