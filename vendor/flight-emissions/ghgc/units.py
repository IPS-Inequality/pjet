"""Define units and conversions for measuring emissions.

Each compound has an absolute global warming potential (AGWP): the amount of
heat absorbed in the atmosphere (W/m⁻²) per mass (kg⁻¹) during a certain time
horizon (yr; usually 100 years).

When reporting the amount of emmissions, the mass of each compound is converted
to grams of carbon dioxide equivalent (gCO2e). This is the mass of CO2 which
would have had the same AGWP. These conversion ratios are called global warming
potentials (GWP).

This module also contains some code to help Pydantic models support quantities.
"""
import pint_pandas
from pint import Quantity, UnitRegistry

UNITS = """
gCO2e = [mass]
gCO2 = 1 gCO2e
gCH4 = nan gCO2e
gN2O = nan gCO2e

AGWP_CO2 = nan W / m**2 * yr / kg

# AR4, WG1
@context AR4_100 = AR4
    # Table 2.14
    gCH4 = 25 gCO2e
    gN2O = 298 gCO2e

    AGWP_CO2 = 8.69e-14 W / m**2 * yr / kg
@end

# AR5, WG1
@context AR5_100 = AR5
    # Table 8.7
    gCH4 = 28 gCO2e
    gN2O = 265 gCO2e

    # Table 8.A.1
    AGWP_CO2 = 9.17e-14 W / m**2 * yr / kg
@end

# AR6, WGI
@context AR6_100 = AR6
    # Table 7.SM.7
    gCH4 = 27.9 gCO2e
    gN2O = 273 gCO2e

    AGWP_CO2 = 0.0895 pW / m**2 * yr / kg
@end
"""

ureg = UnitRegistry()
ureg.load_definitions(UNITS.splitlines())
pint_pandas.PintType.ureg.set(ureg)

__all__ = ["Quantity", "ureg"]
