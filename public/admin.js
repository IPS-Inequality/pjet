const statusBox = document.getElementById("adminStatus");
const voucherRows = document.getElementById("voucherRows");
const emptyVouchers = document.getElementById("emptyVouchers");
const voucherForm = document.getElementById("voucherForm");
const voucherPassword = document.getElementById("voucherPassword");
const adminPasswordForm = document.getElementById("adminPasswordForm");
const currentAdminPassword = document.getElementById("currentAdminPassword");
const newAdminPassword = document.getElementById("newAdminPassword");
const confirmAdminPassword = document.getElementById("confirmAdminPassword");
const loginOverlay = document.getElementById("loginOverlay");
const loginForm = document.getElementById("loginForm");
const passwordInput = document.getElementById("passwordInput");
const loginError = document.getElementById("loginError");
const refreshButton = document.getElementById("refreshButton");

class AuthenticationRequiredError extends Error {}

function setStatus(message, className = "") {
  statusBox.className = `status${className ? ` ${className}` : ""}`;
  statusBox.textContent = message;
}

function showLogin(message = "") {
  document.body.classList.remove("auth-pending", "authenticated");
  document.body.classList.add("login-required");
  loginOverlay.hidden = false;
  loginError.textContent = message;
  window.requestAnimationFrame(() => passwordInput.focus());
}

function hideLogin() {
  document.body.classList.remove("auth-pending", "login-required");
  document.body.classList.add("authenticated");
  loginOverlay.hidden = true;
  passwordInput.value = "";
  loginError.textContent = "";
}

async function apiRequest(url, options) {
  const response = await fetch(url, options);
  const payload = await response.json().catch(() => ({}));
  if (response.status === 401 || response.status === 403) {
    showLogin(response.status === 403 ? "Admin password required" : "Session expired");
    throw new AuthenticationRequiredError(payload.error || "Admin password required");
  }
  if (!response.ok) throw new Error(payload.error || `Request failed: ${response.status}`);
  return payload;
}

function formatDate(value) {
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? date.toLocaleString() : String(value || "");
}

function voucherRow(voucher) {
  const row = document.createElement("tr");

  const idCell = document.createElement("td");
  idCell.textContent = `#${voucher.credentialId}`;

  const countCell = document.createElement("td");
  countCell.className = "numeric-cell";
  countCell.textContent = Number(voucher.queryCount || 0).toLocaleString();

  const createdCell = document.createElement("td");
  createdCell.textContent = formatDate(voucher.createdAt);

  const actionCell = document.createElement("td");
  actionCell.className = "action-cell";
  const removeButton = document.createElement("button");
  removeButton.type = "button";
  removeButton.className = "danger-button";
  removeButton.dataset.credentialId = String(voucher.credentialId);
  removeButton.textContent = "Remove";
  actionCell.append(removeButton);

  row.append(idCell, countCell, createdCell, actionCell);
  return row;
}

function renderVouchers(vouchers) {
  voucherRows.replaceChildren(...vouchers.map(voucherRow));
  emptyVouchers.hidden = vouchers.length > 0;
}

async function loadVouchers() {
  refreshButton.disabled = true;
  try {
    const payload = await apiRequest("/api/admin/vouchers", { headers: { Accept: "application/json" } });
    const vouchers = payload.vouchers || [];
    renderVouchers(vouchers);
    setStatus(`${vouchers.length.toLocaleString()} ${vouchers.length === 1 ? "voucher" : "vouchers"}`, "is-ok");
  } catch (error) {
    if (error instanceof AuthenticationRequiredError) return;
    setStatus(error.message || "Unable to load vouchers", "is-error");
  } finally {
    refreshButton.disabled = false;
  }
}

async function checkSessionAndStart() {
  try {
    const response = await fetch("/api/session", { headers: { Accept: "application/json" } });
    const session = await response.json().catch(() => ({}));
    if (!response.ok || !session.authenticated || session.role !== "admin") {
      showLogin(session.authenticated ? "Admin password required" : "");
      return;
    }
    hideLogin();
    await loadVouchers();
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
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) {
      loginError.textContent = payload.error || "Invalid password";
      return;
    }
    if (payload.role !== "admin") {
      await fetch("/api/logout", { method: "POST" }).catch(() => {});
      loginError.textContent = "Admin password required";
      return;
    }
    hideLogin();
    await loadVouchers();
  } catch {
    loginError.textContent = "Login failed";
  } finally {
    if (submitButton) submitButton.disabled = false;
  }
});

voucherForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  const password = voucherPassword.value.trim();
  if (!password) return;
  const submitButton = voucherForm.querySelector("button[type='submit']");
  if (submitButton) submitButton.disabled = true;
  try {
    const payload = await apiRequest("/api/admin/vouchers", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ password }),
    });
    voucherPassword.value = "";
    renderVouchers(payload.vouchers || []);
    setStatus(`Added voucher #${payload.credentialId}. Save its value now: ${password}`, "is-ok");
    voucherPassword.focus();
  } catch (error) {
    if (!(error instanceof AuthenticationRequiredError)) setStatus(error.message || "Unable to add voucher", "is-error");
  } finally {
    if (submitButton) submitButton.disabled = false;
  }
});

voucherRows.addEventListener("click", async (event) => {
  const button = event.target.closest("button[data-credential-id]");
  if (!button) return;
  const voucherId = button.dataset.credentialId;
  if (!window.confirm(`Remove voucher #${voucherId}? Its existing sessions will stop working immediately.`)) return;
  button.disabled = true;
  try {
    await apiRequest(`/api/admin/vouchers/${encodeURIComponent(button.dataset.credentialId)}`, { method: "DELETE" });
    await loadVouchers();
    setStatus(`Removed voucher #${voucherId}`, "is-ok");
  } catch (error) {
    if (!(error instanceof AuthenticationRequiredError)) setStatus(error.message || "Unable to remove voucher", "is-error");
  } finally {
    button.disabled = false;
  }
});

adminPasswordForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  if (newAdminPassword.value !== confirmAdminPassword.value) {
    setStatus("Admin passwords do not match", "is-error");
    confirmAdminPassword.focus();
    return;
  }
  const password = newAdminPassword.value.trim();
  if (!password) return;
  const submitButton = adminPasswordForm.querySelector("button[type='submit']");
  if (submitButton) submitButton.disabled = true;
  try {
    await apiRequest("/api/admin/password", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ currentPassword: currentAdminPassword.value, password }),
    });
    adminPasswordForm.reset();
    showLogin("Admin password updated. Sign in with the new password.");
  } catch (error) {
    if (!(error instanceof AuthenticationRequiredError)) setStatus(error.message || "Unable to update admin password", "is-error");
  } finally {
    if (submitButton) submitButton.disabled = false;
  }
});

refreshButton.addEventListener("click", loadVouchers);
checkSessionAndStart();
