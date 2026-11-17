// Flight queries over an adsbfi-proxy movement ledger.
//
// The ledger (events.sqlite) is attached as the main database, with
// airports.sqlite as "airports" and aircraft.sqlite as "aircraft".

// A flight is a takeoff followed directly by a landing of the same aircraft.
// Longer gaps mean intermediate movements were missed, so the pair is not a flight.
export const MAX_FLIGHT_SECONDS = 20 * 60 * 60;

// adsbfi-proxy stores takeoffs and landings as separate endpoints and never
// invents a pairing. A flight here is a takeoff followed directly (no other
// movement in between) by a landing of the same aircraft within
// MAX_FLIGHT_SECONDS; its id is the takeoff endpoint_id. Unpaired movements are
// not flights and are left out, because emissions need both airports.
export const EVENT_CTE = `
WITH selected_airports(airport_id) AS (
  SELECT CAST(value AS INTEGER) FROM json_each(@airportIdsJson)
),
selected_types(aircraft_type_id) AS (
  SELECT aircraft_type_id FROM aircraft.aircraft_types WHERE label = @aircraftType
),
takeoff_matches AS (
  SELECT t.endpoint_id, t.icao_id, t.ts, t.airport_id
  FROM selected_airports s
  JOIN endpoints t ON t.airport_id = s.airport_id
  WHERE t.ts >= @startTs AND t.ts < @endTs AND t.is_landing = 0
    AND (@aircraftType IS NULL OR EXISTS (
      SELECT 1 FROM aircraft.aircraft ac
      WHERE ac.icao_id = t.icao_id AND ac.aircraft_type_id IN (SELECT aircraft_type_id FROM selected_types)
    ))
),
landing_matches AS (
  SELECT l.endpoint_id, l.icao_id, l.ts, l.airport_id
  FROM selected_airports s
  JOIN endpoints l ON l.airport_id = s.airport_id
  WHERE l.ts >= @startTs AND l.ts < @endTs AND l.is_landing = 1
    AND (@aircraftType IS NULL OR EXISTS (
      SELECT 1 FROM aircraft.aircraft ac
      WHERE ac.icao_id = l.icao_id AND ac.aircraft_type_id IN (SELECT aircraft_type_id FROM selected_types)
    ))
),
matched AS (
  SELECT
    t.endpoint_id AS event_id,
    t.icao_id,
    t.ts AS takeoff_ts,
    t.airport_id AS takeoff_airport_id,
    l.ts AS landing_ts,
    l.airport_id AS landing_airport_id,
    t.airport_id AS matched_airport_id,
    'takeoff' AS operation
  FROM takeoff_matches t
  JOIN endpoints l ON l.endpoint_id = (
    SELECT n.endpoint_id FROM endpoints n
    WHERE n.icao_id = t.icao_id AND (n.ts, n.is_landing) > (t.ts, 0)
    ORDER BY n.ts, n.is_landing
    LIMIT 1
  )
  WHERE l.is_landing = 1 AND l.ts - t.ts <= @maxFlightSeconds
  UNION ALL
  SELECT
    t.endpoint_id AS event_id,
    l.icao_id,
    t.ts AS takeoff_ts,
    t.airport_id AS takeoff_airport_id,
    l.ts AS landing_ts,
    l.airport_id AS landing_airport_id,
    l.airport_id AS matched_airport_id,
    'landing' AS operation
  FROM landing_matches l
  JOIN endpoints t ON t.endpoint_id = (
    SELECT p.endpoint_id FROM endpoints p
    WHERE p.icao_id = l.icao_id AND (p.ts, p.is_landing) < (l.ts, 1)
    ORDER BY p.ts DESC, p.is_landing DESC
    LIMIT 1
  )
  WHERE t.is_landing = 0 AND l.ts - t.ts <= @maxFlightSeconds
),
filtered AS (
  SELECT * FROM matched
)
`;

export const UNIQUE_EVENTS_CTE = `
unique_events AS (
  SELECT
    event_id,
    icao_id,
    takeoff_ts,
    takeoff_airport_id,
    landing_ts,
    landing_airport_id,
    GROUP_CONCAT(operation || ':' || matched_airport_id, ',') AS operation_matches
  FROM filtered
  GROUP BY event_id, icao_id, takeoff_ts, takeoff_airport_id, landing_ts, landing_airport_id
)
`;

export const EVENT_ROWS_SQL = `
${EVENT_CTE},
${UNIQUE_EVENTS_CTE}
SELECT
  ue.*,
  ac.registration,
  ac.n_number,
  ac.manufacturer,
  ac.model,
  ac.icao_type,
  act.label AS aircraft_type,
  ta.code AS takeoff_airport_code,
  ta.name AS takeoff_airport_name,
  ta.lat_e7 AS takeoff_lat_e7,
  ta.lon_e7 AS takeoff_lon_e7,
  la.code AS landing_airport_code,
  la.name AS landing_airport_name,
  la.lat_e7 AS landing_lat_e7,
  la.lon_e7 AS landing_lon_e7
FROM unique_events ue
LEFT JOIN aircraft.aircraft ac ON ac.icao_id = ue.icao_id
LEFT JOIN aircraft.aircraft_types act ON act.aircraft_type_id = ac.aircraft_type_id
LEFT JOIN airports.airports ta ON ta.airport_id = ue.takeoff_airport_id
LEFT JOIN airports.airports la ON la.airport_id = ue.landing_airport_id
ORDER BY ue.takeoff_ts ASC, ue.event_id ASC
`;

export const EVENT_COUNT_SQL = `
${EVENT_CTE},
${UNIQUE_EVENTS_CTE}
SELECT COUNT(*) AS count FROM unique_events
`;

export const AIRPORT_COUNTS_SQL = `
${EVENT_CTE}
SELECT
  f.matched_airport_id AS airport_id,
  COUNT(*) AS operations,
  SUM(CASE WHEN f.operation = 'takeoff' THEN 1 ELSE 0 END) AS takeoffs,
  SUM(CASE WHEN f.operation = 'landing' THEN 1 ELSE 0 END) AS landings,
  a.code,
  a.name,
  a.lat_e7,
  a.lon_e7,
  t.label AS airport_type
FROM filtered f
JOIN airports.airports a ON a.airport_id = f.matched_airport_id
JOIN airports.airport_types t ON t.airport_type_id = a.airport_type_id
GROUP BY f.matched_airport_id
ORDER BY operations DESC, a.code ASC
`;

export const EVENT_DETAIL_SQL = `
WITH flight AS (
  SELECT
    t.endpoint_id AS event_id,
    t.icao_id,
    t.ts AS takeoff_ts,
    t.airport_id AS takeoff_airport_id,
    l.ts AS landing_ts,
    l.airport_id AS landing_airport_id
  FROM endpoints t
  JOIN endpoints l ON l.endpoint_id = (
    SELECT n.endpoint_id FROM endpoints n
    WHERE n.icao_id = t.icao_id AND (n.ts, n.is_landing) > (t.ts, 0)
    ORDER BY n.ts, n.is_landing
    LIMIT 1
  )
  WHERE t.endpoint_id = @eventId AND t.is_landing = 0
    AND l.is_landing = 1 AND l.ts - t.ts <= @maxFlightSeconds
)
SELECT
  e.event_id,
  e.icao_id,
  e.takeoff_ts,
  e.takeoff_airport_id,
  e.landing_ts,
  e.landing_airport_id,
  NULL AS operation_matches,
  ac.registration,
  ac.n_number,
  ac.manufacturer,
  ac.model,
  ac.icao_type,
  ac.owner_name,
  ac.owner_city,
  ac.owner_state,
  ac.owner_country,
  ac.owner_type,
  ac.year_mfr,
  act.label AS aircraft_type,
  ta.code AS takeoff_airport_code,
  ta.name AS takeoff_airport_name,
  ta.lat_e7 AS takeoff_lat_e7,
  ta.lon_e7 AS takeoff_lon_e7,
  la.code AS landing_airport_code,
  la.name AS landing_airport_name,
  la.lat_e7 AS landing_lat_e7,
  la.lon_e7 AS landing_lon_e7
FROM flight e
LEFT JOIN aircraft.aircraft ac ON ac.icao_id = e.icao_id
LEFT JOIN aircraft.aircraft_types act ON act.aircraft_type_id = ac.aircraft_type_id
LEFT JOIN airports.airports ta ON ta.airport_id = e.takeoff_airport_id
LEFT JOIN airports.airports la ON la.airport_id = e.landing_airport_id
`;
