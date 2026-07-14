# Cloudflare Deployment Notes

Do not deploy the 1.7 TB ADS-B Exchange cache to Cloudflare. The intended deployment artifact is only the compact SQLite/D1 metadata.

## Shape

- Static UI: Cloudflare Pages or static Worker assets from `public/`.
- API: Worker in `workers/d1-api.js`.
- D1 databases:
  - `EVENTS_DB`: `events` table only.
  - `AIRPORTS_DB`: `airports`, `airport_types`.
  - `AIRCRAFT_DB`: `aircraft`, `aircraft_types`.

The local Express server uses SQLite `ATTACH` for fast joins. D1 does not support cross-database joins, so the Worker queries the event database first, then decorates and filters with bounded chunked lookup queries against the small airport and aircraft databases.

## Initial Load

Use the local builder to generate databases:

```sh
uv run pjet import-airports
uv run pjet import-aircraft
uv run pjet build-events --reset --vacuum
```

Then import the SQLite schema/data into D1 with the globally installed `wrangler`.

Each D1 database has a hard 10 GB size limit on Workers Paid. If the full historical `events.sqlite` exceeds that, shard events by year or month and bind the relevant shards to the Worker. The query API already has a required time range, so routing to only the overlapping shards is straightforward.

## 30-Minute Updates

Run this command every 30 minutes on a machine that has the ADS-B Exchange cache:

```sh
uv run pjet build-events
```

The builder skips already processed heatmap files, keeps active aircraft state in `build_state.sqlite`, stores pending unpaired takeoffs, and inserts only newly completed takeoff/landing pairs. For Cloudflare, export the new event rows and changed state rows to D1 in small batches with `wrangler d1 execute`.

The parser depends on NumPy and local cache files, so it should run off-Cloudflare unless it is rewritten in JavaScript. Keeping the updater outside Workers avoids cron CPU pressure and keeps the Worker API read-mostly.

## Cost Model

For the Louisville-sized request tested locally, the API needs one airport query, one indexed event query, and lookup chunks for the returned aircraft/airports. At dozens to hundreds of requests per day, expected reads are far below D1's included Workers Paid monthly read allowance.

The main cost driver is D1 storage. Keep the event rows and indexes compact, and shard only if a single D1 database approaches 10 GB.
