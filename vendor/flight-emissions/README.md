# Flight emissions calculator

This repository contains re-implementations of methods used to calculate the greenhouse gas (GHG) emissions of a single flight and/or a single seat on a flight. There are a lot of different ways of doing this.

> [!WARNING]
> This code was written several years ago and is provided as-is, without any guarantees of correctness or fitness for any purpose. Some of the bundled datasets (e.g., EUROCONTROL's small emitters tool data, ICAO fuel burn tables) are a few years old and may no longer reflect the latest fleet or emission factors. The data loaders in `ghgc/methods/` and `ghgc/airports.py` document where each dataset comes from, so they should be relatively easy to refresh with newer releases if needed.

## Usage

To estimate the footprint of a single passenger on a flight, the [Travel CO2](https://travelco2.com/about) method only needs the origin, destination, seating class, and whether the flight is scheduled or chartered:

```python
from ghgc.aircraft import Class
from ghgc.airports import load_airports
from ghgc.flights import Flight, Service
from ghgc.methods.travelco2 import air

airports = {airport.iata_code: airport for airport in load_airports()}

flight = Flight(
    origin=airports["AMS"],
    destination=airports["SFO"],
    class_=Class.ECONOMY,
    service=Service.SCHEDULED,
)

co2e = air(flight)
print(co2e.to("kg"))  # 1173.98 kilogram
```

`Flight`, `Aircraft`, and `Airport` are plain dataclasses, so they can be constructed directly without loading any of the bundled datasets. Quantities are returned as [pint](https://pint.readthedocs.io/) `Quantity` objects, which can be converted to other units (e.g., `.to("kgCO2e")`).

Methods that take the specific aircraft and its seating layout into account, such as ICAO's, can give a more accurate estimate at the cost of needing more information:

```python
from ghgc.aircraft import Aircraft, Class
from ghgc.methods.icao import icao_pax

flight.aircraft = Aircraft(
    name="Boeing 787-9",
    iata_code="789",
    type_=Aircraft.Type.WIDE_BODY,
    seating={Class.ECONOMY: 250, Class.PREMIUM_ECONOMY: 30, Class.BUSINESS: 30},
)

co2e = icao_pax(flight)
print(co2e.to("kg"))  # 438.56 kilogram
```

Note how much these numbers can differ: the Travel CO2 estimate above is roughly 2.7x higher than the ICAO one, mostly because it adds well-to-tank emissions and a non-CO₂ multiplier for effects like contrails, while the ICAO method here only accounts for the CO₂ from fuel burnt. Always check what a calculator does and doesn't include before comparing numbers between methods.

## Supported methods

Methods for apportioning a flight's emissions to a single passenger:

* [UK's GHG reporting](https://www.gov.uk/government/collections/government-conversion-factors-for-company-reporting) (`ghgc.methods.uk_ghg`)
* Google's [Travel Impact Model](https://github.com/google/travel-impact-model) (`ghgc.methods.google`)
* [IATA's RP 1726 methodology](https://www.iata.org/en/programs/environment/passenger-emissions-methodology/) (`ghgc.methods.iata`)
* [ICAO's methodology](https://www.icao.int/environmental-protection/Carbonoffset/Pages/default.aspx) (`ghgc.methods.icao`)
* [Travel CO2's methodology](https://travelco2.com/about) (`ghgc.methods.travelco2`)

Methods for estimating the fuel burn and CO₂ emissions of a flight itself, used as a building block by some of the methods above:

* EUROCONTROL's [small emitters tool](https://www.eurocontrol.int/tool/small-emitters-tool) (`ghgc.methods.eurocontrol`)
* The Tier 3A method from the [EEA/EMEP air pollutant emission inventory guidebook](https://www.eea.europa.eu/publications/emep-eea-guidebook-2019/part-b-sectoral-guidance-chapters/1-energy/1-a-combustion/1-a-3-a-aviation/view) (`ghgc.methods.emep_eea`)

## Background

### Flight emissions

Calculating the emissions of a single flight usually starts with a bottom-up approach. Tools such as EUROCONTROL's [Advanced Emission Model (AEM)](https://www.eurocontrol.int/model/advanced-emission-model) or [Piano-X](https://lissys.uk/PianoX.html) take in details such as the engines, airframe, flight trajectory, taxi times, atmosphere, etc. and are able to output an accurate estimate of the amount of fuel burnt and compounds emitted.

In turn, these tools are based on datasets such as EUROCONTROL's [Base of aircraft data](https://www.eurocontrol.int/model/bada) (BADA) and the ICAO's [Aircraft Engine Emissions Databank](https://www.easa.europa.eu/en/domains/environment/icao-aircraft-engine-emissions-databank) (AEED) which contain data from engine manufacturers.

#### Non-CO₂ factors

The amount of fuel burnt is an important driver of a flight's impact on the climate. The amount of CO₂ emitted per kilo of fuel is usually a simple calculation (multiplying by a factor of 3.05-3.16). However, there are many other factors that can (and should) be incorporated:

* Contrail cirrus
* Well-to-tank emissions are the emissions produced in the production, processing, and delivery of the fuel
* Adjusting distance for indirect flight paths and delays
* Nitrogen oxide (NO<sub>x</sub>) and methane emissions

Note that although there is more uncertainty surrounding these factors, the latest science shows that they can increase the CO₂-equivalent emissions with [as much as a factor 3](https://doi.org/10.1016/j.atmosenv.2020.117834) when measured using GWP*-100 (table 5).

#### Global warming potential

The impact of these other factors is expressed using CO₂-equivalent (CO₂-eq): The equivalent amount of CO₂ that would warm the earth just as much. This is commonly calculated using the global warming potential (GWP). For example, methane (CH₄) has a GWP-100 of approx. 27.9 ([ref](https://www.ipcc.ch/report/ar6/wg1/downloads/report/IPCC_AR6_WGI_Chapter_07_Supplementary_Material.pdf)). This means that 1 kg of CH₄ contributes to global as much as 27.9 CO₂ given a 100 year time horizon.

Calculating the GWP is in itself complicated. Not only does it require estimating the global warming potential of a specific compound, it also depends on the time horizon used (commonly 100 years is used), whether indirect effects and feedbacks are considered, what discount rate is used, etc. Alternative measures such as [global temperature potential](https://archive.ipcc.ch/pdf/assessment-report/ar5/wg1/WG1AR5_Chapter08_FINAL.pdf) (GTP) or [GWP*](https://www.nature.com/articles/s41612-019-0086-4) have also been proposed. GTP goes further than GWP and actually tries to estimate the relative temperature change, whereas GWP* tries to address differences between short- and long-lived pollutants.

#### Average values

In many cases the detailed information required to estimate the exact fuel usage (e.g., engine types, taxi times) is not available. Tools such as EUROCONTROL's [small emitters tool](https://www.eurocontrol.int/tool/small-emitters-tool) (SET) and the Tier 3A method from the [EEA/EMEP air pollutant emission inventory guidebook](https://www.eea.europa.eu/publications/emep-eea-guidebook-2019/part-b-sectoral-guidance-chapters/1-energy/1-a-combustion/1-a-3-a-aviation/view) used flight statistics to derive average values.

### Passenger emissions

Given models that can estimate the CO₂-eq for a flight, these emissions must be apportioned to the passengers. This depends on a variety of things:

* Amount of freight carried
* Relative area taken by the different seating classes (economy, premium economy, business, first)
* Load factor (i.e., empty seats)
* Handling unknown aircraft types
