# Private Jet Emissions Tracker

PJET is a local API and browser frontend for exploring private-jet takeoff and
landing pairs derived from ADS-B Exchange heatmap data. It builds compact SQLite
databases from a local cache, then serves authenticated queries and emissions
estimates.

## Before you start

A complete historical rebuild is a serious data operation, not a quick demo.
The builder reads 30-minute heatmap files and a full cache is very large.

> **Be considerate of ADS-B Exchange.** Obtaining or backfilling a complete cache
> can make **more than 1 TB of requests and downloads** from ADS-B Exchange. Do
> not launch parallel bulk fetches, respect the provider's terms and rate limits,
> and obtain permission before attempting a historical backfill. Reuse an
> authorized local cache whenever possible.

Using an accessible URL does not grant rights to publish the resulting data or a
derived public service. Before a deployment, confirm that your ADS-B Exchange
agreement permits the specific acquisition, retention, derivative-event, and
publication use you intend. The provider's [service terms](https://www.adsbexchange.com/terms-of-use-011425/)
place restrictions on mass export and redistribution unless they are expressly
authorized.

Generated data is intentionally ignored by Git. Do not commit or publish a cache,
SQLite database, auth database, update status file, or screenshots. In particular,
`aircraft.sqlite` can contain FAA registrant fields, and `auth.sqlite` contains
credential hashes and session-signing material.

## Requirements

- Node.js 20 or newer
- Python 3.12 or newer with [uv](https://docs.astral.sh/uv/)
- Rust, only when using the faster Rust event builder or the incremental updater
- An ADS-B Exchange heatmap cache to build events

Install the application dependencies:

```sh
uv sync
npm ci
```

## Data locations and external volumes

By default, PJET writes all generated files under the ignored `data/` directory:

```text
data/
  pjet/       # events.sqlite, airports.sqlite, aircraft.sqlite, build_state.sqlite, auth.sqlite
  adsbx/      # YYYY/MM/DD/SS.bin.ttf heatmap cache
  aircraft/   # optional ADS-B Exchange, tar1090, and OpenSky metadata inputs
  faa/        # optional FAA ReleasableAircraft.zip input
```

For a historical rebuild, keep the large cache on an external or attached volume.
The location is deliberately configurable rather than embedded in the code:

```sh
# One root for all ignored local data.
export PJET_DATA_DIR=/path/to/large-volume/pjet-data

# Or override individual locations when the cache and databases are separate.
export PJET_DB_DIR=/path/to/database-volume/pjet
export PJET_ADSBX_CACHE_DIR=/path/to/heatmap-cache
export PJET_AIRCRAFT_CACHE_DIR=/path/to/aircraft-inputs
export PJET_FAA_ZIP=/path/to/faa/ReleasableAircraft.zip
```

`PJET_DB_DIR` is also used by the Node server and Rust builder. The Python builder
uses the same variables, so one configuration works across the toolchain.

## Build the databases

First build the small reference databases. Airport data is downloaded from
OurAirports. Aircraft metadata inputs are optional individually, but supplying
authoritative source files is strongly recommended for useful classifications:

```sh
uv run pjet import-airports
uv run pjet import-aircraft \
  --faa-zip "$PJET_FAA_ZIP" \
  --adsbx-basic-db "$PJET_AIRCRAFT_CACHE_DIR/basic-ac-db.json.gz" \
  --tar1090-db "$PJET_AIRCRAFT_CACHE_DIR/tar1090-aircraft.csv.gz" \
  --opensky-csv "$PJET_AIRCRAFT_CACHE_DIR/opensky-aircraft-database.csv"
```

Then process an existing heatmap cache. Start with a narrow period while verifying
your setup:

```sh
uv run pjet build-events --start 2026-05-01 --end 2026-05-06 --reset
```

Omit `--start` and `--end` only when you intentionally want to process every file
available in the configured cache. The builder checkpoints processed files and keeps
rolling aircraft state in `build_state.sqlite`, so subsequent runs add only newly
completed events.

### Faster Rust builder

The Rust implementation writes the same event and state schemas and is recommended
for large historical rebuilds:

```sh
cd rust/pjet
cargo build --release
cd ../..
./rust/pjet/target/release/pjet build-events --start 2026-05-01 --end 2026-05-06 --reset
```

The incremental updater in `scripts/update-events.mjs` downloads missing
30-minute slots and should only be used after the database and state files have
been initialized. It is not a substitute for permission to bulk-download history.

## Optional EUROCONTROL SET curves

PJET does not redistribute EUROCONTROL Small Emitters Tool workbooks or derived
fuel-curve data. EUROCONTROL states that SET equations are subject to a specific
[data-use agreement](https://www.eurocontrol.int/publication/small-emitters-tool-set-2023).
If you have obtained the workbook under terms that allow your use, export an ignored
local CSV and configure it before starting the server:

```sh
uv run --with openpyxl python scripts/export-eurocontrol-set-csv.py \
  /path/to/authorized-set-workbook.xlsx \
  data/eurocontrol.csv
export PJET_EUROCONTROL_CURVES="$PWD/data/eurocontrol.csv"
```

`data/eurocontrol.csv` is also the default local path, so the export command works
without the environment variable when run from the repository root. Without an
available local curve file, PJET still supports the Adapted Travel Impact Model and
the Combined Model's ATIM fallback; the EUROCONTROL Fast and Slow choices are
omitted.

## Third-party data and privacy

The vendored `flight-emissions` code is Apache-2.0, but its bundled datasets retain
their own provenance and licensing. For example, the OpenFlights airport database is
published under the Open Database License and may require attribution and a compatible
license for public database derivatives. Review every upstream dataset and its current
terms before distributing a generated database or offering it through a public API.

The FAA import can include registrant names and location fields. Even when a source is
public, decide deliberately whether exposing those fields is appropriate for your
deployment and jurisdiction.

## Run locally

Create the initial admin password in the environment and start the API. A new
`auth.sqlite` refuses to start without `PJET_PASSWORD`; there is no default
credential. The password is stored as a salted hash on first start, so later changes
to the environment variable do not replace it.

```sh
export PJET_PASSWORD="$(openssl rand -base64 32)"
HOST=127.0.0.1 PORT=8080 npm run serve
```

Open `http://127.0.0.1:8080/`. Use `/admin` to create or revoke journalist
vouchers. A voucher value is displayed only when it is created, so save it securely.
For an internet-facing deployment, keep the Node process behind HTTPS and add
network-level request limits in the reverse proxy or edge service. PJET also applies
a small in-memory login-failure limit, but that is not a replacement for perimeter
protection.

### Optional Cloudflare D1 worker

`workers/d1-api.js` is an alternative API backend, not part of the local server
above. It fails closed until a deployment configures the `PJET_API_TOKEN` Worker
secret; send that token as `Authorization: Bearer …`. Do not put the token in
`wrangler.toml`, frontend code, or a commit.

## Storage and server sizing

The current complete `events.sqlite` is about **31.7 GB (29.5 GiB)**. Plan for at
least 100 GB of fast SSD storage for the database, indexes, WAL files, and operating
headroom; 200 GB or more is more comfortable if you retain backups or expect growth.

The production reader/updater currently runs successfully on a DigitalOcean Basic
Droplet with **2 vCPUs, 4 GB RAM, and 120 GB disk**. That is a practical minimum for
serving the existing database. For a new public service, 4 vCPUs, 8 GB RAM, and
200 GB+ NVMe storage provide better query and maintenance headroom. A complete
historical cache needs a separate large volume—budget at least 2 TB—and a 4-vCPU,
16-GB-RAM machine is a sensible starting point for a full rebuild.

## API

All API routes except login and session status require an authenticated admin or
voucher session.

`GET /api/airports?minLat=&minLon=&maxLat=&maxLon=&type=` returns airports inside a
rectangular bounding box. `type` is optional and matches an airport type label such
as `heliport`, `small_airport`, or `large_airport`.

`POST /api/events` accepts:

```json
{
  "start": "2026-05-01T00:00:00Z",
  "end": "2026-05-06T00:00:00Z",
  "airportIds": [123, 456],
  "aircraftType": "business_jet"
}
```

It returns matching events, airport operation counts, and emissions estimates.
