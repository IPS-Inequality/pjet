#!/usr/bin/env python3
"""Export the EUROCONTROL SET fuel-curve table from the official calculator workbook.

Reads the hidden "Data" sheet of a EUROCONTROL Small Emitters Tool workbook
obtained under an appropriate data-use agreement and writes a local CSV for
the optional EUROCONTROL models. The workbook and generated CSV are not
redistributed with this repository.

The per-row CO2_COEFF is exported as-is from the workbook (3.15 jet/turboprop,
3.10 piston); the server substitutes the EU ETS jet/turboprop factor at load
time, mirroring the SET v5.15 Calculator formula.

Usage:
  uv run --with openpyxl python scripts/export-eurocontrol-set-csv.py \
      /path/to/set-workbook.xlsx \
      data/eurocontrol.csv
"""

import sys
from pathlib import Path

import openpyxl

COLUMNS = [
    "ICAO_TYPE_CODE",
    "CO2_COEFF",
    "CORR_FACTOR",
    "BreakPoint_1",
    "BreakPoint_2",
    "Slope_1",
    "Slope_2",
    "Slope_3",
    "Intercept_1",
    "Intercept_2",
    "Intercept_3",
]
HEADER_ROW = 2


def format_cell(value):
    if value is None:
        return ""
    if isinstance(value, str):
        return value
    return format(value, ".10g")


def main():
    if len(sys.argv) != 3:
        sys.exit(f"usage: {sys.argv[0]} <set-workbook.xlsx> <output.csv>")
    workbook_path, output_path = sys.argv[1], sys.argv[2]

    workbook = openpyxl.load_workbook(workbook_path, read_only=True, data_only=True)
    sheet = workbook["Data"]
    rows = sheet.iter_rows(min_row=HEADER_ROW, values_only=True)
    header = next(rows)
    try:
        indexes = [header.index(name) for name in COLUMNS]
    except ValueError as error:
        sys.exit(f"missing expected column in Data sheet header: {error}")

    lines = [",".join(COLUMNS)]
    for row in rows:
        if row[indexes[0]] is None:
            continue
        lines.append(",".join(format_cell(row[index]) for index in indexes))
    workbook.close()

    # The 2022 export used CRLF with no trailing newline; we normalize to Unix
    # newlines (both the Node and Python CSV readers accept either).
    Path(output_path).parent.mkdir(parents=True, exist_ok=True)
    with open(output_path, "w", newline="\n") as output:
        output.write("\n".join(lines) + "\n")
    print(f"wrote {len(lines) - 1} aircraft types to {output_path}")


if __name__ == "__main__":
    main()
