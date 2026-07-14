const AUGUSTA_BBOX = {
  minLat: 32.85,
  minLon: -82.65,
  maxLat: 34.05,
  maxLon: -81.25,
};

const DEFAULT_DATE_RANGE = {
  start: "2025-04-04T00:00",
  end: "2025-04-15T23:59",
};
const DEFAULT_AIRCRAFT_TYPE = "business_jet";

const PAGE_SIZE = 50;
const AIRPORT_SOURCE_ID = "airports";
const AIRPORT_LAYER_ID = "airport-circles";
const SEARCH_BOUNDS_SOURCE_ID = "search-bounds";
const SEARCH_BOUNDS_LAYER_ID = "search-bounds-outline";
const DRAW_BOUNDS_SOURCE_ID = "draw-bounds";
const DRAW_BOUNDS_LAYER_ID = "draw-bounds-outline";
const FLIGHT_PATH_SOURCE_ID = "selected-flight-path";
const FLIGHT_PATH_LAYER_ID = "selected-flight-path-line";
const FLIGHT_ENDPOINT_SOURCE_ID = "selected-flight-endpoints";
const FLIGHT_ENDPOINT_LAYER_ID = "selected-flight-endpoint-circles";
const BRIGHT_STYLE_URL = "https://tiles.openfreemap.org/styles/bright";
const RESULT_MODE_FLIGHTS = "flights";
const RESULT_MODE_MODELS = "models";
const RESULT_MODE_TYPICAL = "typical";
const DEFAULT_SORT_KEY = "takeoff_time";
const DEFAULT_SORT_DIRECTION = "asc";
const DEFAULT_MODEL_SORT_KEY = "emissions";
const DEFAULT_MODEL_SORT_DIRECTION = "desc";
const FLIGHT_SORT_KEYS = new Set(["n_number", "aircraft_type", "model", "takeoff_time", "landing_time", "emissions"]);
const MODEL_SORT_KEYS = new Set(["model", "gph_source", "flights", "estimated", "hours", "gph", "emissions"]);
const URL_STATE_DECIMALS = 5;
const WEEK_MS = 7 * 24 * 60 * 60 * 1000;
const DATE_RANGE_REFRESH_MIN_MS = 1000;
const ABSOLUTE_DATE_TIME_URL_RE = /(?:Z|[+-]\d{2}:?\d{2})$/i;
const EUROCONTROL_NO_UPPER_LIMIT_NM = 999_999;

const els = {
  loginOverlay: document.getElementById("loginOverlay"),
  loginForm: document.getElementById("loginForm"),
  password: document.getElementById("passwordInput"),
  loginError: document.getElementById("loginError"),
  status: document.getElementById("status"),
  form: document.getElementById("searchForm"),
  start: document.getElementById("startInput"),
  end: document.getElementById("endInput"),
  aircraftType: document.getElementById("aircraftTypeSelect"),
  airportType: document.getElementById("airportTypeSelect"),
  emissionsMethodology: document.getElementById("emissionsMethodologySelect"),
  search: document.getElementById("searchButton"),
  settings: document.getElementById("settingsButton"),
  settingsModal: document.getElementById("settingsModal"),
  settingsClose: document.getElementById("settingsCloseButton"),
  includeWtt: document.getElementById("includeWttToggle"),
  appVersion: document.getElementById("appVersion"),
  minLat: document.getElementById("minLatInput"),
  minLon: document.getElementById("minLonInput"),
  maxLat: document.getElementById("maxLatInput"),
  maxLon: document.getElementById("maxLonInput"),
  useMapBounds: document.getElementById("useMapBoundsButton"),
  drawBounds: document.getElementById("drawBoundsButton"),
  resultsLoading: document.getElementById("resultsLoading"),
  loadingStatus: document.getElementById("loadingStatus"),
  loadingCancel: document.getElementById("loadingCancelButton"),
  loadingBar: document.getElementById("loadingBar"),
  loadingBarFill: document.getElementById("loadingBarFill"),
  airportCount: document.getElementById("airportCount"),
  eventCount: document.getElementById("eventCount"),
  shownCount: document.getElementById("shownCount"),
  queryTime: document.getElementById("queryTime"),
  emissionsTotal: document.getElementById("emissionsTotal"),
  modeToggle: document.getElementById("resultsModeToggle"),
  modeButtons: document.querySelectorAll("[data-result-mode]"),
  exportCsv: document.getElementById("exportCsvButton"),
  exportCsvLabel: document.getElementById("exportCsvLabel"),
  tableWrap: document.getElementById("tableWrap"),
  header: document.getElementById("resultsHeader"),
  body: document.getElementById("resultsBody"),
  prev: document.getElementById("prevPageButton"),
  next: document.getElementById("nextPageButton"),
  pageStatus: document.getElementById("pageStatus"),
  resultsView: document.getElementById("resultsView"),
  flightDetailPanel: document.getElementById("flightDetailPanel"),
  flightDetailTitle: document.getElementById("flightDetailTitle"),
  flightDetailSubtitle: document.getElementById("flightDetailSubtitle"),
  flightDetailBody: document.getElementById("flightDetailBody"),
  flightDetailClose: document.getElementById("flightDetailCloseButton"),
};

const state = {
  map: null,
  airports: [],
  airportCounts: new Map(),
  events: [],
  sortedEvents: [],
  modelGroups: [],
  sortedModelGroups: [],
  typicalRows: [],
  typicalCacheKey: null,
  typicalLoading: false,
  typicalError: "",
  emissions: null,
  appVersion: "",
  eventMinTimeMs: null,
  eventMaxTimeMs: null,
  eventRangeLoading: false,
  eventRangePromise: null,
  eventRangeLastLoadedAt: null,
  eventRangeLastQueryMs: null,
  eventRangeSource: "",
  detailCache: new Map(),
  includeWellToTank: true,
  resultMode: RESULT_MODE_FLIGHTS,
  sortKey: DEFAULT_SORT_KEY,
  sortDirection: DEFAULT_SORT_DIRECTION,
  sortIsDefault: true,
  page: 0,
  timings: null,
  selectedEventId: null,
  latestRequest: 0,
  latestDetailRequest: 0,
  currentSearchAbortController: null,
  currentTypicalAbortController: null,
  loadingStartedAt: null,
  loadingTimer: null,
  drawBoundsActive: false,
  drawBoundsDragging: false,
  drawBoundsStart: null,
  drawBoundsPreviousDragPan: true,
  suppressNextMapClick: false,
  mapReady: false,
  metaReady: false,
  initialSearchStarted: false,
  urlStateUpdatesPaused: true,
  urlStateTimer: null,
  pendingUrlPage: null,
  pendingUrlDetailEventId: null,
};

const initialUrlState = parseUrlState();

function formatNumber(value) {
  return Number(value || 0).toLocaleString();
}

function formatDuration(milliseconds) {
  if (!Number.isFinite(milliseconds)) return "0 ms";
  if (milliseconds < 1000) return `${Math.round(milliseconds)} ms`;
  return `${(milliseconds / 1000).toFixed(2)} s`;
}

function formatUnit(value, unit, maximumFractionDigits = 2) {
  return `${Number(value).toLocaleString(undefined, { maximumFractionDigits })}${unit}`;
}

function formatEmissionsTons(kg) {
  if (!Number.isFinite(kg)) return "None";
  return formatUnit(kg / 1_000, "t");
}

function formatEmissionsKilotonnes(kg) {
  if (!Number.isFinite(kg)) return "None";
  return `${formatSignificant(kg / 1_000_000)}kt`;
}

function formatEmissionsSummary(kg) {
  if (!Number.isFinite(kg)) return "None";
  return Math.abs(kg) >= 1_000_000 ? formatEmissionsKilotonnes(kg) : formatEmissionsTons(kg);
}

function formatTonsCell(kg, decimals = 2) {
  if (!Number.isFinite(kg)) return "";
  return (kg / 1000).toFixed(decimals);
}

function formatKilotonnesCell(kg, decimals = 2) {
  if (!Number.isFinite(kg)) return "";
  return (kg / 1_000_000).toFixed(decimals);
}

function formatHoursCell(hours, decimals = 2) {
  if (!Number.isFinite(hours)) return "";
  return Number(hours).toFixed(decimals);
}

function formatNumberCell(value, decimals = 1) {
  if (!Number.isFinite(value)) return "";
  return Number(value).toFixed(decimals);
}

function formatDecimal(value, decimals = 1) {
  if (!Number.isFinite(value)) return "None";
  return formatNumber(Number(value).toFixed(decimals));
}

function formatSignificant(value, significantDigits = 3) {
  if (!Number.isFinite(value)) return "None";
  return Number(value).toLocaleString(undefined, {
    maximumSignificantDigits: significantDigits,
  });
}

function formatDistanceNm(value) {
  if (!Number.isFinite(value)) return "None";
  return `${formatDecimal(value, 1)} nm`;
}

function formatCurveSegmentEndNm(value) {
  if (value === EUROCONTROL_NO_UPPER_LIMIT_NM) return "No upper limit";
  return formatDistanceNm(value);
}

function formatDistanceKm(value) {
  if (!Number.isFinite(value)) return "None";
  return `${formatDecimal(value, 1)} km`;
}

function formatFuelGallons(value) {
  if (!Number.isFinite(value)) return "None";
  return `${formatDecimal(value, 1)} gal`;
}

function formatFuelGph(value) {
  if (!Number.isFinite(value)) return "None";
  return `${formatSignificant(value)} gph`;
}

function formatCo2eKg(value) {
  if (!Number.isFinite(value)) return "None";
  return `${formatDecimal(value, 1)} kg CO2e`;
}

function formatFuelKg(value) {
  if (!Number.isFinite(value)) return "None";
  return `${formatDecimal(value, 1)} kg fuel`;
}

function formatHours(value) {
  if (!Number.isFinite(value)) return "None";
  if (Math.abs(value) < 1) return `${formatSignificant(value * 60)} min`;
  return `${formatSignificant(value)} hr`;
}

function formatSpeed(value) {
  if (!Number.isFinite(value)) return "None";
  return `${formatDecimal(value, 0)}kt`;
}

function formatDateTime(value) {
  if (!value) return "";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toISOString().replace(".000Z", "Z").replace("T", " ");
}

function eventDurationHours(event) {
  const start = Date.parse(event.takeoffTime);
  const end = Date.parse(event.landingTime);
  if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) return null;
  return (end - start) / (60 * 60 * 1000);
}

function toLocalDateTimeInput(date) {
  const pad = (value) => String(value).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(
    date.getMinutes()
  )}`;
}

function fromLocalDateTimeInput(value) {
  const date = new Date(value);
  return date.toISOString();
}

function dateTimeInputToUrlValue(value) {
  const text = String(value || "").trim();
  if (!text) return "";
  const date = new Date(text);
  return Number.isFinite(date.getTime()) ? date.toISOString() : text;
}

function dateTimeUrlValueToInputValue(value) {
  const text = String(value || "").trim();
  if (!text || !ABSOLUTE_DATE_TIME_URL_RE.test(text)) return text;
  const date = new Date(text);
  return Number.isFinite(date.getTime()) ? toLocalDateTimeInput(date) : text;
}

function localDateTimeInputFromMs(milliseconds) {
  if (!Number.isFinite(milliseconds)) return "";
  return toLocalDateTimeInput(new Date(milliseconds));
}

function parseDateTimeInputParts(value) {
  const match = /^(\d{4,})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/.exec(String(value || ""));
  if (!match) return null;
  return {
    year: match[1],
    month: match[2],
    day: match[3],
    hour: match[4],
    minute: match[5],
  };
}

function formatDateTimeInputParts(parts) {
  return `${parts.year}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}`;
}

function dispatchDateTimeInputUpdate(input) {
  input.dispatchEvent(new Event("input", { bubbles: true }));
  input.dispatchEvent(new Event("change", { bubbles: true }));
}

function dateTimePartsOnlyChanged(previous, next, part) {
  if (!previous || !next || previous[part] === next[part]) return false;
  return ["year", "month", "day", "hour", "minute"].every((key) => key === part || previous[key] === next[key]);
}

function applyAssistedTimeDigit(input, assist, digit) {
  const parts = parseDateTimeInputParts(input.value);
  if (!parts || (assist.timePart !== "hour" && assist.timePart !== "minute")) return false;
  const numericDigit = Number(digit);
  if (!Number.isInteger(numericDigit)) return false;

  if (assist.timePart === "hour") {
    if (!assist.timeDigits) {
      parts.hour = `0${digit}`;
      if (numericDigit > 2) {
        assist.timePart = "minute";
        assist.timeDigits = "";
      } else {
        assist.timeDigits = digit;
      }
    } else {
      const hour = Number(`${assist.timeDigits}${digit}`);
      parts.hour = String(hour > 23 ? numericDigit : hour).padStart(2, "0");
      assist.timePart = "minute";
      assist.timeDigits = "";
    }
  } else if (!assist.timeDigits) {
    parts.minute = `0${digit}`;
    if (numericDigit > 5) {
      assist.timePart = null;
      assist.timeDigits = "";
    } else {
      assist.timeDigits = digit;
    }
  } else {
    parts.minute = `${assist.timeDigits}${digit}`;
    assist.timePart = null;
    assist.timeDigits = "";
  }

  input.value = formatDateTimeInputParts(parts);
  dispatchDateTimeInputUpdate(input);
  return true;
}

function installDateTimeKeyboardAssist(input) {
  const assist = {
    beforeValue: "",
    keyDigit: "",
    timePart: null,
    timeDigits: "",
    yearDigits: "",
  };

  const resetTypingState = () => {
    assist.beforeValue = "";
    assist.keyDigit = "";
    assist.timePart = null;
    assist.timeDigits = "";
    assist.yearDigits = "";
  };

  input.addEventListener("keydown", (event) => {
    if (event.defaultPrevented || event.metaKey || event.ctrlKey || event.altKey) return;
    if (/^\d$/.test(event.key) && assist.timePart) {
      event.preventDefault();
      assist.keyDigit = "";
      applyAssistedTimeDigit(input, assist, event.key);
      return;
    }
    assist.beforeValue = input.value;
    assist.keyDigit = /^\d$/.test(event.key) ? event.key : "";
    if (!assist.keyDigit) resetTypingState();
  });

  input.addEventListener("input", () => {
    if (!assist.keyDigit) return;
    const previous = parseDateTimeInputParts(assist.beforeValue);
    const next = parseDateTimeInputParts(input.value);
    if (dateTimePartsOnlyChanged(previous, next, "year")) {
      assist.yearDigits += assist.keyDigit;
      if (assist.yearDigits.length >= 4) {
        assist.yearDigits = "";
        assist.timePart = "hour";
        assist.timeDigits = "";
      }
    } else {
      assist.yearDigits = "";
      assist.timePart = null;
      assist.timeDigits = "";
    }
    assist.keyDigit = "";
    assist.beforeValue = input.value;
  });

  input.addEventListener("pointerdown", resetTypingState);
  input.addEventListener("blur", resetTypingState);
}

function clampDateInputToEventRange(input) {
  const valueMs = parseTimestampMs(input.value);
  if (!Number.isFinite(valueMs)) return false;
  if (Number.isFinite(state.eventMinTimeMs) && valueMs < state.eventMinTimeMs) {
    input.value = localDateTimeInputFromMs(state.eventMinTimeMs);
    return true;
  }
  if (Number.isFinite(state.eventMaxTimeMs) && valueMs > state.eventMaxTimeMs) {
    input.value = localDateTimeInputFromMs(state.eventMaxTimeMs);
    return true;
  }
  return false;
}

function clampDateInputsToEventRange({ skipFocused = false } = {}) {
  let changed = false;
  for (const input of [els.start, els.end]) {
    if (skipFocused && document.activeElement === input) continue;
    changed = clampDateInputToEventRange(input) || changed;
  }
  if (changed) scheduleUrlStateUpdate();
  return changed;
}

function setDateInputLimit(attribute, value) {
  for (const input of [els.start, els.end]) {
    if (attribute === "min") {
      if (value) input.dataset.eventMin = value;
      else delete input.dataset.eventMin;
    } else if (attribute === "max") {
      if (value) input.dataset.eventMax = value;
      else delete input.dataset.eventMax;
    }
    // Native datetime-local min/max clamps partially typed segments too early.
    // Keep bounds in state/data attributes and clamp on blur/search instead.
    input.removeAttribute(attribute);
  }
}

function applyEventDateRange(range) {
  state.eventMinTimeMs = parseTimestampMs(range?.minTime);
  state.eventMaxTimeMs = parseTimestampMs(range?.maxTime);
  state.eventRangeLastQueryMs = Number.isFinite(range?.eventRangeQueryMs)
    ? range.eventRangeQueryMs
    : Number.isFinite(range?.queryMs)
      ? range.queryMs
      : null;
  state.eventRangeSource = range?.eventRangeSource || range?.source || "";
  setDateInputLimit("min", localDateTimeInputFromMs(state.eventMinTimeMs));
  setDateInputLimit("max", localDateTimeInputFromMs(state.eventMaxTimeMs));
  clampDateInputsToEventRange({ skipFocused: true });
}

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function parseBoundsParam(value) {
  if (!value) return null;
  const parts = String(value)
    .split(",")
    .map((part) => Number(part));
  if (parts.length !== 4 || parts.some((part) => !Number.isFinite(part))) return null;
  return {
    minLat: Math.min(parts[0], parts[2]),
    minLon: Math.min(parts[1], parts[3]),
    maxLat: Math.max(parts[0], parts[2]),
    maxLon: Math.max(parts[1], parts[3]),
  };
}

function parsePageParam(value) {
  const page = Number.parseInt(value || "", 10);
  return Number.isInteger(page) && page > 0 ? page - 1 : null;
}

function parseSortParam(value, mode) {
  if (mode === RESULT_MODE_TYPICAL) return null;
  const [key, direction] = String(value || "").split(":");
  const validKeys = mode === RESULT_MODE_MODELS ? MODEL_SORT_KEYS : FLIGHT_SORT_KEYS;
  if (!validKeys.has(key) || (direction !== "asc" && direction !== "desc")) return null;
  return { key, direction };
}

function parseUrlState() {
  const hash = window.location.hash.startsWith("#") ? window.location.hash.slice(1) : window.location.hash;
  const params = new URLSearchParams(hash);
  const modeParam = params.get("mode");
  const mode =
    modeParam === RESULT_MODE_MODELS
      ? RESULT_MODE_MODELS
      : modeParam === RESULT_MODE_TYPICAL
        ? RESULT_MODE_TYPICAL
        : RESULT_MODE_FLIGHTS;
  return {
    hasStart: params.has("start"),
    start: dateTimeUrlValueToInputValue(params.get("start")),
    hasEnd: params.has("end"),
    end: dateTimeUrlValueToInputValue(params.get("end")),
    hasAircraftType: params.has("aircraft"),
    aircraftType: params.get("aircraft") || "",
    hasAirportType: params.has("airport"),
    airportType: params.get("airport") || "",
    hasEmissionsMethodology: params.has("emissions"),
    emissionsMethodology: params.get("emissions") || "",
    includeWellToTank: params.has("wtt") ? params.get("wtt") !== "0" : null,
    mode,
    page: parsePageParam(params.get("page")),
    detailEventId: params.get("detail") || null,
    bbox: parseBoundsParam(params.get("bbox")),
    mapBounds: parseBoundsParam(params.get("map")),
    sort: parseSortParam(params.get("sort"), mode),
  };
}

function formatUrlNumber(value) {
  if (!Number.isFinite(Number(value))) return "";
  const text = Number(value)
    .toFixed(URL_STATE_DECIMALS)
    .replace(/(\.\d*?)0+$/g, "$1")
    .replace(/\.$/g, "");
  return text === "-0" ? "0" : text;
}

function formatBoundsParam(bounds) {
  if (!bounds) return "";
  return [bounds.minLat, bounds.minLon, bounds.maxLat, bounds.maxLon].map(formatUrlNumber).join(",");
}

function selectOptionExists(select, value) {
  return [...select.options].some((option) => option.value === value);
}

function applyInitialUrlState() {
  if (initialUrlState.hasStart && initialUrlState.start) els.start.value = initialUrlState.start;
  if (initialUrlState.hasEnd && initialUrlState.end) els.end.value = initialUrlState.end;
  if (initialUrlState.hasAircraftType && selectOptionExists(els.aircraftType, initialUrlState.aircraftType)) {
    els.aircraftType.value = initialUrlState.aircraftType;
  }
  if (initialUrlState.hasAirportType && selectOptionExists(els.airportType, initialUrlState.airportType)) {
    els.airportType.value = initialUrlState.airportType;
  }
  if (
    initialUrlState.hasEmissionsMethodology &&
    selectOptionExists(els.emissionsMethodology, initialUrlState.emissionsMethodology)
  ) {
    els.emissionsMethodology.value = initialUrlState.emissionsMethodology;
  }
  if (initialUrlState.includeWellToTank !== null) {
    state.includeWellToTank = initialUrlState.includeWellToTank;
    els.includeWtt.checked = initialUrlState.includeWellToTank;
  }
  state.resultMode = initialUrlState.mode;
  if (initialUrlState.sort) {
    state.sortKey = initialUrlState.sort.key;
    state.sortDirection = initialUrlState.sort.direction;
    state.sortIsDefault = false;
  } else {
    applyDefaultSortForMode(state.resultMode);
  }
  state.pendingUrlPage = initialUrlState.page;
  state.pendingUrlDetailEventId = initialUrlState.detailEventId;
}

function currentMapBounds() {
  if (!state.map) return initialUrlState.mapBounds || null;
  const bounds = state.map.getBounds();
  return {
    minLat: bounds.getSouth(),
    minLon: bounds.getWest(),
    maxLat: bounds.getNorth(),
    maxLon: bounds.getEast(),
  };
}

function buildUrlStateParams() {
  const params = new URLSearchParams();
  params.set("start", dateTimeInputToUrlValue(els.start.value));
  params.set("end", dateTimeInputToUrlValue(els.end.value));
  params.set("aircraft", els.aircraftType.value || "");
  params.set("airport", els.airportType.value || "");
  params.set("emissions", els.emissionsMethodology.value || "");
  params.set("wtt", state.includeWellToTank ? "1" : "0");
  params.set("mode", state.resultMode);
  const page = Number.isInteger(state.pendingUrlPage) ? state.pendingUrlPage : state.page;
  params.set("page", String(page + 1));
  params.set("sort", `${state.sortKey}:${state.sortDirection}`);
  try {
    params.set("bbox", formatBoundsParam(bboxFromInputs()));
  } catch {
    params.set("bbox", "");
  }
  const mapBounds = currentMapBounds();
  if (mapBounds) params.set("map", formatBoundsParam(mapBounds));
  const detailEventId =
    state.pendingUrlDetailEventId ||
    (!els.flightDetailPanel.hidden && state.selectedEventId !== null && state.selectedEventId !== undefined
      ? state.selectedEventId
      : null);
  if (detailEventId !== null && detailEventId !== undefined) {
    params.set("detail", String(detailEventId));
  }
  return params;
}

function writeUrlState() {
  if (state.urlStateUpdatesPaused) return;
  const params = buildUrlStateParams();
  const nextUrl = `${window.location.pathname}${window.location.search}#${params.toString()}`;
  if (nextUrl !== `${window.location.pathname}${window.location.search}${window.location.hash}`) {
    window.history.replaceState(null, "", nextUrl);
  }
}

function scheduleUrlStateUpdate() {
  if (state.urlStateUpdatesPaused) return;
  clearTimeout(state.urlStateTimer);
  state.urlStateTimer = setTimeout(() => {
    state.urlStateTimer = null;
    writeUrlState();
  }, 100);
}

function emptyFeatureCollection() {
  return { type: "FeatureCollection", features: [] };
}

function setStatus(message) {
  els.status.textContent = message;
}

function setLoadingStatus(message) {
  els.loadingStatus.textContent = message;
}

function setLoadingProgress(percent = null) {
  els.loadingBar.hidden = false;
  const normalized = Number(percent);
  if (Number.isFinite(normalized)) {
    els.loadingBar.classList.remove("is-indeterminate");
    els.loadingBarFill.style.transform = `scaleX(${Math.max(0, Math.min(1, normalized / 100))})`;
  } else {
    els.loadingBar.classList.add("is-indeterminate");
    els.loadingBarFill.style.transform = "";
  }
}

function showResultsLoading(message = "Preparing query", { progress = null } = {}) {
  state.loadingStartedAt = performance.now();
  els.resultsLoading.hidden = false;
  els.search.disabled = true;
  setLoadingStatus(message);
  setLoadingProgress(progress);
  clearInterval(state.loadingTimer);
}

function updateResultsLoading(message, { progress = null } = {}) {
  if (els.resultsLoading.hidden) return;
  setLoadingStatus(message);
  setLoadingProgress(progress);
}

function hideResultsLoading() {
  els.resultsLoading.hidden = true;
  els.loadingBar.hidden = true;
  els.loadingBar.classList.remove("is-indeterminate");
  els.loadingBarFill.style.transform = "";
  els.search.disabled = false;
  clearInterval(state.loadingTimer);
  state.loadingTimer = null;
  state.loadingStartedAt = null;
}

function cancelActiveLoading() {
  let cancelled = false;
  if (state.currentSearchAbortController) {
    state.currentSearchAbortController.abort();
    cancelled = true;
  }
  if (state.currentTypicalAbortController) {
    state.currentTypicalAbortController.abort();
    cancelled = true;
  }
  if (cancelled) {
    updateResultsLoading("Cancelling");
    setStatus("Cancelling request");
  }
}

function setBboxInputs(bounds) {
  els.minLat.value = bounds.minLat.toFixed(5);
  els.minLon.value = bounds.minLon.toFixed(5);
  els.maxLat.value = bounds.maxLat.toFixed(5);
  els.maxLon.value = bounds.maxLon.toFixed(5);
  updateSearchBoundsLayer();
  scheduleUrlStateUpdate();
}

function bboxFromInputs() {
  const bounds = {
    minLat: Number(els.minLat.value),
    minLon: Number(els.minLon.value),
    maxLat: Number(els.maxLat.value),
    maxLon: Number(els.maxLon.value),
  };
  if (Object.values(bounds).some((value) => !Number.isFinite(value))) {
    throw new Error("Bounding box values must be numeric.");
  }
  return {
    minLat: Math.min(bounds.minLat, bounds.maxLat),
    minLon: Math.min(bounds.minLon, bounds.maxLon),
    maxLat: Math.max(bounds.minLat, bounds.maxLat),
    maxLon: Math.max(bounds.minLon, bounds.maxLon),
  };
}

function bboxFeature(bounds) {
  return {
    type: "Feature",
    geometry: {
      type: "Polygon",
      coordinates: [
        [
          [bounds.minLon, bounds.minLat],
          [bounds.maxLon, bounds.minLat],
          [bounds.maxLon, bounds.maxLat],
          [bounds.minLon, bounds.maxLat],
          [bounds.minLon, bounds.minLat],
        ],
      ],
    },
    properties: {},
  };
}

function bboxFeatureCollection(bounds) {
  return {
    type: "FeatureCollection",
    features: bounds ? [bboxFeature(bounds)] : [],
  };
}

function updateSearchBoundsLayer() {
  if (!state.map?.getSource(SEARCH_BOUNDS_SOURCE_ID)) return;
  try {
    state.map.getSource(SEARCH_BOUNDS_SOURCE_ID).setData(bboxFeatureCollection(bboxFromInputs()));
  } catch {
    state.map.getSource(SEARCH_BOUNDS_SOURCE_ID).setData(emptyFeatureCollection());
  }
}

function updateDrawBoundsLayer(bounds) {
  if (!state.map?.getSource(DRAW_BOUNDS_SOURCE_ID)) return;
  state.map.getSource(DRAW_BOUNDS_SOURCE_ID).setData(bboxFeatureCollection(bounds));
}

function boundsFromLngLats(start, end) {
  return {
    minLat: Math.min(start.lat, end.lat),
    minLon: Math.min(start.lng, end.lng),
    maxLat: Math.max(start.lat, end.lat),
    maxLon: Math.max(start.lng, end.lng),
  };
}

function setDrawBoundsActive(active) {
  if (state.drawBoundsActive === active) return;
  state.drawBoundsActive = active;
  state.drawBoundsDragging = false;
  state.drawBoundsStart = null;
  els.drawBounds.classList.toggle("is-active", active);
  els.drawBounds.setAttribute("aria-pressed", String(active));
  if (state.map) {
    state.map.getCanvas().style.cursor = active ? "crosshair" : "";
    if (active) {
      state.drawBoundsPreviousDragPan = state.map.dragPan.isEnabled();
      state.map.dragPan.disable();
      setStatus("Drag on the map to draw search bounds");
    } else {
      if (state.drawBoundsPreviousDragPan) state.map.dragPan.enable();
      updateDrawBoundsLayer(null);
    }
  }
}

function handleBoundsDrawStart(event) {
  if (!state.drawBoundsActive || event.originalEvent?.button !== 0) return;
  event.preventDefault();
  state.drawBoundsDragging = true;
  state.drawBoundsStart = event.lngLat;
  updateDrawBoundsLayer(null);
}

function handleBoundsDrawMove(event) {
  if (!state.drawBoundsActive || !state.drawBoundsDragging || !state.drawBoundsStart) return;
  updateDrawBoundsLayer(boundsFromLngLats(state.drawBoundsStart, event.lngLat));
}

function handleBoundsDrawEnd(event) {
  if (!state.drawBoundsActive || !state.drawBoundsDragging || !state.drawBoundsStart) return;
  const bounds = boundsFromLngLats(state.drawBoundsStart, event.lngLat);
  state.suppressNextMapClick = true;
  setTimeout(() => {
    state.suppressNextMapClick = false;
  }, 300);
  setBboxInputs(bounds);
  setDrawBoundsActive(false);
  setStatus("Search bounds updated");
}

function useMapBounds() {
  const bounds = state.map.getBounds();
  setBboxInputs({
    minLat: bounds.getSouth(),
    minLon: bounds.getWest(),
    maxLat: bounds.getNorth(),
    maxLon: bounds.getEast(),
  });
  setStatus("Search bounds updated from map view");
}

function isNonHelicopterAircraftType(value) {
  return Boolean(value && value !== "helicopter");
}

function initMap() {
  const initialMapBounds = initialUrlState.mapBounds || AUGUSTA_BBOX;
  state.map = new maplibregl.Map({
    container: "map",
    style: BRIGHT_STYLE_URL,
    center: [-82.0105, 33.4735],
    zoom: 7,
    attributionControl: false,
  });
  state.map.addControl(new maplibregl.NavigationControl({ visualizePitch: false }), "top-right");
  state.map.addControl(new maplibregl.AttributionControl({ compact: true }), "bottom-right");
  state.map.fitBounds(
    [
      [initialMapBounds.minLon, initialMapBounds.minLat],
      [initialMapBounds.maxLon, initialMapBounds.maxLat],
    ],
    { padding: 28, duration: 0 }
  );
  state.map.on("load", () => {
    ensureAirportLayer();
    updateSearchBoundsLayer();
    state.mapReady = true;
    maybeRunInitialSearch();
  });
  state.map.on("click", AIRPORT_LAYER_ID, (event) => {
    if (state.suppressNextMapClick) {
      state.suppressNextMapClick = false;
      return;
    }
    if (state.drawBoundsActive) return;
    const feature = event.features?.[0];
    if (!feature) return;
    const props = feature.properties || {};
    const coordinates = feature.geometry.coordinates.slice();
    new maplibregl.Popup()
      .setLngLat(coordinates)
      .setHTML(
        `<strong>${escapeHtml(props.code)}</strong><br>${escapeHtml(props.name)}<br>${formatNumber(
          props.operations
        )} operations`
      )
      .addTo(state.map);
  });
  state.map.on("mouseenter", AIRPORT_LAYER_ID, () => {
    state.map.getCanvas().style.cursor = state.drawBoundsActive ? "crosshair" : "pointer";
  });
  state.map.on("mouseleave", AIRPORT_LAYER_ID, () => {
    state.map.getCanvas().style.cursor = state.drawBoundsActive ? "crosshair" : "";
  });
  state.map.on("mousedown", handleBoundsDrawStart);
  state.map.on("mousemove", handleBoundsDrawMove);
  state.map.on("mouseup", handleBoundsDrawEnd);
  state.map.on("moveend", scheduleUrlStateUpdate);
}

function ensureAirportLayer() {
  if (!state.map.getSource(SEARCH_BOUNDS_SOURCE_ID)) {
    state.map.addSource(SEARCH_BOUNDS_SOURCE_ID, {
      type: "geojson",
      data: emptyFeatureCollection(),
    });
  }
  if (!state.map.getLayer(SEARCH_BOUNDS_LAYER_ID)) {
    state.map.addLayer({
      id: SEARCH_BOUNDS_LAYER_ID,
      type: "line",
      source: SEARCH_BOUNDS_SOURCE_ID,
      layout: {
        "line-cap": "square",
        "line-join": "round",
      },
      paint: {
        "line-color": "#b9271f",
        "line-width": 2.2,
        "line-opacity": 0.95,
      },
    });
  }
  if (!state.map.getSource(DRAW_BOUNDS_SOURCE_ID)) {
    state.map.addSource(DRAW_BOUNDS_SOURCE_ID, {
      type: "geojson",
      data: emptyFeatureCollection(),
    });
  }
  if (!state.map.getLayer(DRAW_BOUNDS_LAYER_ID)) {
    state.map.addLayer({
      id: DRAW_BOUNDS_LAYER_ID,
      type: "line",
      source: DRAW_BOUNDS_SOURCE_ID,
      layout: {
        "line-cap": "square",
        "line-join": "round",
      },
      paint: {
        "line-color": "#b9271f",
        "line-width": 2,
        "line-dasharray": [1.6, 1.1],
        "line-opacity": 0.95,
      },
    });
  }
  if (!state.map.getSource(AIRPORT_SOURCE_ID)) {
    state.map.addSource(AIRPORT_SOURCE_ID, {
      type: "geojson",
      data: emptyFeatureCollection(),
    });
  }
  if (!state.map.getSource(FLIGHT_PATH_SOURCE_ID)) {
    state.map.addSource(FLIGHT_PATH_SOURCE_ID, {
      type: "geojson",
      data: emptyFeatureCollection(),
    });
  }
  if (!state.map.getLayer(FLIGHT_PATH_LAYER_ID)) {
    state.map.addLayer({
      id: FLIGHT_PATH_LAYER_ID,
      type: "line",
      source: FLIGHT_PATH_SOURCE_ID,
      layout: {
        "line-cap": "round",
        "line-join": "round",
      },
      paint: {
        "line-color": "#b94739",
        "line-width": 3,
        "line-opacity": 0.9,
      },
    });
  }
  if (!state.map.getLayer(AIRPORT_LAYER_ID)) {
    state.map.addLayer({
      id: AIRPORT_LAYER_ID,
      type: "circle",
      source: AIRPORT_SOURCE_ID,
      paint: {
        "circle-radius": ["get", "radius"],
        "circle-color": ["get", "color"],
        "circle-opacity": ["get", "opacity"],
        "circle-stroke-color": "#20312c",
        "circle-stroke-width": ["case", [">", ["get", "operations"], 0], 1.2, 0.6],
        "circle-stroke-opacity": 0.7,
      },
    });
  }
  if (!state.map.getSource(FLIGHT_ENDPOINT_SOURCE_ID)) {
    state.map.addSource(FLIGHT_ENDPOINT_SOURCE_ID, {
      type: "geojson",
      data: emptyFeatureCollection(),
    });
  }
  if (!state.map.getLayer(FLIGHT_ENDPOINT_LAYER_ID)) {
    state.map.addLayer({
      id: FLIGHT_ENDPOINT_LAYER_ID,
      type: "circle",
      source: FLIGHT_ENDPOINT_SOURCE_ID,
      paint: {
        "circle-radius": 5,
        "circle-color": "#b94739",
        "circle-opacity": 0.95,
        "circle-stroke-color": "#ffffff",
        "circle-stroke-width": 1.5,
      },
    });
  }
}

function updateAirportLayer() {
  if (!state.map?.getSource(AIRPORT_SOURCE_ID)) return;
  const maxOperations = Math.max(0, ...Array.from(state.airportCounts.values()).map((item) => item.operations));
  const features = state.airports.map((airport) => {
    const counts = state.airportCounts.get(airport.airportId) || { operations: 0, takeoffs: 0, landings: 0 };
    const scaled = maxOperations > 0 ? Math.sqrt(counts.operations / maxOperations) : 0;
    return {
      type: "Feature",
      geometry: {
        type: "Point",
        coordinates: [airport.longitude, airport.latitude],
      },
      properties: {
        airportId: airport.airportId,
        code: airport.code,
        name: airport.name,
        airportType: airport.airportType,
        operations: counts.operations,
        takeoffs: counts.takeoffs,
        landings: counts.landings,
        radius: counts.operations > 0 ? 5 + scaled * 31 : 2.5,
        color: counts.operations > 0 ? "#2d6a87" : "#88928d",
        opacity: counts.operations > 0 ? 0.72 : 0.18,
      },
    };
  });
  state.map.getSource(AIRPORT_SOURCE_ID).setData({
    type: "FeatureCollection",
    features,
  });
}

function eventRouteLabel(event) {
  const start = event.takeoffAirportCode || event.takeoffAirportId || "";
  const end = event.landingAirportCode || event.landingAirportId || "";
  return `${start} → ${end}`;
}

function normalizedRegistration(value) {
  return String(value || "")
    .trim()
    .toUpperCase()
    .replace(/\s+/g, "");
}

function faaNNumber(value) {
  const registration = normalizedRegistration(value).replace(/[^A-Z0-9]/g, "");
  if (!registration.startsWith("N")) return "";
  const nNumber = registration.slice(1);
  return /^[1-9][0-9A-Z]{0,5}$/.test(nNumber) ? nNumber : "";
}

function registrationLinksHtml(value) {
  const registration = normalizedRegistration(value);
  if (!registration) return escapeHtml("Unknown");
  const links = [
    `<a href="https://www.flightaware.com/live/flight/${encodeURIComponent(registration)}" target="_blank" rel="noreferrer">FlightAware</a>`,
  ];
  const nNumber = faaNNumber(registration);
  if (nNumber) {
    links.push(
      `<a href="https://registry.faa.gov/AircraftInquiry/Search/NNumberResult?nNumberTxt=${encodeURIComponent(
        nNumber
      )}" target="_blank" rel="noreferrer">FAA</a>`
    );
  }
  return `${escapeHtml(registration)}<span class="detail-links">${links.join("")}</span>`;
}

function eventAirportLabel(event, prefix) {
  const code = event[`${prefix}AirportCode`] || "";
  const name = event[`${prefix}AirportName`] || "";
  if (code && name) return `${code} · ${name}`;
  return code || name || "Unknown";
}

function profileSourceLabel(value) {
  if (value === "model_match") return "Matched aircraft model";
  if (value === "business_jet_fallback") return "Fallback profile";
  return "Unsupported";
}

function sourceHtml(source) {
  if (!source) return "None";
  const label = escapeHtml(source.label || "Source");
  const sourceLabel = source.url
    ? `<a href="${escapeHtml(source.url)}" target="_blank" rel="noreferrer">${label}</a>`
    : label;
  return source.notes
    ? `${sourceLabel}<span class="detail-source-note">${escapeHtml(source.notes)}</span>`
    : sourceLabel;
}

function emissionsMethodologyLabel(emissions) {
  if (!emissions) return "None";
  if (emissions.label) return emissions.label;
  if (emissions.methodology === "adapted_tim") return "Adapted Travel Impact Model";
  return emissions.methodology || "Unknown";
}

function isAdaptedTimMethodology(methodology = currentResultEmissionsMethodology()) {
  return methodology === "adapted_tim";
}

function isCombinedMethodology(methodology = currentResultEmissionsMethodology()) {
  return methodology === "combined";
}

function isEurocontrolFastMethodology(methodology = currentResultEmissionsMethodology()) {
  return methodology === "eurocontrol_fast";
}

function isGhgcMethodology(methodology = currentResultEmissionsMethodology()) {
  return String(methodology || "").startsWith("ghgc.methods.");
}

function isEurocontrolTtwOnlyMethodology(methodology = currentResultEmissionsMethodology()) {
  return isGhgcMethodology(methodology) || isEurocontrolFastMethodology(methodology);
}

function hasSplitEmissionsComponents(methodology = currentResultEmissionsMethodology()) {
  return isAdaptedTimMethodology(methodology) || isCombinedMethodology(methodology);
}

function hasEmissionsTotal(emissions) {
  return Number.isFinite(emissions?.totalCo2eKg);
}

function unsupportedReasonLabel(reason) {
  if (reason === "aircraft_not_supported") return "Aircraft not mapped to a supported emissions-model type";
  if (reason === "aircraft_not_in_method_dataset") return "Aircraft type unavailable in emissions-model dataset";
  if (!reason) return "Unsupported for the selected methodology";
  return String(reason).replaceAll("_", " ");
}

function ghgcEstimateStatus(emissions) {
  if (emissions?.unsupportedReason) return unsupportedReasonLabel(emissions.unsupportedReason);
  return hasEmissionsTotal(emissions) ? "Estimated" : "Unsupported";
}

function shouldShowWellToTank(methodology = currentResultEmissionsMethodology()) {
  return state.includeWellToTank !== false && hasSplitEmissionsComponents(methodology);
}

function emissionsComponentBreakdownText(
  emissions,
  { includeWellToTank = shouldShowWellToTank(), formatter = formatEmissionsSummary } = {}
) {
  const parts = [];
  if (Number.isFinite(emissions?.tankToWakeCo2eKg)) {
    parts.push(`TTW ${formatter(emissions.tankToWakeCo2eKg)}`);
  }
  if (includeWellToTank && Number.isFinite(emissions?.wellToTankCo2eKg)) {
    parts.push(`WTT ${formatter(emissions.wellToTankCo2eKg)}`);
  }
  return parts.join(" · ");
}

function emissionsSelectedScopeText(emissions) {
  if (isEurocontrolTtwOnlyMethodology(emissions?.methodology || state.emissions?.methodology)) return "TTW only";
  if (!hasSplitEmissionsComponents(state.emissions?.methodology)) return "";
  return "";
}

function emissionsTotalText(emissions) {
  if (!hasEmissionsTotal(emissions)) return "None";
  return formatEmissionsSummary(emissions.totalCo2eKg);
}

function emissionsTotalTooltip(emissions) {
  if (!hasEmissionsTotal(emissions)) return "";
  if (isEurocontrolTtwOnlyMethodology(emissions?.methodology || state.emissions?.methodology)) {
    return `${emissionsMethodologyLabel(state.emissions)} · TTW only · ${emissions.gasBasis || state.emissions?.gasBasis || "CO2 from fuel burn"}`;
  }
  if (!shouldShowWellToTank(emissions?.methodology || state.emissions?.methodology)) return "";
  return emissionsComponentBreakdownText(emissions);
}

function emissionsStatusText(emissions) {
  if (!hasEmissionsTotal(emissions)) return "";
  return formatEmissionsSummary(emissions.totalCo2eKg);
}

function emissionsColumnLabel(unit = "", methodology = currentResultEmissionsMethodology()) {
  let label;
  if (isEurocontrolTtwOnlyMethodology(methodology)) {
    label = "CO2e TTW";
  } else if (hasSplitEmissionsComponents(methodology)) {
    label = state.includeWellToTank === false ? "CO2e TTW" : "CO2e TTW+WTT";
  } else {
    label = "CO2e";
  }
  return unit ? `${label} (${unit})` : label;
}

function emissionsRowSubtitle(emissions) {
  if (!emissions) return "";
  if (hasSplitEmissionsComponents(state.emissions?.methodology)) {
    const breakdown = shouldShowWellToTank(state.emissions?.methodology)
      ? emissionsComponentBreakdownText(emissions, { formatter: formatEmissionsTons })
      : "";
    if (isCombinedMethodology(state.emissions?.methodology)) {
      return [emissions.aircraftIcaoCode || emissions.profile || "", breakdown].filter(Boolean).join(" · ");
    }
    return [emissions.profile || "", breakdown].filter(Boolean).join(" · ");
  }
  if (isEurocontrolTtwOnlyMethodology(state.emissions?.methodology)) {
    if (emissions.unsupportedReason) return unsupportedReasonLabel(emissions.unsupportedReason);
    return emissions.aircraftIcaoCode || "";
  }
  return emissions.aircraftIcaoCode || emissionsMethodologyLabel(state.emissions);
}

function detailList(rows) {
  return `<dl class="detail-list">${rows
    .map(([label, value]) => `<div><dt>${escapeHtml(label)}</dt><dd>${value}</dd></div>`)
    .join("")}</dl>`;
}

function shownEvents() {
  return state.sortedEvents;
}

function shownResultRows() {
  if (state.resultMode === RESULT_MODE_TYPICAL) return state.typicalRows;
  return state.resultMode === RESULT_MODE_MODELS ? state.sortedModelGroups : state.sortedEvents;
}

function normalizedText(value) {
  return String(value || "").trim().toLocaleLowerCase();
}

function defaultSortForMode(mode = state.resultMode) {
  if (mode === RESULT_MODE_TYPICAL) return { key: DEFAULT_SORT_KEY, direction: DEFAULT_SORT_DIRECTION };
  return {
    key: mode === RESULT_MODE_MODELS ? DEFAULT_MODEL_SORT_KEY : DEFAULT_SORT_KEY,
    direction: mode === RESULT_MODE_MODELS ? DEFAULT_MODEL_SORT_DIRECTION : DEFAULT_SORT_DIRECTION,
  };
}

function applyDefaultSortForMode(mode = state.resultMode) {
  const defaultSort = defaultSortForMode(mode);
  state.sortKey = defaultSort.key;
  state.sortDirection = defaultSort.direction;
  state.sortIsDefault = true;
}

function sortDirectionFactor(direction = state.sortDirection) {
  return direction === "desc" ? -1 : 1;
}

function compareText(left, right, direction = state.sortDirection) {
  const a = normalizedText(left);
  const b = normalizedText(right);
  if (a && !b) return -1;
  if (!a && b) return 1;
  return a.localeCompare(b) * sortDirectionFactor(direction);
}

function compareTime(left, right, field, direction = state.sortDirection) {
  const a = Date.parse(left[field]);
  const b = Date.parse(right[field]);
  if (Number.isFinite(a) && !Number.isFinite(b)) return -1;
  if (!Number.isFinite(a) && Number.isFinite(b)) return 1;
  if (!Number.isFinite(a) && !Number.isFinite(b)) return 0;
  return (a - b) * sortDirectionFactor(direction);
}

function compareEmissions(left, right, direction = state.sortDirection) {
  const a = left.emissions?.totalCo2eKg ?? left.totalCo2eKg;
  const b = right.emissions?.totalCo2eKg ?? right.totalCo2eKg;
  const aValid = Number.isFinite(a);
  const bValid = Number.isFinite(b);
  if (aValid && !bValid) return -1;
  if (!aValid && bValid) return 1;
  if (!aValid && !bValid) return 0;
  return (a - b) * sortDirectionFactor(direction);
}

function compareNumber(left, right, direction = state.sortDirection) {
  const aValid = Number.isFinite(left);
  const bValid = Number.isFinite(right);
  if (aValid && !bValid) return -1;
  if (!aValid && bValid) return 1;
  if (!aValid && !bValid) return 0;
  return (left - right) * sortDirectionFactor(direction);
}

function eventSortComparator(left, right) {
  let result = 0;
  if (state.sortKey === "landing_time") {
    result = compareTime(left, right, "landingTime");
  } else if (state.sortKey === "aircraft_type") {
    result = compareText(aircraftTypeLabel(left.aircraftType), aircraftTypeLabel(right.aircraftType));
  } else if (state.sortKey === "model") {
    result = compareText(left.aircraftModel, right.aircraftModel);
  } else if (state.sortKey === "n_number") {
    result = compareText(left.registration || left.icao, right.registration || right.icao);
  } else if (state.sortKey === "emissions") {
    result = compareEmissions(left, right);
  } else {
    result = compareTime(left, right, "takeoffTime");
  }
  if (result !== 0) return result;
  return (
    compareTime(left, right, "takeoffTime", DEFAULT_SORT_DIRECTION) ||
    Number(left.eventId || 0) - Number(right.eventId || 0)
  );
}

function modelGroupSortComparator(left, right) {
  let result = 0;
  if (state.sortKey === "emissions") {
    result = compareEmissions(left, right);
  } else if (state.sortKey === "gph_source") {
    result = compareNumber(gphSourceRank(left.gphSource), gphSourceRank(right.gphSource));
  } else if (state.sortKey === "gph") {
    result = compareNumber(left.gph, right.gph);
  } else if (state.sortKey === "flights") {
    result = compareNumber(left.eventCount, right.eventCount);
  } else if (state.sortKey === "estimated") {
    result = compareNumber(left.estimatedEventCount, right.estimatedEventCount);
  } else if (state.sortKey === "hours") {
    result = compareNumber(left.totalHours, right.totalHours);
  } else {
    result = compareText(left.modelName, right.modelName);
  }
  if (result !== 0) return result;
  return compareText(left.modelName, right.modelName, DEFAULT_SORT_DIRECTION);
}

function updateSortedEvents() {
  state.sortedEvents = [...state.events].sort(eventSortComparator);
}

function updateSortedModelGroups() {
  state.sortedModelGroups = [...state.modelGroups].sort(modelGroupSortComparator);
}

function updateSortedResults() {
  if (state.resultMode === RESULT_MODE_TYPICAL) {
    return;
  }
  if (state.resultMode === RESULT_MODE_MODELS) {
    updateSortedModelGroups();
  } else {
    updateSortedEvents();
  }
}

function gphSourceRank(value) {
  if (value === "ground_truth") return 0;
  if (value === "mixed") return 1;
  if (value === "placeholder") return 2;
  return 3;
}

function aircraftTypeLabel(value) {
  return (value || "unknown").replaceAll("_", " ");
}

function showAircraftTypeColumn(events) {
  return new Set(events.map((event) => event.aircraftType || "unknown")).size > 1;
}

function resultColumns(hasTypeColumn) {
  return [
    {
      label: "Registration",
      sortKey: "n_number",
      title: "Aircraft registration or tail number when available; the ICAO hex identifier is shown below.",
    },
    ...(hasTypeColumn
      ? [
          {
            label: "Type",
            sortKey: "aircraft_type",
            title: "Aircraft category assigned by the classifier for this event.",
          },
        ]
      : []),
    {
      label: "Model",
      sortKey: "model",
      title: "Normalized aircraft model used for grouping and emissions matching.",
    },
    {
      label: "Takeoff",
      sortKey: "takeoff_time",
      title: "Departure airport and takeoff time for the flight event.",
    },
    {
      label: "Landing",
      sortKey: "landing_time",
      title: "Arrival airport and landing time for the flight event.",
    },
    {
      label: emissionsColumnLabel("t"),
      sortKey: "emissions",
      className: "emissions-column",
      title: "Estimated CO2e for this flight using the selected emissions model and WTT setting.",
    },
  ];
}

function modelColumns() {
  if (isEurocontrolTtwOnlyMethodology() || isCombinedMethodology()) {
    return [
      {
        label: "MODEL",
        sortKey: "model",
        className: "model-name-column",
        title: "Normalized aircraft model group.",
      },
      {
        label: "#",
        sortKey: "flights",
        className: "numeric-column",
        title: "Number of flights in this model group.",
      },
      {
        label: emissionsColumnLabel("t"),
        sortKey: "emissions",
        className: "numeric-column emissions-column",
        title: "Total estimated CO2e for all flights in this model group.",
      },
    ];
  }
  if (!isAdaptedTimMethodology()) {
    return [
      {
        label: "MODEL",
        sortKey: "model",
        className: "model-name-column",
        title: "Normalized aircraft model group.",
      },
      {
        label: "#",
        sortKey: "flights",
        className: "numeric-column",
        title: "Number of flights in this model group.",
      },
      {
        label: emissionsColumnLabel("t"),
        sortKey: "emissions",
        className: "numeric-column emissions-column",
        title: "Total estimated CO2e for all flights in this model group.",
      },
    ];
  }
  return [
    {
      label: "MODEL",
      sortKey: "model",
      className: "model-name-column",
      title: "Normalized aircraft model group.",
    },
    {
      label: "SRC",
      sortKey: "gph_source",
      className: "source-column",
      title: "Fuel-burn source quality for this model's gallons-per-hour estimate.",
    },
    {
      label: "#",
      sortKey: "flights",
      className: "numeric-column",
      title: "Number of flights in this model group.",
    },
    {
      label: "HRS",
      sortKey: "hours",
      className: "numeric-column",
      title: "Total estimated flight hours for this model group.",
    },
    {
      label: "GPH",
      sortKey: "gph",
      className: "numeric-column",
      title: "Average gallons per hour used for this model group's estimates.",
    },
    {
      label: emissionsColumnLabel("t"),
      sortKey: "emissions",
      className: "numeric-column emissions-column",
      title: "Total estimated CO2e for all flights in this model group.",
    },
  ];
}

function typicalColumns() {
  return [
    {
      label: "PERIOD",
      sortKey: "period",
      title: "Comparison period relative to the current search; shows the current total as a multiplier of that period.",
    },
    {
      label: "DATES",
      sortKey: "dates",
      className: "typical-date-column",
      title: "Start and end timestamps used for the comparison query.",
    },
    {
      label: "#",
      sortKey: "count",
      className: "numeric-column",
      title: "Number of flight events found in the comparison period.",
    },
    {
      label: "UNK",
      sortKey: "unknown",
      className: "numeric-column",
      title: "Flights without an emissions estimate under the selected emissions model.",
    },
    {
      label: emissionsColumnLabel("kt"),
      sortKey: "emissions",
      className: "numeric-column emissions-column",
      title: "Total estimated CO2e for the comparison period using the selected emissions model and WTT setting.",
    },
    {
      label: `${emissionsColumnLabel("kt")} Diff`,
      sortKey: "emissions_diff",
      className: "numeric-column emissions-column",
      title: "Difference between the current search total CO2e and this comparison period total.",
    },
  ];
}

function lowercaseInitial(value) {
  const text = String(value || "");
  if (!text) return "";
  return `${text.slice(0, 1).toLowerCase()}${text.slice(1)}`;
}

function formatMultiplierValue(value) {
  if (!Number.isFinite(value)) return "";
  return formatDecimal(value, value >= 10 ? 0 : 1).replace(/\.0$/, "");
}

function typicalComparisonParts(row) {
  const currentTotal = state.emissions?.totalCo2eKg;
  const comparisonTotal = row.emissions?.totalCo2eKg;
  if (!Number.isFinite(currentTotal) || !Number.isFinite(comparisonTotal) || comparisonTotal <= 0) return null;
  const ratio = currentTotal / comparisonTotal;
  if (!Number.isFinite(ratio)) return null;
  const relation = ratio > 1.005 ? "above" : ratio < 0.995 ? "of" : "same as";
  return {
    multiplier: `${formatMultiplierValue(ratio)}x`,
    relation,
    label: lowercaseInitial(row.label),
  };
}

function typicalComparisonHtml(row) {
  const parts = typicalComparisonParts(row);
  if (!parts) return "";
  return `<span class="comparison-text"><strong>${escapeHtml(parts.multiplier)}</strong> ${escapeHtml(parts.relation)} ${escapeHtml(
    parts.label
  )}</span>`;
}

function typicalComparisonText(row) {
  const parts = typicalComparisonParts(row);
  if (!parts) return "";
  return `${parts.multiplier} ${parts.relation} ${parts.label}`;
}

function typicalEmissionsDiffKg(row) {
  const currentTotal = state.emissions?.totalCo2eKg;
  const comparisonTotal = row.emissions?.totalCo2eKg;
  if (!Number.isFinite(currentTotal) || !Number.isFinite(comparisonTotal)) return null;
  return currentTotal - comparisonTotal;
}

function formatEmissionsKilotonnesDiff(kg) {
  if (!Number.isFinite(kg)) return "";
  if (kg === 0) return formatEmissionsKilotonnes(0);
  const sign = kg < 0 ? "-" : "";
  return `${sign}${formatEmissionsKilotonnes(Math.abs(kg))}`;
}

function headerSortDirection(sortKey) {
  if (state.sortIsDefault || state.sortKey !== sortKey) return null;
  return state.sortDirection;
}

function headerSortAria(sortKey) {
  const direction = headerSortDirection(sortKey);
  if (direction === "asc") return "ascending";
  if (direction === "desc") return "descending";
  return "none";
}

function renderHeaderCell(column) {
  const direction = headerSortDirection(column.sortKey);
  const sortClass = direction ? ` sort-${direction}` : "";
  const columnClass = column.className ? ` class="${escapeHtml(column.className)}"` : "";
  const title = column.title || column.label;
  const titleAttr = title ? ` title="${escapeHtml(title)}"` : "";
  const ariaLabel = title ? `${column.label}: ${title}` : column.label;
  return `<th${columnClass}${titleAttr} aria-sort="${headerSortAria(
    column.sortKey
  )}"><button type="button" class="sort-header-button${sortClass}" data-sort-key="${escapeHtml(
    column.sortKey
  )}"${titleAttr} aria-label="${escapeHtml(ariaLabel)}"><span>${escapeHtml(
    column.label
  )}</span><span class="sort-indicator" aria-hidden="true"></span></button></th>`;
}

function renderPlainHeaderCell(column) {
  const columnClass = column.className ? ` class="${escapeHtml(column.className)}"` : "";
  const title = column.title || column.label;
  const titleAttr = title ? ` title="${escapeHtml(title)}"` : "";
  const ariaLabel = title ? `${column.label}: ${title}` : column.label;
  return `<th${columnClass}${titleAttr}><button type="button" class="sort-header-button is-static" aria-disabled="true" tabindex="-1"${titleAttr} aria-label="${escapeHtml(
    ariaLabel
  )}"><span>${escapeHtml(column.label)}</span><span class="sort-indicator" aria-hidden="true"></span></button></th>`;
}

function tableCell(value, column) {
  const columnClass = column.className ? ` class="${escapeHtml(column.className)}"` : "";
  return `<td${columnClass}>${value}</td>`;
}

function csvEscape(value) {
  const text = String(value ?? "");
  return /[",\r\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

function downloadCsv(filename, rows) {
  const csv = rows.map((row) => row.map(csvEscape).join(",")).join("\n");
  const blob = new Blob([`${csv}\n`], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  document.body.append(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}

function exportFilename() {
  const mode = state.resultMode === RESULT_MODE_MODELS ? "models" : "flights";
  const resolvedMode = state.resultMode === RESULT_MODE_TYPICAL ? "typical" : mode;
  const start = (els.start.value || "start").replace(/[^0-9A-Za-z]+/g, "-");
  const end = (els.end.value || "end").replace(/[^0-9A-Za-z]+/g, "-");
  return `adsb-${resolvedMode}-${start}-${end}.csv`;
}

function flightCsvRows(events) {
  const hasTypeColumn = showAircraftTypeColumn(events);
  const baseHeader = [
    "Registration",
    "ICAO",
    ...(hasTypeColumn ? ["Type"] : []),
    "Model",
    "Takeoff airport",
    "Takeoff time",
    "Landing airport",
    "Landing time",
  ];
  const baseRow = (event) => [
    event.registration || "Unknown",
    event.icao || "",
    ...(hasTypeColumn ? [aircraftTypeLabel(event.aircraftType)] : []),
    event.aircraftModel || "",
    event.takeoffAirportCode || "",
    formatDateTime(event.takeoffTime),
    event.landingAirportCode || "",
    formatDateTime(event.landingTime),
  ];
  if (isEurocontrolTtwOnlyMethodology()) {
    const header = [
      ...baseHeader,
      "tCO2e TTW",
      "Emissions method",
      "Scope",
      "Gas basis",
      "Aircraft ICAO type",
      "Aircraft IATA type",
      "Observed duration (hr)",
      "Status",
    ];
    return [
      header,
      ...events.map((event) => {
        const emissions = event.emissions || {};
        return [
          ...baseRow(event),
          formatTonsCell(emissions.totalCo2eKg),
          emissionsMethodologyLabel(state.emissions),
          emissions.scopeLabel || state.emissions?.scopeLabel || "Whole flight",
          emissions.gasBasis || state.emissions?.gasBasis || "CO2 from fuel burn",
          emissions.aircraftIcaoCode || "",
          emissions.aircraftIataCode || "",
          formatHoursCell(eventDurationHours(event)),
          ghgcEstimateStatus(emissions),
        ];
      }),
    ];
  }
  if (isCombinedMethodology()) {
    const includeWtt = shouldShowWellToTank();
    const header = [
      ...baseHeader,
      ...(includeWtt ? ["tCO2e WTT"] : []),
      "tCO2e TTW",
      "Emissions profile",
      "Aircraft ICAO type",
      "Calculation source",
      "Fallback reason",
      "Observed duration (hr)",
    ];
    return [
      header,
      ...events.map((event) => {
        const emissions = event.emissions || {};
        return [
          ...baseRow(event),
          ...(includeWtt ? [formatTonsCell(emissions.wellToTankCo2eKg)] : []),
          formatTonsCell(emissions.tankToWakeCo2eKg),
          emissions.profile || "",
          emissions.aircraftIcaoCode || "",
          emissions.calculationSource || "",
          emissions.fallbackReason || "",
          formatHoursCell(eventDurationHours(event)),
        ];
      }),
    ];
  }
  if (!isAdaptedTimMethodology()) {
    const header = [...baseHeader, "Observed duration (hr)"];
    return [header, ...events.map((event) => [...baseRow(event), formatHoursCell(eventDurationHours(event))])];
  }
  const includeWtt = shouldShowWellToTank();
  const header = [
    ...baseHeader,
    ...(includeWtt ? ["tCO2e WTT"] : []),
    "tCO2e TTW",
    "Emissions profile",
    "Flight duration (hr)",
    "GPH estimate",
  ];
  return [
    header,
    ...events.map((event) => [
      ...baseRow(event),
      ...(includeWtt ? [formatTonsCell(event.emissions?.wellToTankCo2eKg)] : []),
      formatTonsCell(event.emissions?.tankToWakeCo2eKg),
      event.emissions?.profile || "",
      formatHoursCell(event.emissions?.flightTimeHours),
      formatNumberCell(event.emissions?.burnGph),
    ]),
  ];
}

function modelCsvRows(groups) {
  if (isEurocontrolTtwOnlyMethodology()) {
    return [
      ["Model", "Flights", "Estimated flights", "Unsupported flights", "tCO2e TTW", "Emissions method", "Scope", "Gas basis"],
      ...groups.map((group) => [
        group.modelName || "Unknown model",
        formatNumber(group.eventCount),
        formatNumber(group.estimatedEventCount),
        formatNumber(Math.max(0, Number(group.eventCount || 0) - Number(group.estimatedEventCount || 0))),
        formatTonsCell(group.totalCo2eKg),
        emissionsMethodologyLabel(state.emissions),
        state.emissions?.scopeLabel || "Whole flight",
        state.emissions?.gasBasis || "CO2 from fuel burn",
      ]),
    ];
  }
  if (isCombinedMethodology()) {
    const includeWtt = shouldShowWellToTank();
    return [
      [
        "Model",
        "Flights",
        "Estimated flights",
        "EUROCONTROL curve flights",
        "ATIM fallback flights",
        ...(includeWtt ? ["tCO2e WTT"] : []),
        "tCO2e TTW",
        "Fallback reasons",
      ],
      ...groups.map((group) => [
        group.modelName || "Unknown model",
        formatNumber(group.eventCount),
        formatNumber(group.estimatedEventCount),
        formatNumber(group.eurocontrolCurveCount || 0),
        formatNumber(group.atimDerivedCurveCount || 0),
        ...(includeWtt ? [formatTonsCell(group.wellToTankCo2eKg)] : []),
        formatTonsCell(group.tankToWakeCo2eKg),
        Object.entries(group.fallbackReasonCounts || {})
          .map(([reason, count]) => `${reason}: ${count}`)
          .join("; "),
      ]),
    ];
  }
  if (!isAdaptedTimMethodology()) {
    return [
      ["Model", "Flights"],
      ...groups.map((group) => [group.modelName || "Unknown model", formatNumber(group.eventCount)]),
    ];
  }
  const includeWtt = shouldShowWellToTank();
  return [
    ["Model", "GPH source", "Flights", "Hours (hr)", "GPH", ...(includeWtt ? ["tCO2e WTT"] : []), "tCO2e TTW"],
    ...groups.map((group) => [
      group.modelName || "Unknown model",
      gphSourceLabel(group),
      formatNumber(group.eventCount),
      formatHoursCell(group.totalHours),
      formatNumberCell(group.gph),
      ...(includeWtt ? [formatTonsCell(group.wellToTankCo2eKg)] : []),
      formatTonsCell(group.tankToWakeCo2eKg),
    ]),
  ];
}

function typicalCsvRows(rows) {
  const includeWtt = shouldShowWellToTank();
  return [
    [
      "Period",
      "Start",
      "End",
      "Events",
      "Unknown flights",
      "Total CO2e (kt)",
      "Total CO2e difference (kt)",
      "TTW CO2e (kt)",
      ...(includeWtt ? ["WTT CO2e (kt)"] : []),
    ],
    ...rows.map((row) => [
      typicalComparisonText(row) || row.label,
      row.startInput,
      row.endInput,
      formatNumber(row.count),
      formatNumber(row.emissions?.missingEventCount || 0),
      formatKilotonnesCell(row.emissions?.totalCo2eKg),
      formatKilotonnesCell(typicalEmissionsDiffKg(row)),
      formatKilotonnesCell(row.emissions?.tankToWakeCo2eKg),
      ...(includeWtt ? [formatKilotonnesCell(row.emissions?.wellToTankCo2eKg)] : []),
    ]),
  ];
}

function exportVisibleResults() {
  const rows =
    state.resultMode === RESULT_MODE_TYPICAL
      ? typicalCsvRows(state.typicalRows)
      : state.resultMode === RESULT_MODE_MODELS
        ? modelCsvRows(state.sortedModelGroups)
        : flightCsvRows(state.sortedEvents);
  downloadCsv(exportFilename(), rows);
}

function gphSourceLabel(source) {
  const value = typeof source === "string" ? source : source?.gphSource;
  const domains = Array.isArray(source?.gphSourceDomains) ? source.gphSourceDomains : [];
  if (domains.length) {
    const domainText = domains.join("; ");
    if (value === "placeholder") return `${domainText} (placeholder)`;
    if (value === "mixed") return `${domainText} (mixed)`;
    return domainText;
  }
  if (value === "ground_truth") return "GPH source domain unavailable";
  if (value === "placeholder") return "Placeholder GPH";
  if (value === "mixed") return "Mixed GPH sources";
  return "GPH source unavailable";
}

function addMillisecondsToLocalInput(value, milliseconds) {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return value;
  return toLocalDateTimeInput(new Date(date.getTime() + milliseconds));
}

function addYearsToLocalInput(value, years) {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return value;
  const next = new Date(date);
  next.setFullYear(next.getFullYear() + years);
  return toLocalDateTimeInput(next);
}

function parseTimestampMs(value) {
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? date.getTime() : null;
}

function isPeriodAvailable(startInput, endInput) {
  const startMs = parseTimestampMs(startInput);
  const endMs = parseTimestampMs(endInput);
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || endMs <= startMs) return false;
  if (Number.isFinite(state.eventMinTimeMs) && startMs < state.eventMinTimeMs) return false;
  if (Number.isFinite(state.eventMaxTimeMs) && endMs > state.eventMaxTimeMs) return false;
  return Number.isFinite(state.eventMinTimeMs) || Number.isFinite(state.eventMaxTimeMs);
}

function typicalPeriodDefinitions() {
  const start = new Date(els.start.value);
  const end = new Date(els.end.value);
  if (!Number.isFinite(start.getTime()) || !Number.isFinite(end.getTime()) || end <= start) return [];
  const shiftWeeks = Math.max(1, Math.ceil((end.getTime() - start.getTime()) / WEEK_MS));
  const shiftMs = shiftWeeks * WEEK_MS;
  const periods = [
    {
      key: "back",
      label: `${shiftWeeks} weeks earlier`,
      startInput: addMillisecondsToLocalInput(els.start.value, -shiftMs),
      endInput: addMillisecondsToLocalInput(els.end.value, -shiftMs),
    },
    {
      key: "forward",
      label: `${shiftWeeks} weeks later`,
      startInput: addMillisecondsToLocalInput(els.start.value, shiftMs),
      endInput: addMillisecondsToLocalInput(els.end.value, shiftMs),
    },
    {
      key: "previous_year",
      label: "Previous year",
      startInput: addYearsToLocalInput(els.start.value, -1),
      endInput: addYearsToLocalInput(els.end.value, -1),
    },
  ];
  const nextYear = {
    key: "next_year",
    label: "Next year",
    startInput: addYearsToLocalInput(els.start.value, 1),
    endInput: addYearsToLocalInput(els.end.value, 1),
  };
  if (isPeriodAvailable(nextYear.startInput, nextYear.endInput)) {
    periods.push(nextYear);
  }
  return periods;
}

function typicalCacheKey() {
  const bbox = bboxFromInputs();
  return JSON.stringify({
    start: els.start.value,
    end: els.end.value,
    bbox,
    aircraftType: els.aircraftType.value || "",
    airportType: els.airportType.value || "",
    emissionsMethodology: els.emissionsMethodology.value || "",
    includeWellToTank: state.includeWellToTank,
    airportIds: state.airports.map((airport) => airport.airportId).sort((left, right) => left - right),
  });
}

function typicalLoadingText(message, period) {
  const label = period?.label ? ` · ${period.label.toLowerCase()}` : "";
  return `${message}${label}`;
}

function clearTypicalCache() {
  if (state.currentTypicalAbortController) {
    state.currentTypicalAbortController.abort();
    state.currentTypicalAbortController = null;
  }
  state.typicalRows = [];
  state.typicalCacheKey = null;
  state.typicalLoading = false;
  state.typicalError = "";
}

async function loadTypicalResults() {
  if (!state.airports.length) return;
  const cacheKey = typicalCacheKey();
  if (state.typicalCacheKey === cacheKey && state.typicalRows.length) return;
  if (state.currentTypicalAbortController) state.currentTypicalAbortController.abort();
  const abortController = new AbortController();
  state.currentTypicalAbortController = abortController;
  state.typicalLoading = true;
  state.typicalError = "";
  state.typicalRows = [];
  state.typicalCacheKey = null;
  renderResults();
  showResultsLoading("Counting events");
  try {
    const periods = typicalPeriodDefinitions();
    const rows = [];
    for (const period of periods) {
      const started = performance.now();
      showResultsLoading(typicalLoadingText("Counting events", period));
      const payload = await fetchStreamingEventSummary(
        {
          start: fromLocalDateTimeInput(period.startInput),
          end: fromLocalDateTimeInput(period.endInput),
          airportIds: state.airports.map((airport) => airport.airportId),
          aircraftType: els.aircraftType.value || null,
          emissionsMethodology: els.emissionsMethodology.value,
          includeWellToTank: state.includeWellToTank,
        },
        {
          signal: abortController.signal,
          onMessage: (message) => {
            if (message.type === "meta") {
              updateResultsLoading(typicalLoadingText("Counting events", period));
            } else if (message.type === "progress" || message.type === "complete") {
              updateResultsLoading(typicalLoadingText("Downloading results", period), {
                progress: message.progress?.percent ?? null,
              });
            }
          },
        }
      );
      const row = {
        ...period,
        count: payload.count || 0,
        emissions: payload.emissions || null,
        queryMs: performance.now() - started,
      };
      rows.push(row);
      state.typicalRows = [...rows];
      renderResults();
    }
    state.typicalRows = rows;
    state.typicalCacheKey = cacheKey;
    state.typicalLoading = false;
    hideResultsLoading();
    renderResults();
    setStatus(`Loaded typical comparison periods · ${rows.map((row) => formatDuration(row.queryMs)).join(", ")}`);
  } catch (error) {
    if (error.name === "AbortError") {
      if (state.currentTypicalAbortController === abortController) {
        state.typicalLoading = false;
        hideResultsLoading();
        renderResults();
        setStatus("Typical lookup cancelled");
      }
      return;
    }
    state.typicalRows = [];
    state.typicalLoading = false;
    state.typicalError = error.message || "Typical comparison failed";
    hideResultsLoading();
    renderResults();
    setStatus(state.typicalError);
  } finally {
    if (state.currentTypicalAbortController === abortController) {
      state.currentTypicalAbortController = null;
    }
  }
}

function gphSourceIcon(source) {
  const value = typeof source === "string" ? source : source?.gphSource;
  const label = gphSourceLabel(source);
  if (value === "ground_truth") {
    return `<span class="gph-source-icon gph-source-ground-truth" role="img" aria-label="${escapeHtml(
      label
    )}" title="${escapeHtml(label)}"><svg aria-hidden="true" viewBox="0 0 24 24"><path d="M20 6 9 17l-5-5" /></svg></span>`;
  }
  if (value === "placeholder") {
    return `<span class="gph-source-icon gph-source-placeholder" role="img" aria-label="${escapeHtml(
      label
    )}" title="${escapeHtml(label)}"><svg aria-hidden="true" viewBox="0 0 24 24"><path d="M12 3 22 20H2L12 3Z" /><path d="M12 9v5" /><path d="M12 17h.01" /></svg></span>`;
  }
  if (value === "mixed") {
    return `<span class="gph-source-icon gph-source-mixed" role="img" aria-label="${escapeHtml(
      label
    )}" title="${escapeHtml(label)}"><svg aria-hidden="true" viewBox="0 0 24 24"><path d="M4 7h10" /><path d="m10 3 4 4-4 4" /><path d="M20 17H10" /><path d="m14 13-4 4 4 4" /></svg></span>`;
  }
  return `<span class="gph-source-icon gph-source-unavailable" role="img" aria-label="${escapeHtml(
    label
  )}" title="${escapeHtml(label)}"><svg aria-hidden="true" viewBox="0 0 24 24"><circle cx="12" cy="12" r="9" /><path d="M9 9a3 3 0 0 1 6 1c0 2-3 2-3 4" /><path d="M12 17h.01" /></svg></span>`;
}

function cycleSort(sortKey) {
  if (state.sortIsDefault || state.sortKey !== sortKey) {
    state.sortKey = sortKey;
    state.sortDirection = "asc";
    state.sortIsDefault = false;
  } else if (state.sortDirection === "asc") {
    state.sortDirection = "desc";
    state.sortIsDefault = false;
  } else {
    const defaultSort = defaultSortForMode();
    state.sortKey = defaultSort.key;
    state.sortDirection = defaultSort.direction;
    state.sortIsDefault = true;
  }
  updateSortedResults();
  state.page = 0;
  closeFlightDetail();
  renderResults();
  scheduleUrlStateUpdate();
}

function setResultMode(mode) {
  if (mode !== RESULT_MODE_FLIGHTS && mode !== RESULT_MODE_MODELS && mode !== RESULT_MODE_TYPICAL) return;
  if (state.resultMode === mode) return;
  state.resultMode = mode;
  applyDefaultSortForMode(mode);
  updateSortedResults();
  state.page = 0;
  closeFlightDetail();
  renderResults();
  if (mode === RESULT_MODE_TYPICAL) void loadTypicalResults();
  scheduleUrlStateUpdate();
}

function currentSelectedEventIndex() {
  if (state.selectedEventId === null || state.selectedEventId === undefined) return -1;
  return shownEvents().findIndex((event) => String(event.eventId) === String(state.selectedEventId));
}

function setPage(nextPage) {
  const totalPages = Math.ceil(shownResultRows().length / PAGE_SIZE);
  const previousPage = state.page;
  state.page = Math.max(0, Math.min(nextPage, Math.max(0, totalPages - 1)));
  renderResults();
  if (state.page !== previousPage) scrollResultsToTop();
  scheduleUrlStateUpdate();
}

function stepPage(delta) {
  setPage(state.page + delta);
}

function scrollResultsToTop() {
  els.tableWrap.scrollTo({ top: 0, left: 0 });
}

function showEventAtIndex(index) {
  const events = shownEvents();
  if (index < 0 || index >= events.length) return;
  state.page = Math.floor(index / PAGE_SIZE);
  renderResults();
  void showFlightDetail(events[index]);
}

function stepSelectedEvent(delta) {
  const index = currentSelectedEventIndex();
  if (index < 0) return;
  showEventAtIndex(index + delta);
}

function isTextEditingTarget(target) {
  return ["INPUT", "SELECT", "TEXTAREA"].includes(target?.tagName) || Boolean(target?.isContentEditable);
}

function hasFlightCoordinates(event) {
  return (
    Number.isFinite(event.takeoffAirportLatitude) &&
    Number.isFinite(event.takeoffAirportLongitude) &&
    Number.isFinite(event.landingAirportLatitude) &&
    Number.isFinite(event.landingAirportLongitude)
  );
}

function toRadians(value) {
  return (value * Math.PI) / 180;
}

function toDegrees(value) {
  return (value * 180) / Math.PI;
}

function normalizeLongitude(value) {
  let longitude = value;
  while (longitude > 180) longitude -= 360;
  while (longitude < -180) longitude += 360;
  return longitude;
}

function buildGreatCircleCoordinates(event, segments = 64) {
  if (!hasFlightCoordinates(event)) return [];
  const startLat = toRadians(event.takeoffAirportLatitude);
  const startLon = toRadians(event.takeoffAirportLongitude);
  const endLat = toRadians(event.landingAirportLatitude);
  const endLon = toRadians(event.landingAirportLongitude);
  const deltaLat = endLat - startLat;
  const deltaLon = endLon - startLon;
  const haversineTerm =
    Math.sin(deltaLat / 2) ** 2 + Math.cos(startLat) * Math.cos(endLat) * Math.sin(deltaLon / 2) ** 2;
  const angularDistance = 2 * Math.asin(Math.min(1, Math.sqrt(haversineTerm)));
  const start = [normalizeLongitude(event.takeoffAirportLongitude), event.takeoffAirportLatitude];
  const end = [normalizeLongitude(event.landingAirportLongitude), event.landingAirportLatitude];
  if (!Number.isFinite(angularDistance) || angularDistance < 1e-9) return [start, end];
  const sinDistance = Math.sin(angularDistance);
  const coordinates = [];
  for (let index = 0; index <= segments; index += 1) {
    const fraction = index / segments;
    const startWeight = Math.sin((1 - fraction) * angularDistance) / sinDistance;
    const endWeight = Math.sin(fraction * angularDistance) / sinDistance;
    const x =
      startWeight * Math.cos(startLat) * Math.cos(startLon) + endWeight * Math.cos(endLat) * Math.cos(endLon);
    const y =
      startWeight * Math.cos(startLat) * Math.sin(startLon) + endWeight * Math.cos(endLat) * Math.sin(endLon);
    const z = startWeight * Math.sin(startLat) + endWeight * Math.sin(endLat);
    coordinates.push([
      normalizeLongitude(toDegrees(Math.atan2(y, x))),
      toDegrees(Math.atan2(z, Math.sqrt(x * x + y * y))),
    ]);
  }
  return coordinates;
}

function splitAntimeridian(coordinates) {
  if (coordinates.length < 2) return [];
  const segments = [[coordinates[0]]];
  for (let index = 1; index < coordinates.length; index += 1) {
    const previous = coordinates[index - 1];
    const current = coordinates[index];
    const diff = current[0] - previous[0];
    if (Math.abs(diff) <= 180) {
      segments[segments.length - 1].push(current);
      continue;
    }

    const crossesEast = previous[0] > 0 && current[0] < 0;
    const boundary = crossesEast ? 180 : -180;
    const oppositeBoundary = crossesEast ? -180 : 180;
    const unwrappedCurrentLon = crossesEast ? current[0] + 360 : current[0] - 360;
    const fraction = (boundary - previous[0]) / (unwrappedCurrentLon - previous[0]);
    const boundaryLat = previous[1] + (current[1] - previous[1]) * fraction;
    segments[segments.length - 1].push([boundary, boundaryLat]);
    segments.push([[oppositeBoundary, boundaryLat], current]);
  }
  return segments.filter((segment) => segment.length >= 2);
}

function routeGeometry(coordinates) {
  const segments = splitAntimeridian(coordinates);
  if (segments.length <= 1) {
    return { type: "LineString", coordinates: segments[0] || coordinates };
  }
  return { type: "MultiLineString", coordinates: segments };
}

function routeBounds(coordinates) {
  if (!coordinates.length) return null;
  let previousLon = coordinates[0][0];
  const unwrapped = coordinates.map(([longitude, latitude], index) => {
    if (index === 0) return [longitude, latitude];
    let unwrappedLon = longitude;
    while (unwrappedLon - previousLon > 180) unwrappedLon -= 360;
    while (unwrappedLon - previousLon < -180) unwrappedLon += 360;
    previousLon = unwrappedLon;
    return [unwrappedLon, latitude];
  });
  return unwrapped.reduce(
    (currentBounds, coordinate) => currentBounds.extend(coordinate),
    new maplibregl.LngLatBounds(unwrapped[0], unwrapped[0])
  );
}

function clearSelectedFlightLayer({ clearSelection = true } = {}) {
  if (clearSelection) state.selectedEventId = null;
  state.map?.getSource(FLIGHT_PATH_SOURCE_ID)?.setData(emptyFeatureCollection());
  state.map?.getSource(FLIGHT_ENDPOINT_SOURCE_ID)?.setData(emptyFeatureCollection());
}

function updateSelectedFlightLayer(event) {
  if (!state.mapReady || !state.map) return;
  ensureAirportLayer();
  const coordinates = buildGreatCircleCoordinates(event);
  if (!coordinates.length) {
    clearSelectedFlightLayer();
    return;
  }
  state.selectedEventId = event.eventId;
  state.map.getSource(FLIGHT_PATH_SOURCE_ID).setData({
    type: "FeatureCollection",
    features: [
      {
        type: "Feature",
        geometry: routeGeometry(coordinates),
        properties: { eventId: event.eventId },
      },
    ],
  });
  state.map.getSource(FLIGHT_ENDPOINT_SOURCE_ID).setData({
    type: "FeatureCollection",
    features: [
      {
        type: "Feature",
        geometry: { type: "Point", coordinates: coordinates[0] },
        properties: { role: "takeoff", eventId: event.eventId },
      },
      {
        type: "Feature",
        geometry: { type: "Point", coordinates: coordinates[coordinates.length - 1] },
        properties: { role: "landing", eventId: event.eventId },
      },
    ],
  });

  const bounds = routeBounds(coordinates);
  if (bounds) {
    state.map.fitBounds(bounds, {
      padding: { top: 54, bottom: 140, left: 54, right: 54 },
      maxZoom: 9,
      duration: 450,
    });
  }
}

function setFlightDetailHeading(event) {
  const route = eventRouteLabel(event);
  const registration = normalizedRegistration(event.registration) || event.icao;
  els.flightDetailTitle.textContent = [registration, route].filter(Boolean).join(" ");
  els.flightDetailSubtitle.textContent = "";
  els.flightDetailSubtitle.hidden = true;
}

function currentResultEmissionsMethodology() {
  return state.emissions?.methodology || els.emissionsMethodology.value || "combined";
}

function detailCacheKey(eventId) {
  return [eventId, currentResultEmissionsMethodology(), state.includeWellToTank ? "wtt" : "ttw"].join(":");
}

async function fetchEventDetail(event) {
  const key = detailCacheKey(event.eventId);
  if (state.detailCache.has(key)) return state.detailCache.get(key);
  const url = new URL(`/api/events/${encodeURIComponent(event.eventId)}`, window.location.origin);
  url.searchParams.set("emissionsMethodology", currentResultEmissionsMethodology());
  url.searchParams.set("includeWellToTank", state.includeWellToTank);
  const payload = await fetchJson(url);
  const detail = payload.event || null;
  if (!detail) throw new Error("Flight detail unavailable");
  state.detailCache.set(key, detail);
  return detail;
}

function showFlightDetailLoading(event) {
  state.selectedEventId = event.eventId;
  clearSelectedFlightLayer({ clearSelection: false });
  setFlightDetailHeading(event);
  els.flightDetailBody.innerHTML = `<section class="detail-section"><h3>Flight</h3>${detailList([
    ["Status", "Loading detail"],
  ])}</section>`;
  els.resultsView.hidden = true;
  els.flightDetailPanel.hidden = false;
  els.flightDetailClose.focus();
  writeUrlState();
}

function showFlightDetailError(event, error) {
  setFlightDetailHeading(event);
  els.flightDetailBody.innerHTML = `<section class="detail-section"><h3>Flight</h3>${detailList([
    ["Status", "Detail unavailable"],
    ["Error", escapeHtml(error.message || "Request failed")],
  ])}</section>`;
  els.resultsView.hidden = true;
  els.flightDetailPanel.hidden = false;
}

async function showFlightDetail(event) {
  const requestId = ++state.latestDetailRequest;
  showFlightDetailLoading(event);
  try {
    const detail = await fetchEventDetail(event);
    if (requestId !== state.latestDetailRequest || String(state.selectedEventId) !== String(event.eventId)) return;
    const mergedEvent = { ...event, ...detail };
    const existingEvent = state.events.find((item) => String(item.eventId) === String(event.eventId));
    if (existingEvent) Object.assign(existingEvent, mergedEvent);
    renderFlightDetail(mergedEvent);
    updateSelectedFlightLayer(mergedEvent);
  } catch (error) {
    if (requestId !== state.latestDetailRequest || String(state.selectedEventId) !== String(event.eventId)) return;
    showFlightDetailError(event, error);
  }
}

function renderFlightDetail(event) {
  setFlightDetailHeading(event);
  const emissions = event.emissions;

  const flightRows = [
    ["Registration", registrationLinksHtml(event.registration)],
    ["ICAO", escapeHtml(event.icao || "Unknown")],
    ["Aircraft model", escapeHtml(event.aircraftModel || "Unknown")],
    ["Aircraft type", escapeHtml((event.aircraftType || "unknown").replaceAll("_", " "))],
    ["Takeoff", `${escapeHtml(eventAirportLabel(event, "takeoff"))}<span>${escapeHtml(formatDateTime(event.takeoffTime))}</span>`],
    ["Landing", `${escapeHtml(eventAirportLabel(event, "landing"))}<span>${escapeHtml(formatDateTime(event.landingTime))}</span>`],
    ["Observed duration", escapeHtml(formatHours(eventDurationHours(event)))],
  ];

  const sections = [
    `<section class="detail-section"><h3>Flight</h3>${detailList(flightRows)}</section>`,
  ];

  const ownerLocation = [event.ownerCity, event.ownerState, event.ownerCountry].filter(Boolean).join(", ");
  const ownerRows = [
    ...(event.ownerName ? [["Registered owner", escapeHtml(event.ownerName)]] : []),
    ...(event.ownerType ? [["Registrant type", escapeHtml(event.ownerType.replaceAll("_", " "))]] : []),
    ...(ownerLocation ? [["Location", escapeHtml(ownerLocation)]] : []),
    ...(event.yearManufactured ? [["Year built", escapeHtml(String(event.yearManufactured))]] : []),
  ];
  if (ownerRows.length) {
    sections.push(`<section class="detail-section"><h3>Registration</h3>${detailList(ownerRows)}</section>`);
  }

  if (emissions && isAdaptedTimMethodology(currentResultEmissionsMethodology())) {
    const includeWtt = shouldShowWellToTank();
    const profileRows = [
      ["Methodology", "Adapted Travel Impact Model"],
      ["Profile", escapeHtml(emissions.profile || "Unknown")],
      ["Profile ID", escapeHtml(emissions.profileKey || "Unknown")],
      ["Profile selection", escapeHtml(profileSourceLabel(emissions.profileSource))],
      ["Fuel burn", escapeHtml(`${formatFuelGallons(emissions.burnGph)} per hour`)],
      ["Cruise speed", escapeHtml(formatSpeed(emissions.speedKts))],
      ["Fuel source", sourceHtml(emissions.fuelSource)],
      ["Speed source", sourceHtml(emissions.speedSource)],
    ];
    const calculationRows = [
      ["Great-circle distance", escapeHtml(formatDistanceNm(emissions.greatCircleNm))],
      ["Adjusted distance", escapeHtml(formatDistanceNm(emissions.adjustedDistanceNm))],
      ["Route extra", escapeHtml(formatDistanceNm(emissions.routeExtraNm))],
      ["Estimated flight duration", escapeHtml(formatHours(emissions.flightTimeHours))],
      ["LTO fuel", escapeHtml(formatFuelGallons(emissions.ltoGallons))],
      ["Cruise fuel", escapeHtml(formatFuelGallons(emissions.cruiseFuelGallons))],
      ["Total fuel", escapeHtml(formatFuelGallons(emissions.totalFuelGallons))],
      ["Fuel mass", escapeHtml(formatFuelKg(emissions.totalFuelKg))],
      ["Tank-to-wake CO2e", escapeHtml(formatCo2eKg(emissions.tankToWakeCo2eKg))],
      ...(includeWtt ? [["Well-to-tank CO2e", escapeHtml(formatCo2eKg(emissions.wellToTankCo2eKg))]] : []),
    ];
    calculationRows.push(["Total CO2e", escapeHtml(formatCo2eKg(emissions.totalCo2eKg))]);
    const factorRows = [
      ["Lateral inefficiency", escapeHtml(formatDecimal(emissions.lateralInefficiencyFactor, 3))],
      ["Jet A mass", escapeHtml(`${formatDecimal(emissions.jetAKgPerGallon, 2)} kg fuel/gal`)],
      ["Tank-to-wake factor", escapeHtml(`${formatDecimal(emissions.tankToWakeFactor, 4)} kg CO2e/kg fuel`)],
      ...(includeWtt ? [["Well-to-tank factor", escapeHtml(`${formatDecimal(emissions.wellToTankFactor, 4)} kg CO2e/kg fuel`)]] : []),
    ];
    sections.push(`<section class="detail-section"><h3>Profile</h3>${detailList(profileRows)}</section>`);
    sections.push(`<section class="detail-section"><h3>Calculation</h3>${detailList(calculationRows)}</section>`);
    sections.push(`<section class="detail-section"><h3>Factors</h3>${detailList(factorRows)}</section>`);
  } else if (emissions && (isCombinedMethodology(currentResultEmissionsMethodology()) || isEurocontrolFastMethodology(currentResultEmissionsMethodology()))) {
    const includeWtt = shouldShowWellToTank();
    const methodRows = [
      ["Methodology", escapeHtml(emissionsMethodologyLabel(state.emissions))],
      ["Status", escapeHtml(ghgcEstimateStatus(emissions))],
      ["Accounting", escapeHtml(isCombinedMethodology(currentResultEmissionsMethodology()) && includeWtt ? "TTW + WTT" : "TTW only")],
      ["Calculation source", escapeHtml(emissions.calculationSource || "Unknown")],
      ["Fallback reason", escapeHtml(emissions.fallbackReason || "None")],
      ["Aircraft ICAO type", escapeHtml(emissions.aircraftIcaoCode || "Unknown")],
      ["Aircraft IATA type", escapeHtml(emissions.aircraftIataCode || "Unknown")],
      ["Curve basis", escapeHtml(emissions.eurocontrolCurveBasis || "Unknown")],
      ["Curve source", escapeHtml(emissions.eurocontrolCurveSource || "None")],
    ];
    const curveRows = [
      ["Great-circle distance", escapeHtml(formatDistanceNm(emissions.greatCircleNm))],
      ["Corrected distance", escapeHtml(formatDistanceNm(emissions.correctedDistanceNm))],
      ["Distance correction", escapeHtml(formatDistanceKm(emissions.gcdCorrectionKm))],
      ["Curve segment", escapeHtml(emissions.curveSegment || "Unknown")],
      ["Segment start", escapeHtml(formatDistanceNm(emissions.segmentStartNm))],
      ["Segment end", escapeHtml(formatCurveSegmentEndNm(emissions.segmentEndNm))],
      ["Segment start fuel", escapeHtml(formatFuelKg(emissions.segmentStartFuelKg))],
      ["Segment end fuel", escapeHtml(formatFuelKg(emissions.segmentEndFuelKg))],
      ["Segment slope", escapeHtml(Number.isFinite(emissions.segmentSlopeKgPerNm) ? `${formatDecimal(emissions.segmentSlopeKgPerNm, 4)} kg fuel/nm` : "None")],
      ["Fuel", escapeHtml(formatFuelKg(emissions.fuelKg || emissions.totalFuelKg))],
      ["CO2 coefficient", escapeHtml(Number.isFinite(emissions.co2Coefficient) ? `${formatDecimal(emissions.co2Coefficient, 3)} kg CO2/kg fuel` : "None")],
      ["Tank-to-wake CO2e", escapeHtml(formatCo2eKg(emissions.tankToWakeCo2eKg))],
      ...(includeWtt ? [["Well-to-tank CO2e", escapeHtml(formatCo2eKg(emissions.wellToTankCo2eKg))]] : []),
      ["Total emissions", escapeHtml(formatCo2eKg(emissions.totalCo2eKg))],
    ];
    const profileRows = [
      ["Profile", escapeHtml(emissions.profile || "None")],
      ["Profile selection", escapeHtml(profileSourceLabel(emissions.profileSource))],
      ["Fuel burn", escapeHtml(`${formatFuelGph(emissions.burnGph)}`)],
      ["Cruise speed", escapeHtml(formatSpeed(emissions.speedKts))],
      ["Fuel source", sourceHtml(emissions.fuelSource)],
      ["Speed source", sourceHtml(emissions.speedSource)],
    ];
    sections.push(`<section class="detail-section"><h3>Method</h3>${detailList(methodRows)}</section>`);
    sections.push(`<section class="detail-section"><h3>Curve</h3>${detailList(curveRows)}</section>`);
    if (isCombinedMethodology(currentResultEmissionsMethodology())) {
      sections.push(`<section class="detail-section"><h3>ATIM Fallback Profile</h3>${detailList(profileRows)}</section>`);
    }
  } else if (emissions) {
    const ghgcRows = [
      ["Methodology", escapeHtml(emissionsMethodologyLabel(state.emissions))],
      ["Library method", escapeHtml(state.emissions?.methodology || "Unknown")],
      ["Status", escapeHtml(ghgcEstimateStatus(emissions))],
      ["Accounting", "TTW only"],
      ["Scope", escapeHtml(emissions.scopeLabel || "Whole flight")],
      ["Gas basis", escapeHtml(emissions.gasBasis || "CO2 from fuel burn")],
      ["Aircraft ICAO type", escapeHtml(emissions.aircraftIcaoCode || "Unknown")],
      ["Aircraft IATA type", escapeHtml(emissions.aircraftIataCode || "Unknown")],
      ["Total emissions (TTW)", escapeHtml(formatCo2eKg(emissions.totalCo2eKg))],
    ];
    sections.push(`<section class="detail-section"><h3>Emissions</h3>${detailList(ghgcRows)}</section>`);
  } else {
    sections.push(
      `<section class="detail-section"><h3>Emissions</h3>${detailList([
        ["Status", "Unsupported for the selected methodology"],
        ["Emissions", "None"],
      ])}</section>`
    );
  }

  els.flightDetailBody.innerHTML = sections.join("");
  els.resultsView.hidden = true;
  els.flightDetailPanel.hidden = false;
  els.flightDetailClose.focus();
}

function closeFlightDetail({ updateUrl = true } = {}) {
  state.latestDetailRequest += 1;
  els.flightDetailPanel.hidden = true;
  els.resultsView.hidden = false;
  clearSelectedFlightLayer();
  if (updateUrl) scheduleUrlStateUpdate();
}

async function fetchJson(url, options) {
  const response = await fetch(url, options);
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    if (response.status === 401) showLogin("Session expired");
    throw new Error(payload.error || `Request failed: ${response.status}`);
  }
  return payload;
}

function applyEventPayload(eventPayload) {
  state.events = eventPayload.events || [];
  state.emissions = eventPayload.emissions || null;
  state.modelGroups = eventPayload.modelGroups || [];
  state.airportCounts = new Map((eventPayload.airportCounts || []).map((item) => [item.airportId, item]));
  updateSortedResults();
  renderResults();
  updateAirportLayer();
}

async function fetchStreamingEvents(payload, { signal, onMessage } = {}) {
  const response = await fetch("/api/events/stream", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
    signal,
  });
  if (!response.ok) {
    if (response.status === 401) showLogin("Session expired");
    const errorPayload = await response.json().catch(() => ({}));
    throw new Error(errorPayload.error || `Request failed: ${response.status}`);
  }
  if (!response.body) {
    return fetchJson("/api/events", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
      signal,
    });
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let finalPayload = null;
  const accumulatedEvents = [];
  let airportCounts = [];
  let latestCount = 0;

  async function handleLine(line) {
    if (!line.trim()) return;
    const message = JSON.parse(line);
    if (message.type === "error") {
      throw new Error(message.error || "Search failed");
    }
    if (message.airportCounts) airportCounts = message.airportCounts;
    if (Number.isFinite(message.count)) latestCount = message.count;
    if (message.type === "meta") {
      onMessage?.(message, {
        count: latestCount,
        airportCount: airportCounts.length,
        airportCounts,
        events: accumulatedEvents,
        modelGroups: [],
        emissions: null,
      });
      return;
    }
    if (Array.isArray(message.events) && message.events.length) {
      accumulatedEvents.push(...message.events);
    }
    if (message.type === "progress" || message.type === "complete") {
      const eventPayload = {
        count: latestCount || accumulatedEvents.length,
        airportCount: airportCounts.length,
        airportCounts,
        emissions: message.emissions || null,
        events: accumulatedEvents,
        modelGroups: message.modelGroups || [],
        progress: message.progress || null,
      };
      onMessage?.(message, eventPayload);
      if (message.type === "complete") finalPayload = eventPayload;
    }
  }

  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop() || "";
    for (const line of lines) {
      await handleLine(line);
    }
  }
  buffer += decoder.decode();
  await handleLine(buffer);
  if (!finalPayload) {
    throw new Error("Streaming search ended before completion");
  }
  return finalPayload;
}

async function fetchStreamingEventSummary(payload, { signal, onMessage } = {}) {
  const response = await fetch("/api/events/summary/stream", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
    signal,
  });
  if (!response.ok) {
    if (response.status === 401) showLogin("Session expired");
    const errorPayload = await response.json().catch(() => ({}));
    throw new Error(errorPayload.error || `Request failed: ${response.status}`);
  }
  if (!response.body) {
    return fetchJson("/api/events/summary", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
      signal,
    });
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let finalPayload = null;

  async function handleLine(line) {
    if (!line.trim()) return;
    const message = JSON.parse(line);
    if (message.type === "error") {
      throw new Error(message.error || "Typical comparison failed");
    }
    onMessage?.(message);
    if (message.type === "complete") {
      finalPayload = {
        count: message.count || 0,
        emissions: message.emissions || null,
        start: message.start,
        end: message.end,
      };
    }
  }

  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop() || "";
    for (const line of lines) {
      await handleLine(line);
    }
  }
  buffer += decoder.decode();
  await handleLine(buffer);
  if (!finalPayload) {
    throw new Error("Typical comparison ended before completion");
  }
  return finalPayload;
}

async function refreshEventDateRange({ force = false } = {}) {
  if (!state.metaReady) return null;
  const now = performance.now();
  if (!force && Number.isFinite(state.eventRangeLastLoadedAt) && now - state.eventRangeLastLoadedAt < DATE_RANGE_REFRESH_MIN_MS) {
    return null;
  }
  if (state.eventRangePromise) return state.eventRangePromise;
  state.eventRangeLoading = true;
  state.eventRangePromise = fetchJson("/api/events/range")
    .then((range) => {
      applyEventDateRange(range);
      state.eventRangeLastLoadedAt = performance.now();
      return range;
    })
    .finally(() => {
      state.eventRangeLoading = false;
      state.eventRangePromise = null;
    });
  return state.eventRangePromise;
}

function refreshEventDateRangeInBackground() {
  void refreshEventDateRange().catch(() => {
    // Keep datetime controls responsive; failed refreshes should not block opening the picker.
  });
}

async function startAuthenticatedApp() {
  if (state.metaReady) {
    maybeRunInitialSearch();
    return;
  }
  await loadMeta();
}

async function checkSessionAndStart() {
  try {
    const session = await fetchJson("/api/session");
    if (!session.authenticated) {
      showLogin();
      return;
    }
    hideLogin();
    await startAuthenticatedApp();
  } catch {
    showLogin();
  }
}

function showLogin(message = "") {
  document.body.classList.remove("auth-pending", "authenticated");
  document.body.classList.add("login-required");
  els.loginOverlay.hidden = false;
  els.loginError.textContent = message;
  window.requestAnimationFrame(() => {
    els.password.focus();
  });
}

function hideLogin() {
  document.body.classList.remove("auth-pending", "login-required");
  document.body.classList.add("authenticated");
  els.loginOverlay.hidden = true;
  els.password.value = "";
  els.loginError.textContent = "";
}

async function loadMeta() {
  const meta = await fetchJson("/api/meta");
  state.appVersion = meta.version || "";
  applyEventDateRange(meta);
  state.eventRangeLastLoadedAt = performance.now();
  if (els.appVersion) els.appVersion.textContent = state.appVersion ? `v${state.appVersion}` : "";
  for (const type of meta.aircraftTypes || []) {
    const option = document.createElement("option");
    option.value = type;
    option.textContent = type.replaceAll("_", " ");
    els.aircraftType.append(option);
  }
  if ([...els.aircraftType.options].some((option) => option.value === DEFAULT_AIRCRAFT_TYPE)) {
    els.aircraftType.value = DEFAULT_AIRCRAFT_TYPE;
  }
  for (const type of meta.airportTypes || []) {
    const option = document.createElement("option");
    option.value = type;
    option.textContent = type.replaceAll("_", " ");
    els.airportType.append(option);
  }
  const methodologies = meta.emissionsMethodologies?.length
    ? meta.emissionsMethodologies
    : [
        { value: "combined", label: "Combined Model" },
        { value: "adapted_tim", label: "Adapted Travel Impact Model" },
        { value: "none", label: "None" },
      ];
  for (const methodology of methodologies) {
    const option = document.createElement("option");
    option.value = methodology.value;
    option.textContent = methodology.label;
    els.emissionsMethodology.append(option);
  }
  els.start.value = DEFAULT_DATE_RANGE.start;
  els.end.value = DEFAULT_DATE_RANGE.end;
  applyInitialUrlState();
  clampDateInputsToEventRange();
  state.metaReady = true;
  state.urlStateUpdatesPaused = false;
  writeUrlState();
  setStatus(`${formatNumber(meta.events)} events indexed`);
  maybeRunInitialSearch();
}

function maybeRunInitialSearch() {
  if (state.initialSearchStarted || !state.mapReady || !state.metaReady) return;
  state.initialSearchStarted = true;
  void runSearch();
}

async function runSearch() {
  clampDateInputsToEventRange();
  if (!els.form.reportValidity()) return;
  if (state.currentSearchAbortController) state.currentSearchAbortController.abort();
  const abortController = new AbortController();
  state.currentSearchAbortController = abortController;
  const requestId = ++state.latestRequest;
  clearTypicalCache();
  showResultsLoading("Preparing query");
  try {
    closeFlightDetail({ updateUrl: false });
    state.includeWellToTank = Boolean(els.includeWtt.checked);
    const searchStarted = performance.now();
    const bbox = bboxFromInputs();
    setStatus("Loading airports");
    updateResultsLoading("Finding airports");
    const airportUrl = new URL("/api/airports", window.location.origin);
    airportUrl.searchParams.set("minLat", bbox.minLat);
    airportUrl.searchParams.set("minLon", bbox.minLon);
    airportUrl.searchParams.set("maxLat", bbox.maxLat);
    airportUrl.searchParams.set("maxLon", bbox.maxLon);
    if (els.airportType.value) airportUrl.searchParams.set("type", els.airportType.value);
    if (isNonHelicopterAircraftType(els.aircraftType.value)) airportUrl.searchParams.set("excludeType", "heliport");
    const airportStarted = performance.now();
    const airportPayload = await fetchJson(airportUrl, { signal: abortController.signal });
    const airportMs = performance.now() - airportStarted;
    if (requestId !== state.latestRequest) return;
    state.airports = airportPayload.airports || [];
    setStatus(`Loading events · airports ${formatDuration(airportMs)}`);
    updateResultsLoading("Counting events");
    const eventStarted = performance.now();
    const eventPayloadBody = {
      start: fromLocalDateTimeInput(els.start.value),
      end: fromLocalDateTimeInput(els.end.value),
      airportIds: state.airports.map((airport) => airport.airportId),
      aircraftType: els.aircraftType.value || null,
      emissionsMethodology: els.emissionsMethodology.value,
      includeWellToTank: state.includeWellToTank,
    };
    state.events = [];
    state.emissions = null;
    state.modelGroups = [];
    state.airportCounts = new Map();
    state.detailCache.clear();
    updateSortedResults();
    renderResults();
    updateAirportLayer();
    const eventPayload = await fetchStreamingEvents(eventPayloadBody, {
      signal: abortController.signal,
      onMessage: (message, partialPayload) => {
        if (requestId !== state.latestRequest) return;
        if (message.type === "meta") {
          state.airportCounts = new Map((partialPayload.airportCounts || []).map((item) => [item.airportId, item]));
          updateAirportLayer();
          updateResultsLoading("Counting events");
          return;
        }
        if (message.type === "progress" || message.type === "complete") {
          applyEventPayload(partialPayload);
          updateResultsLoading("Downloading results", { progress: message.progress?.percent ?? null });
        }
      },
    });
    const eventMs = performance.now() - eventStarted;
    const totalMs = performance.now() - searchStarted;
    if (requestId !== state.latestRequest) return;
    applyEventPayload(eventPayload);
    state.timings = { airportMs, eventMs, totalMs };
    const pendingUrlPage = state.pendingUrlPage;
    const pendingUrlDetailEventId = state.pendingUrlDetailEventId;
    state.pendingUrlPage = null;
    state.pendingUrlDetailEventId = null;
    state.page = Number.isInteger(pendingUrlPage) ? pendingUrlPage : 0;
    renderResults();
    updateAirportLayer();
    const emissionsSuffix =
      hasEmissionsTotal(state.emissions)
        ? ` · emissions ${emissionsStatusText(state.emissions)} (${formatNumber(
            state.emissions.estimatedEventCount
          )} estimated, ${formatNumber(state.emissions.missingEventCount)} unsupported)`
        : "";
    setStatus(
      `${formatNumber(state.events.length)} events matched · airports ${formatDuration(airportMs)} · events ${formatDuration(
        eventMs
      )} · total ${formatDuration(totalMs)}${emissionsSuffix}`
    );
    hideResultsLoading();
    if (state.resultMode === RESULT_MODE_TYPICAL) {
      void loadTypicalResults();
    }
    if (pendingUrlDetailEventId) {
      updateSortedEvents();
      const selectedEvent = state.events.find((item) => String(item.eventId) === String(pendingUrlDetailEventId));
      const selectedIndex = state.sortedEvents.findIndex((item) => String(item.eventId) === String(pendingUrlDetailEventId));
      if (selectedEvent && selectedIndex >= 0) {
        state.page = Math.floor(selectedIndex / PAGE_SIZE);
        renderResults();
        void showFlightDetail(selectedEvent);
      } else {
        writeUrlState();
      }
    } else {
      writeUrlState();
    }
  } catch (error) {
    if (error.name === "AbortError") {
      if (requestId === state.latestRequest) {
        setStatus("Search cancelled");
        hideResultsLoading();
        scheduleUrlStateUpdate();
      }
      return;
    }
    if (requestId !== state.latestRequest) return;
    state.emissions = null;
    state.timings = null;
    renderResults();
    setStatus(error.message || "Search failed");
    hideResultsLoading();
    scheduleUrlStateUpdate();
  } finally {
    if (state.currentSearchAbortController === abortController) {
      state.currentSearchAbortController = null;
    }
  }
}

function renderResults() {
  const visibleRows = shownResultRows();
  const totalPages = Math.ceil(visibleRows.length / PAGE_SIZE);
  state.page = Math.max(0, Math.min(state.page, Math.max(0, totalPages - 1)));
  const pageRows = visibleRows.slice(state.page * PAGE_SIZE, state.page * PAGE_SIZE + PAGE_SIZE);
  const hasTypeColumn = state.resultMode === RESULT_MODE_FLIGHTS && showAircraftTypeColumn(visibleRows);
  const columns =
    state.resultMode === RESULT_MODE_TYPICAL
      ? typicalColumns()
      : state.resultMode === RESULT_MODE_MODELS
        ? modelColumns()
        : resultColumns(hasTypeColumn);
  els.airportCount.textContent = formatNumber(state.airports.length);
  els.eventCount.textContent = formatNumber(state.events.length);
  els.shownCount.textContent = formatNumber(visibleRows.length);
  els.queryTime.textContent = state.timings ? formatDuration(state.timings.totalMs) : "0 ms";
  els.emissionsTotal.textContent = emissionsTotalText(state.emissions);
  els.emissionsTotal.title = emissionsTotalTooltip(state.emissions);
  els.exportCsv.disabled = visibleRows.length === 0 || state.typicalLoading;
  els.exportCsvLabel.textContent =
    state.resultMode === RESULT_MODE_TYPICAL ? "Typical CSV" : state.resultMode === RESULT_MODE_MODELS ? "Models CSV" : "Flights CSV";
  els.exportCsv.setAttribute(
    "aria-label",
    state.resultMode === RESULT_MODE_TYPICAL
      ? "Download typical CSV"
      : state.resultMode === RESULT_MODE_MODELS
        ? "Download models CSV"
        : "Download flights CSV"
  );
  for (const button of els.modeButtons) {
    const isActive = button.dataset.resultMode === state.resultMode;
    button.classList.toggle("is-active", isActive);
    button.setAttribute("aria-pressed", String(isActive));
  }
  els.header.innerHTML = columns.map(state.resultMode === RESULT_MODE_TYPICAL ? renderPlainHeaderCell : renderHeaderCell).join("");
  els.body.innerHTML =
    state.resultMode === RESULT_MODE_TYPICAL
      ? renderTypicalRows(pageRows, columns)
      : state.resultMode === RESULT_MODE_MODELS
        ? renderModelRows(pageRows, columns)
        : renderFlightRows(pageRows, columns, hasTypeColumn);
  els.prev.disabled = state.page <= 0;
  els.next.disabled = state.page >= totalPages - 1;
  els.pageStatus.textContent = totalPages ? `Page ${state.page + 1} of ${totalPages}` : "Page 0 of 0";
}

function renderFlightRows(events, columns, hasTypeColumn) {
  return (
    events
      .map(
        (event) => `
        <tr class="result-row" data-event-id="${escapeHtml(event.eventId)}" tabindex="0">
          <td><strong>${escapeHtml(event.registration || "Unknown")}</strong><span>${escapeHtml(
            event.icao || ""
          )}</span></td>
          ${hasTypeColumn ? `<td>${escapeHtml(aircraftTypeLabel(event.aircraftType))}</td>` : ""}
          <td>${escapeHtml(event.aircraftModel || "")}</td>
          <td><strong>${escapeHtml(event.takeoffAirportCode || "")}</strong><span>${escapeHtml(
            formatDateTime(event.takeoffTime)
          )}</span></td>
          <td><strong>${escapeHtml(event.landingAirportCode || "")}</strong><span>${escapeHtml(
            formatDateTime(event.landingTime)
          )}</span></td>
          <td><strong>${escapeHtml(formatEmissionsTons(event.emissions?.totalCo2eKg))}</strong><span>${escapeHtml(
            emissionsRowSubtitle(event.emissions)
          )}</span></td>
        </tr>
      `
      )
      .join("") || `<tr class="empty-row"><td colspan="${columns.length}">No matching events.</td></tr>`
  );
}

function renderModelRows(groups, columns) {
  return (
    groups
      .map((group) => {
        const emissionsDetail =
          isEurocontrolTtwOnlyMethodology() || !shouldShowWellToTank()
            ? ""
            : [
                emissionsSelectedScopeText(group),
                emissionsComponentBreakdownText(group, { formatter: formatEmissionsTons }),
              ]
                .filter(Boolean)
                .join(" · ");
        const values = {
          model: `<strong>${escapeHtml(group.modelName)}</strong>`,
          gph_source: gphSourceIcon(group),
          flights: `<strong>${escapeHtml(formatNumber(group.eventCount))}</strong>`,
          estimated: `<strong>${escapeHtml(formatNumber(group.estimatedEventCount))}</strong>`,
          hours: `<strong>${escapeHtml(formatHours(group.totalHours))}</strong>`,
          gph: `<strong>${escapeHtml(formatFuelGph(group.gph))}</strong>`,
          emissions: `<strong>${escapeHtml(formatEmissionsTons(group.totalCo2eKg))}</strong>${
            emissionsDetail ? `<span>${escapeHtml(emissionsDetail)}</span>` : ""
          }`,
        };
        return `
        <tr class="model-row">
          ${columns.map((column) => tableCell(values[column.sortKey] || "", column)).join("")}
        </tr>
      `;
      })
      .join("") || `<tr class="empty-row"><td colspan="${columns.length}">No matching models.</td></tr>`
  );
}

function renderTypicalRows(rows, columns) {
  if (state.typicalLoading && !rows.length) {
    return `<tr class="empty-row"><td colspan="${columns.length}">Loading typical comparison periods.</td></tr>`;
  }
  if (state.typicalError) {
    return `<tr class="empty-row"><td colspan="${columns.length}">${escapeHtml(state.typicalError)}</td></tr>`;
  }
  if (!rows.length) {
    return `<tr class="empty-row"><td colspan="${columns.length}">Select Typical to load comparison periods.</td></tr>`;
  }
  return rows
    .map((row) => {
      const dateActionTitle = `Use ${row.label.toLowerCase()} for the current search`;
      const values = {
        period: typicalComparisonHtml(row) || `<strong>${escapeHtml(row.label)}</strong>`,
        dates: `<button type="button" class="typical-date-button" data-typical-period-key="${escapeHtml(
          row.key
        )}" title="${escapeHtml(dateActionTitle)}" aria-label="${escapeHtml(dateActionTitle)}"><strong>${escapeHtml(
          row.startInput
        )}</strong><span>${escapeHtml(row.endInput)}</span></button>`,
        count: `<strong>${escapeHtml(formatNumber(row.count))}</strong>`,
        unknown: `<strong>${escapeHtml(formatNumber(row.emissions?.missingEventCount || 0))}</strong>`,
        emissions: `<strong>${escapeHtml(formatEmissionsKilotonnes(row.emissions?.totalCo2eKg))}</strong>`,
        emissions_diff: `<strong>${escapeHtml(formatEmissionsKilotonnesDiff(typicalEmissionsDiffKg(row)))}</strong>`,
      };
      return `
        <tr class="typical-row">
          ${columns.map((column) => tableCell(values[column.sortKey] || "", column)).join("")}
        </tr>
      `;
    })
    .join("");
}

function openSettingsModal() {
  els.includeWtt.checked = state.includeWellToTank;
  els.settingsModal.hidden = false;
  els.settings.setAttribute("aria-expanded", "true");
  els.includeWtt.focus();
}

function closeSettingsModal({ restoreFocus = true } = {}) {
  if (els.settingsModal.hidden) return;
  els.settingsModal.hidden = true;
  els.settings.setAttribute("aria-expanded", "false");
  if (restoreFocus) els.settings.focus();
}

function applyWellToTankSetting() {
  const includeWellToTank = Boolean(els.includeWtt.checked);
  if (state.includeWellToTank === includeWellToTank) return;
  state.includeWellToTank = includeWellToTank;
  scheduleUrlStateUpdate();
  if (state.initialSearchStarted && state.metaReady && state.mapReady) {
    void runSearch();
  }
}

function applyTypicalPeriod(periodKey) {
  const period = state.typicalRows.find((row) => row.key === periodKey);
  if (!period) return;
  els.start.value = period.startInput;
  els.end.value = period.endInput;
  scheduleUrlStateUpdate();
  if (state.initialSearchStarted && state.metaReady && state.mapReady) {
    void runSearch();
  }
}

els.loginForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  els.loginError.textContent = "";
  const submitButton = els.loginForm.querySelector("button[type='submit']");
  if (submitButton) submitButton.disabled = true;
  try {
    const response = await fetch("/api/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ password: els.password.value }),
    });
    if (!response.ok) {
      els.loginError.textContent = "Invalid password";
      return;
    }
    hideLogin();
    await startAuthenticatedApp();
  } catch {
    els.loginError.textContent = "Login failed";
  } finally {
    if (submitButton) submitButton.disabled = false;
  }
});

els.form.addEventListener("submit", (event) => {
  event.preventDefault();
  void runSearch();
});

els.loadingCancel.addEventListener("click", () => {
  cancelActiveLoading();
});

els.settings.addEventListener("click", () => {
  openSettingsModal();
});

els.settingsClose.addEventListener("click", () => {
  closeSettingsModal();
});

els.settingsModal.addEventListener("click", (event) => {
  if (event.target === els.settingsModal) {
    closeSettingsModal({ restoreFocus: false });
  }
});

els.includeWtt.addEventListener("change", () => {
  applyWellToTankSetting();
});

els.useMapBounds.addEventListener("click", () => {
  useMapBounds();
});

els.drawBounds.addEventListener("click", () => {
  setDrawBoundsActive(!state.drawBoundsActive);
});

for (const input of [els.minLat, els.minLon, els.maxLat, els.maxLon]) {
  input.addEventListener("input", () => {
    updateSearchBoundsLayer();
    scheduleUrlStateUpdate();
  });
}

for (const input of [els.start, els.end, els.aircraftType, els.airportType, els.emissionsMethodology]) {
  input.addEventListener("change", () => {
    scheduleUrlStateUpdate();
  });
}

for (const input of [els.start, els.end]) {
  installDateTimeKeyboardAssist(input);
  const clampAfterEdit = () => {
    if (document.activeElement === input) return;
    if (clampDateInputToEventRange(input)) scheduleUrlStateUpdate();
  };
  input.addEventListener("change", () => {
    window.setTimeout(clampAfterEdit, 0);
  });
  input.addEventListener("pointerdown", () => {
    refreshEventDateRangeInBackground();
  });
  input.addEventListener("focus", () => {
    refreshEventDateRangeInBackground();
  });
  input.addEventListener("blur", () => {
    clampAfterEdit();
  });
  input.addEventListener("focusout", () => {
    clampAfterEdit();
  });
}

els.header.addEventListener("click", (event) => {
  const button = event.target.closest("button[data-sort-key]");
  if (!button) return;
  cycleSort(button.dataset.sortKey);
});

els.modeToggle.addEventListener("click", (event) => {
  const button = event.target.closest("button[data-result-mode]");
  if (!button) return;
  setResultMode(button.dataset.resultMode);
});

els.exportCsv.addEventListener("click", () => {
  exportVisibleResults();
});

els.prev.addEventListener("click", () => {
  stepPage(-1);
});

els.next.addEventListener("click", () => {
  stepPage(1);
});

els.body.addEventListener("click", (event) => {
  const typicalButton = event.target.closest("button[data-typical-period-key]");
  if (typicalButton) {
    applyTypicalPeriod(typicalButton.dataset.typicalPeriodKey);
    return;
  }
  const row = event.target.closest("tr[data-event-id]");
  if (!row) return;
  const selectedEvent = state.events.find((item) => String(item.eventId) === row.dataset.eventId);
  if (selectedEvent) void showFlightDetail(selectedEvent);
});

els.body.addEventListener("keydown", (event) => {
  if (event.key !== "Enter" && event.key !== " ") return;
  const row = event.target.closest("tr[data-event-id]");
  if (!row) return;
  event.preventDefault();
  const selectedEvent = state.events.find((item) => String(item.eventId) === row.dataset.eventId);
  if (selectedEvent) void showFlightDetail(selectedEvent);
});

els.flightDetailClose.addEventListener("click", () => {
  closeFlightDetail();
});

document.addEventListener("keydown", (event) => {
  if (event.key === "Escape" && !els.settingsModal.hidden) {
    closeSettingsModal();
    return;
  }
  if (event.key === "Escape" && state.drawBoundsActive) {
    setDrawBoundsActive(false);
    setStatus("Bounds drawing canceled");
    return;
  }
  if (isTextEditingTarget(event.target)) return;
  if (event.key === "Escape" && !els.flightDetailPanel.hidden) {
    closeFlightDetail();
    return;
  }
  if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
  event.preventDefault();
  const delta = event.key === "ArrowLeft" ? -1 : 1;
  if (!els.flightDetailPanel.hidden) {
    stepSelectedEvent(delta);
  } else {
    stepPage(delta);
  }
});

setBboxInputs(initialUrlState.bbox || AUGUSTA_BBOX);
initMap();
checkSessionAndStart().catch((error) => {
  setStatus(error.message || "Failed to load metadata");
});
