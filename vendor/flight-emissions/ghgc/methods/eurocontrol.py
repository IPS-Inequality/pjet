"""EUROCONTROL's small emitters tool.

This is a Python implementation of the calculations made by EUROCONTROL's small
emitters tool (SET). The relevant data can be found in the hidden "Data" sheet.

Aircraft are listed by ICAO types. Each aircraft's fuel consumption as a
function of distance flown is defined as a piecewise linear funtion with between
one and three segments (times a small aircraft-specific correction factor).

To convert fuel consumption to CO2e emissions an aircraft-specific conversion
factor is used (3.1 or 3.15).

This PJET vendored copy was modified to require an explicitly configured local
curve file. Obtain any SET workbook under the applicable data-use agreement,
then export it with ``scripts/export-eurocontrol-set-csv.py`` and set
``PJET_EUROCONTROL_CURVES`` to that CSV path.
"""
import os
from pathlib import Path
from typing import TextIO

import pandas as pd

from ..flights import Flight
from ..units import Quantity, ureg
from ..utils import interpolate


def load_data(
    file: Path | TextIO | None = None,
) -> pd.DataFrame:
    if file is None:
        configured = os.environ.get("PJET_EUROCONTROL_CURVES")
        if not configured:
            raise FileNotFoundError(
                "PJET_EUROCONTROL_CURVES is required for the EUROCONTROL SET model; "
                "the curve data is not redistributed with PJET."
            )
        file = Path(configured)
    df = pd.read_csv(file, index_col=0)
    df.columns = pd.MultiIndex.from_arrays(
        [
            df.columns,
            [
                "kg / kg",
                "dimensionless",
                "nmi",
                "nmi",
                "kg / nmi",
                "kg / nmi",
                "kg / nmi",
                "kg",
                "kg",
                "kg",
            ],
        ]
    )
    return df.pint.quantify()


def set_(
    flight: Flight,
    gcd_correction: Quantity = 95 * ureg.km,
    data: pd.DataFrame | None = None,
) -> Quantity:
    if flight.aircraft is None:
        raise ValueError
    max_distance = 999999 * ureg.nmi

    df = data if data is not None else load_data()
    x = df.loc[flight.aircraft.icao_code]

    fuel = x["CORR_FACTOR"] * interpolate(
        flight.distance + gcd_correction,
        [0, x["BreakPoint_1"], x["BreakPoint_2"], max_distance],
        [
            x["Intercept_1"],
            x["Intercept_1"] + x["Slope_1"] * x["BreakPoint_1"],
            x["Intercept_2"] + x["Slope_2"] * x["BreakPoint_2"],
            x["Intercept_3"] + x["Slope_3"] * max_distance,
        ],
    )
    return (fuel * x["CO2_COEFF"]).to("kg")
