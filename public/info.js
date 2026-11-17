const content = document.getElementById("infoContent");
const statusBox = document.getElementById("infoStatus");
const updatedText = document.getElementById("infoUpdated");
const refreshButton = document.getElementById("refreshButton");
const loginOverlay = document.getElementById("loginOverlay");
const loginForm = document.getElementById("loginForm");
const passwordInput = document.getElementById("passwordInput");
const loginError = document.getElementById("loginError");

function createElement(tagName, attributes = {}, children = []) {
  const element = document.createElement(tagName);
  for (const [name, value] of Object.entries(attributes)) {
    if (value === null || value === undefined || value === false) continue;
    if (name === "className") element.className = value;
    else if (name === "text") element.textContent = value;
    else element.setAttribute(name, String(value));
  }
  for (const child of Array.isArray(children) ? children : [children]) {
    if (child === null || child === undefined) continue;
    element.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
  return element;
}

function humanizeKey(key) {
  return String(key || "")
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/[_-]+/g, " ")
    .replace(/\b\w/g, (character) => character.toUpperCase());
}

function formatBytes(value) {
  if (!Number.isFinite(value)) return String(value);
  const units = ["B", "KB", "MB", "GB", "TB"];
  let size = value;
  let unitIndex = 0;
  while (Math.abs(size) >= 1024 && unitIndex < units.length - 1) {
    size /= 1024;
    unitIndex += 1;
  }
  const decimals = unitIndex === 0 ? 0 : 1;
  return `${size.toLocaleString(undefined, { maximumFractionDigits: decimals })} ${units[unitIndex]}`;
}

function formatDuration(seconds) {
  if (!Number.isFinite(seconds)) return String(seconds);
  const rounded = Math.max(0, Math.round(seconds));
  const days = Math.floor(rounded / 86400);
  const hours = Math.floor((rounded % 86400) / 3600);
  const minutes = Math.floor((rounded % 3600) / 60);
  const remainingSeconds = rounded % 60;
  const parts = [];
  if (days) parts.push(`${days}d`);
  if (hours) parts.push(`${hours}h`);
  if (minutes) parts.push(`${minutes}m`);
  if (remainingSeconds || !parts.length) parts.push(`${remainingSeconds}s`);
  return parts.join(" ");
}

function formatIso(value) {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return value;
  return `${value} (${date.toLocaleString()})`;
}

function booleanBadgeClass(key, value) {
  const normalizedKey = String(key || "").toLocaleLowerCase();
  if (/(running|rebuilding|active|busy)/.test(normalizedKey)) return value ? "is-active" : "is-ok";
  if (/(ok|success|healthy|available)/.test(normalizedKey)) return value ? "is-ok" : "is-error";
  return value ? "is-ok" : "is-neutral";
}

function formatPrimitive(key, value) {
  if (value === null || value === undefined) {
    return createElement("span", { className: "empty-value", text: "None" });
  }
  if (typeof value === "boolean") {
    return createElement("span", { className: `badge ${booleanBadgeClass(key, value)}`, text: value ? "Yes" : "No" });
  }
  if (typeof value === "number") {
    if (/bytes$/i.test(key) || key === "bytes") {
      return `${value.toLocaleString()} B (${formatBytes(value)})`;
    }
    if (/seconds/i.test(key)) return formatDuration(value);
    return value.toLocaleString();
  }
  if (typeof value === "string" && /^\d{4}-\d{2}-\d{2}T/.test(value)) {
    return formatIso(value);
  }
  return String(value);
}

function isObject(value) {
  return value && typeof value === "object" && !Array.isArray(value);
}

function isComplexValue(value) {
  return Array.isArray(value) || isObject(value);
}

function renderValue(key, value) {
  if (Array.isArray(value)) return renderArray(value);
  if (isObject(value)) return renderTable(value, true);
  return formatPrimitive(key, value);
}

function renderArray(items) {
  if (!items.length) return createElement("span", { className: "empty-value", text: "None" });
  if (items.every(isObject)) {
    return createElement(
      "div",
      { className: "array-list" },
      items.map((item, index) =>
        createElement("div", { className: "array-item" }, [
          createElement("div", { className: "array-item-title", text: `Item ${index + 1}` }),
          renderTable(item, true),
        ])
      )
    );
  }
  return createElement(
    "div",
    { className: "table-wrap nested" },
    createElement(
      "table",
      {},
      createElement(
        "tbody",
        {},
        items.map((item, index) =>
          createElement("tr", {}, [
            createElement("td", { text: `Item ${index + 1}` }),
            createElement("td", {}, renderValue(String(index), item)),
          ])
        )
      )
    )
  );
}

function renderTable(object, nested = false) {
  const rows = [];
  for (const [key, value] of Object.entries(object || {})) {
    if (isComplexValue(value)) {
      rows.push(
        createElement("tr", { className: "complex-row-label" }, [
          createElement("td", { className: "complex-label-cell", colspan: 2, text: humanizeKey(key) }),
        ]),
        createElement("tr", { className: "complex-row-value" }, [
          createElement("td", { className: "complex-value-cell", colspan: 2 }, renderValue(key, value)),
        ])
      );
    } else {
      rows.push(
        createElement("tr", {}, [
          createElement("td", { className: "key-cell", text: humanizeKey(key) }),
          createElement("td", { className: "value-cell" }, renderValue(key, value)),
        ])
      );
    }
  }
  return createElement(
    "div",
    { className: `table-wrap${nested ? " nested" : ""}` },
    createElement("table", {}, createElement("tbody", {}, rows))
  );
}

function renderSection(title, value) {
  return createElement("section", { className: "info-section" }, [
    createElement("h2", { text: title }),
    isObject(value) ? renderTable(value) : renderValue(title, value),
  ]);
}

function overview(info) {
  return {
    service: info.service?.name,
    dataSource: info.service?.dataSource,
    movements: info.database?.movements,
    minTime: info.database?.minTime,
    maxTime: info.database?.maxTime,
    secondsSinceLatestMovement: info.database?.secondsSinceLatestMovement,
    processedThrough: info.ingest?.processedThrough,
    secondsSinceLastPoll: info.ingest?.secondsSinceLastPoll,
    databaseSizeBytes: info.database?.size?.totalBytes,
    processedFiles: info.database?.processedFiles?.count,
    isIngesting: info.service?.isIngesting,
  };
}

function setStatus(message, className = "") {
  statusBox.className = `status${className ? ` ${className}` : ""}`;
  statusBox.textContent = message;
}

function renderInfo(info) {
  const sections = [
    renderSection("Overview", overview(info)),
    renderSection("Service", info.service || {}),
    renderSection("Database", info.database || {}),
    renderSection("Ingest", info.ingest || {}),
  ];
  const raw = createElement("section", { className: "info-section" }, [
    createElement("h2", { text: "Raw JSON" }),
    createElement("pre", { className: "raw-json", text: JSON.stringify(info, null, 2) }),
  ]);
  content.replaceChildren(...sections, raw);
  updatedText.textContent = `Last refreshed ${new Date().toLocaleString()}`;
  const ingestError = info.ingest?.buildError || info.ingest?.downloadError;
  const pollAge = info.ingest?.secondsSinceLastPoll;
  if (!info.ingest) setStatus("No adsbfi-proxy worker status found", "is-error");
  else if (ingestError) setStatus(`adsbfi-proxy worker error: ${ingestError}`, "is-error");
  else if (!Number.isFinite(pollAge) || pollAge > 15 * 60) setStatus("adsbfi-proxy worker has not polled recently", "is-error");
  else if (info.service?.isIngesting) setStatus("adsbfi-proxy worker is building new movements", "is-active");
  else setStatus("adsbfi-proxy worker is current", "is-ok");
}

function showLogin(message = "") {
  document.body.classList.remove("auth-pending", "authenticated");
  document.body.classList.add("login-required");
  loginOverlay.hidden = false;
  loginError.textContent = message;
  window.requestAnimationFrame(() => {
    passwordInput.focus();
  });
}

function hideLogin() {
  document.body.classList.remove("auth-pending", "login-required");
  document.body.classList.add("authenticated");
  loginOverlay.hidden = true;
  passwordInput.value = "";
  loginError.textContent = "";
}

async function loadInfo() {
  refreshButton.disabled = true;
  setStatus("Loading database status");
  try {
    const response = await fetch("/api/info", { headers: { Accept: "application/json" } });
    if (response.status === 401) {
      showLogin("Session expired");
      return;
    }
    if (!response.ok) throw new Error(`Request failed with status ${response.status}`);
    renderInfo(await response.json());
  } catch (error) {
    updatedText.textContent = "Unable to load";
    setStatus(error.message || "Unable to load database status", "is-error");
  } finally {
    refreshButton.disabled = false;
  }
}

async function checkSessionAndStart() {
  try {
    const response = await fetch("/api/session", { headers: { Accept: "application/json" } });
    const session = await response.json().catch(() => ({}));
    if (!response.ok || !session.authenticated) {
      showLogin();
      return;
    }
    hideLogin();
    await loadInfo();
  } catch {
    showLogin();
  }
}

loginForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  loginError.textContent = "";
  const submitButton = loginForm.querySelector("button[type='submit']");
  if (submitButton) submitButton.disabled = true;
  try {
    const response = await fetch("/api/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ password: passwordInput.value }),
    });
    if (!response.ok) {
      loginError.textContent = "Invalid password";
      return;
    }
    hideLogin();
    await loadInfo();
  } catch {
    loginError.textContent = "Login failed";
  } finally {
    if (submitButton) submitButton.disabled = false;
  }
});

refreshButton.addEventListener("click", loadInfo);
checkSessionAndStart();
