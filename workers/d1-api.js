const JSON_HEADERS = {
  "content-type": "application/json; charset=utf-8",
};

function json(payload, status = 200) {
  return new Response(JSON.stringify(payload), { status, headers: JSON_HEADERS });
}

function authorized(request, env) {
  const token = env.PJET_API_TOKEN;
  if (typeof token !== "string" || !token) return null;
  return request.headers.get("authorization") === `Bearer ${token}`;
}

function parseTime(value, field) {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`${field} is required`);
  }
  const text = value.trim();
  const parsed = Date.parse(/^\d{4}-\d{2}-\d{2}$/.test(text) ? `${text}T00:00:00Z` : text);
  if (!Number.isFinite(parsed)) {
    throw new Error(`${field} must be an ISO date or datetime`);
  }
  return Math.floor(parsed / 1000);
}

function toIso(value) {
  return value === null || value === undefined ? null : new Date(Number(value) * 1000).toISOString();
}

function icaoHex(value) {
  return Number(value).toString(16).padStart(6, "0");
}

function rowToAirport(row) {
  return {
    airportId: row.airport_id,
    code: row.code,
    name: row.name,
    latitude: row.lat_e7 / 1e7,
    longitude: row.lon_e7 / 1e7,
    airportType: row.airport_type,
  };
}

async function queryAll(statement) {
  const result = await statement.all();
  return result.results || [];
}

async function airports(request, env) {
  const url = new URL(request.url);
  const minLat = Number(url.searchParams.get("minLat"));
  const maxLat = Number(url.searchParams.get("maxLat"));
  const minLon = Number(url.searchParams.get("minLon"));
  const maxLon = Number(url.searchParams.get("maxLon"));
  const airportType = url.searchParams.get("type") || null;
  const excludeType = url.searchParams.get("excludeType") || null;
  if (![minLat, maxLat, minLon, maxLon].every(Number.isFinite)) {
    throw new Error("minLat, minLon, maxLat, and maxLon must be numeric");
  }
  const rows = await queryAll(
    env.AIRPORTS_DB.prepare(
      `
      SELECT a.airport_id, a.code, a.name, a.lat_e7, a.lon_e7, t.label AS airport_type
      FROM airports a
      JOIN airport_types t ON t.airport_type_id = a.airport_type_id
      WHERE a.lat_e7 BETWEEN ?1 AND ?2
        AND a.lon_e7 BETWEEN ?3 AND ?4
        AND (?5 IS NULL OR t.label = ?5)
        AND (?6 IS NULL OR t.label != ?6)
      ORDER BY a.code
      `
    ).bind(
      Math.round(Math.min(minLat, maxLat) * 1e7),
      Math.round(Math.max(minLat, maxLat) * 1e7),
      Math.round(Math.min(minLon, maxLon) * 1e7),
      Math.round(Math.max(minLon, maxLon) * 1e7),
      airportType,
      excludeType
    )
  );
  return json({ count: rows.length, airports: rows.map(rowToAirport) });
}

function normalizeAirportIds(value) {
  if (!Array.isArray(value)) throw new Error("airportIds must be an array");
  return [...new Set(value.map(Number).filter((item) => Number.isInteger(item) && item > 0))];
}

async function lookupAircraft(env, icaoIds) {
  if (!icaoIds.length) return new Map();
  const rows = [];
  for (let index = 0; index < icaoIds.length; index += 80) {
    const chunk = icaoIds.slice(index, index + 80);
    const placeholders = chunk.map((_, offset) => `?${offset + 1}`).join(",");
    rows.push(
      ...(await queryAll(
        env.AIRCRAFT_DB.prepare(
          `
          SELECT a.icao_id, a.registration, a.n_number, a.manufacturer, a.model, t.label AS aircraft_type
          FROM aircraft a
          JOIN aircraft_types t ON t.aircraft_type_id = a.aircraft_type_id
          WHERE a.icao_id IN (${placeholders})
          `
        ).bind(...chunk)
      ))
    );
  }
  return new Map(rows.map((row) => [row.icao_id, row]));
}

async function lookupAirports(env, airportIds) {
  if (!airportIds.length) return new Map();
  const rows = [];
  for (let index = 0; index < airportIds.length; index += 80) {
    const chunk = airportIds.slice(index, index + 80);
    const placeholders = chunk.map((_, offset) => `?${offset + 1}`).join(",");
    rows.push(
      ...(await queryAll(
        env.AIRPORTS_DB.prepare(
          `
          SELECT a.airport_id, a.code, a.name, a.lat_e7, a.lon_e7, t.label AS airport_type
          FROM airports a
          JOIN airport_types t ON t.airport_type_id = a.airport_type_id
          WHERE a.airport_id IN (${placeholders})
          `
        ).bind(...chunk)
      ))
    );
  }
  return new Map(rows.map((row) => [row.airport_id, row]));
}

async function events(request, env) {
  const payload = request.method === "GET" ? payloadFromUrl(request) : await request.json();
  const startTs = parseTime(payload.start, "start");
  const endTs = parseTime(payload.end, "end");
  if (endTs <= startTs) throw new Error("end must be after start");
  const airportIds = normalizeAirportIds(payload.airportIds);
  const aircraftType = typeof payload.aircraftType === "string" && payload.aircraftType.trim() ? payload.aircraftType.trim() : null;
  if (!airportIds.length) return json({ count: 0, airportCount: 0, events: [], airportCounts: [] });

  const airportIdJson = JSON.stringify(airportIds);
  const rawRows = await queryAll(
    env.EVENTS_DB.prepare(
      `
      WITH selected_airports(airport_id) AS (
        SELECT CAST(value AS INTEGER) FROM json_each(?1)
      ),
      matched AS (
        SELECT e.*, e.takeoff_airport_id AS matched_airport_id, 'takeoff' AS operation
        FROM events e
        JOIN selected_airports s ON s.airport_id = e.takeoff_airport_id
        WHERE e.takeoff_ts >= ?2 AND e.takeoff_ts < ?3
        UNION ALL
        SELECT e.*, e.landing_airport_id AS matched_airport_id, 'landing' AS operation
        FROM events e
        JOIN selected_airports s ON s.airport_id = e.landing_airport_id
        WHERE e.landing_ts >= ?2 AND e.landing_ts < ?3
      )
      SELECT
        event_id,
        icao_id,
        takeoff_ts,
        takeoff_airport_id,
        landing_ts,
        landing_airport_id,
        GROUP_CONCAT(operation || ':' || matched_airport_id, ',') AS operation_matches
      FROM matched
      GROUP BY event_id, icao_id, takeoff_ts, takeoff_airport_id, landing_ts, landing_airport_id
      ORDER BY takeoff_ts ASC, event_id ASC
      `
    ).bind(airportIdJson, startTs, endTs)
  );

  const aircraftByIcao = await lookupAircraft(env, [...new Set(rawRows.map((row) => row.icao_id))]);
  const filteredRows = aircraftType
    ? rawRows.filter((row) => aircraftByIcao.get(row.icao_id)?.aircraft_type === aircraftType)
    : rawRows;
  const airportIdSet = new Set();
  for (const row of filteredRows) {
    airportIdSet.add(row.takeoff_airport_id);
    airportIdSet.add(row.landing_airport_id);
  }
  const airportsById = await lookupAirports(env, [...airportIdSet]);
  const countsByAirport = new Map();
  for (const row of filteredRows) {
    for (const match of String(row.operation_matches || "").split(",")) {
      const [operation, idText] = match.split(":");
      const airportId = Number(idText);
      if (!airportId) continue;
      const current = countsByAirport.get(airportId) || { operations: 0, takeoffs: 0, landings: 0 };
      current.operations += 1;
      if (operation === "takeoff") current.takeoffs += 1;
      if (operation === "landing") current.landings += 1;
      countsByAirport.set(airportId, current);
    }
  }

  const eventRows = filteredRows.map((row) => {
    const aircraft = aircraftByIcao.get(row.icao_id) || {};
    const takeoffAirport = airportsById.get(row.takeoff_airport_id) || {};
    const landingAirport = airportsById.get(row.landing_airport_id) || {};
    return {
      eventId: row.event_id,
      icao: icaoHex(row.icao_id),
      registration: aircraft.registration || aircraft.n_number || null,
      nNumber: aircraft.n_number || null,
      aircraftModel: [aircraft.manufacturer, aircraft.model].filter(Boolean).join(" ") || null,
      aircraftType: aircraft.aircraft_type || "unknown",
      takeoffTime: toIso(row.takeoff_ts),
      takeoffAirportId: row.takeoff_airport_id,
      takeoffAirportCode: takeoffAirport.code || null,
      takeoffAirportName: takeoffAirport.name || null,
      landingTime: toIso(row.landing_ts),
      landingAirportId: row.landing_airport_id,
      landingAirportCode: landingAirport.code || null,
      landingAirportName: landingAirport.name || null,
      operationMatches: row.operation_matches,
    };
  });

  const airportCounts = [...countsByAirport.entries()]
    .map(([airportId, counts]) => {
      const airport = airportsById.get(airportId) || {};
      return {
        airportId,
        code: airport.code || null,
        name: airport.name || null,
        latitude: airport.lat_e7 / 1e7,
        longitude: airport.lon_e7 / 1e7,
        airportType: airport.airport_type || null,
        ...counts,
      };
    })
    .sort((a, b) => b.operations - a.operations || String(a.code).localeCompare(String(b.code)));

  return json({ count: eventRows.length, airportCount: airportCounts.length, events: eventRows, airportCounts });
}

function payloadFromUrl(request) {
  const url = new URL(request.url);
  return {
    start: url.searchParams.get("start"),
    end: url.searchParams.get("end"),
    aircraftType: url.searchParams.get("aircraftType"),
    airportIds: String(url.searchParams.get("airportIds") || "")
      .split(",")
      .filter(Boolean)
      .map(Number),
  };
}

async function meta(env) {
  const eventRow = await env.EVENTS_DB.prepare(
    "SELECT COUNT(*) AS count, MIN(takeoff_ts) AS min_ts, MAX(landing_ts) AS max_ts FROM events"
  ).first();
  const aircraftTypes = await queryAll(env.AIRCRAFT_DB.prepare("SELECT label FROM aircraft_types ORDER BY label"));
  const airportTypes = await queryAll(env.AIRPORTS_DB.prepare("SELECT label FROM airport_types ORDER BY label"));
  return json({
    events: Number(eventRow?.count || 0),
    minTime: toIso(eventRow?.min_ts),
    maxTime: toIso(eventRow?.max_ts),
    aircraftTypes: aircraftTypes.map((row) => row.label),
    airportTypes: airportTypes.map((row) => row.label),
  });
}

export default {
  async fetch(request, env) {
    try {
      const hasAuthorization = authorized(request, env);
      if (hasAuthorization === null) {
        return json({ error: "PJET_API_TOKEN must be configured as a Worker secret" }, 503);
      }
      if (!hasAuthorization) return json({ error: "Unauthorized" }, 401);
      const url = new URL(request.url);
      if (url.pathname === "/api/meta") return meta(env);
      if (url.pathname === "/api/airports") return airports(request, env);
      if (url.pathname === "/api/events") return events(request, env);
      return json({ error: "Not found" }, 404);
    } catch (error) {
      const status = /required|must|after|array|numeric/.test(error.message || "") ? 400 : 500;
      return json({ error: error.message || "Request failed" }, status);
    }
  },
};
