const content = document.getElementById("docsContent");
const nav = document.getElementById("docsNav");
const statusBox = document.getElementById("docsStatus");
const updatedText = document.getElementById("docsUpdated");
const refreshButton = document.getElementById("refreshButton");
const loginOverlay = document.getElementById("loginOverlay");
const loginForm = document.getElementById("loginForm");
const passwordInput = document.getElementById("passwordInput");
const loginError = document.getElementById("loginError");
let docIdByName = new Map();

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

function docId(name) {
  return `doc-${String(name || "doc").replace(/[^a-z0-9]+/gi, "-").replace(/^-|-$/g, "").toLowerCase()}`;
}

function basename(value) {
  return String(value || "").split("/").pop();
}

function markdownHref(href) {
  const raw = String(href || "").trim();
  const [pathPart, hashPart] = raw.split("#");
  if (/\.md$/i.test(pathPart)) {
    const id = docIdByName.get(basename(pathPart));
    return id ? `#${id}${hashPart ? `-${hashPart}` : ""}` : "#";
  }
  if (/^(https?:|mailto:|#|\/)/i.test(raw)) return raw;
  if (/^[a-z][a-z0-9+.-]*:/i.test(raw)) return "#";
  return raw || "#";
}

function appendInline(parent, text) {
  const source = String(text || "");
  const tokenPattern = /(`[^`]+`|\*\*[^*]+\*\*|\[[^\]]+\]\([^)]+\))/g;
  let cursor = 0;
  let match = tokenPattern.exec(source);
  while (match) {
    if (match.index > cursor) parent.append(document.createTextNode(source.slice(cursor, match.index)));
    const token = match[0];
    if (token.startsWith("`")) {
      parent.append(createElement("code", { text: token.slice(1, -1) }));
    } else if (token.startsWith("**")) {
      parent.append(createElement("strong", { text: token.slice(2, -2) }));
    } else {
      const linkMatch = /^\[([^\]]+)\]\(([^)]+)\)$/.exec(token);
      if (linkMatch) {
        const href = markdownHref(linkMatch[2]);
        const attributes = { href };
        if (/^https?:/i.test(href)) {
          attributes.target = "_blank";
          attributes.rel = "noreferrer";
        }
        const anchor = createElement("a", attributes);
        appendInline(anchor, linkMatch[1]);
        parent.append(anchor);
      }
    }
    cursor = match.index + token.length;
    match = tokenPattern.exec(source);
  }
  if (cursor < source.length) parent.append(document.createTextNode(source.slice(cursor)));
}

function parseTableRow(line) {
  return String(line || "")
    .trim()
    .replace(/^\|/, "")
    .replace(/\|$/, "")
    .split("|")
    .map((cell) => cell.trim());
}

function isTableSeparator(line) {
  return parseTableRow(line).every((cell) => /^:?-{3,}:?$/.test(cell));
}

function tableAlignments(separator) {
  return parseTableRow(separator).map((cell) => (/:$/.test(cell) ? "numeric-cell" : ""));
}

function isSpecialMarkdownLine(line, nextLine = "") {
  return (
    /^#{1,6}\s+/.test(line) ||
    /^```/.test(line) ||
    /^[-*_]{3,}\s*$/.test(line) ||
    /^>\s?/.test(line) ||
    /^-\s+/.test(line) ||
    /^\d+\.\s+/.test(line) ||
    (line.includes("|") && isTableSeparator(nextLine))
  );
}

function renderTable(lines) {
  const header = parseTableRow(lines[0]);
  const alignments = tableAlignments(lines[1]);
  const bodyRows = lines.slice(2).map(parseTableRow);
  return createElement(
    "div",
    { className: "markdown-table-wrap" },
    createElement("table", {}, [
      createElement(
        "thead",
        {},
        createElement(
          "tr",
          {},
          header.map((cell, index) => {
            const th = createElement("th", { className: alignments[index] || "" });
            appendInline(th, cell);
            return th;
          })
        )
      ),
      createElement(
        "tbody",
        {},
        bodyRows.map((row) =>
          createElement(
            "tr",
            {},
            row.map((cell, index) => {
              const td = createElement("td", { className: alignments[index] || "" });
              appendInline(td, cell);
              return td;
            })
          )
        )
      ),
    ])
  );
}

function renderMarkdown(markdown) {
  const root = createElement("div", { className: "markdown-body" });
  const lines = String(markdown || "").replace(/\r\n/g, "\n").split("\n");
  let index = 0;
  let skippedFirstTitle = false;

  while (index < lines.length) {
    const line = lines[index];
    const trimmed = line.trim();
    if (!trimmed) {
      index += 1;
      continue;
    }
    if (!skippedFirstTitle && /^#\s+/.test(trimmed)) {
      skippedFirstTitle = true;
      index += 1;
      continue;
    }
    skippedFirstTitle = true;

    const fence = /^```(\S*)?/.exec(trimmed);
    if (fence) {
      index += 1;
      const codeLines = [];
      while (index < lines.length && !/^```/.test(lines[index].trim())) {
        codeLines.push(lines[index]);
        index += 1;
      }
      if (index < lines.length) index += 1;
      root.append(createElement("pre", {}, createElement("code", { text: codeLines.join("\n") })));
      continue;
    }

    if (line.includes("|") && isTableSeparator(lines[index + 1] || "")) {
      const tableLines = [line, lines[index + 1]];
      index += 2;
      while (index < lines.length && lines[index].includes("|") && lines[index].trim()) {
        tableLines.push(lines[index]);
        index += 1;
      }
      root.append(renderTable(tableLines));
      continue;
    }

    const heading = /^(#{1,6})\s+(.+)$/.exec(trimmed);
    if (heading) {
      const level = Math.min(6, heading[1].length + 1);
      const element = createElement(`h${level}`);
      appendInline(element, heading[2]);
      root.append(element);
      index += 1;
      continue;
    }

    if (/^[-*_]{3,}\s*$/.test(trimmed)) {
      root.append(createElement("hr"));
      index += 1;
      continue;
    }

    const listMatch = /^(-|\d+\.)\s+(.+)$/.exec(trimmed);
    if (listMatch) {
      const ordered = /^\d+\./.test(listMatch[1]);
      const list = createElement(ordered ? "ol" : "ul");
      while (index < lines.length) {
        const itemMatch = ordered ? /^\d+\.\s+(.+)$/.exec(lines[index].trim()) : /^-\s+(.+)$/.exec(lines[index].trim());
        if (!itemMatch) break;
        const item = createElement("li");
        appendInline(item, itemMatch[1]);
        list.append(item);
        index += 1;
      }
      root.append(list);
      continue;
    }

    if (/^>\s?/.test(trimmed)) {
      const parts = [];
      while (index < lines.length && /^>\s?/.test(lines[index].trim())) {
        parts.push(lines[index].trim().replace(/^>\s?/, ""));
        index += 1;
      }
      const paragraph = createElement("p");
      appendInline(paragraph, parts.join(" "));
      root.append(createElement("blockquote", {}, paragraph));
      continue;
    }

    const paragraphLines = [];
    while (
      index < lines.length &&
      lines[index].trim() &&
      !isSpecialMarkdownLine(lines[index].trim(), lines[index + 1] || "")
    ) {
      paragraphLines.push(lines[index].trim());
      index += 1;
    }
    const paragraph = createElement("p");
    appendInline(paragraph, paragraphLines.join(" "));
    root.append(paragraph);
  }

  return root;
}

function setStatus(message, className = "") {
  statusBox.className = `status${className ? ` ${className}` : ""}`;
  statusBox.textContent = message;
}

function renderDocs(payload) {
  const docs = payload.docs || [];
  docIdByName = new Map(docs.map((doc) => [doc.name, docId(doc.name)]));
  nav.replaceChildren(
    ...docs.map((doc) =>
      createElement("a", {
        href: `#${docIdByName.get(doc.name)}`,
        text: doc.title,
      })
    )
  );
  content.replaceChildren(
    ...docs.map((doc) =>
      createElement("article", { className: "docs-document", id: docIdByName.get(doc.name) }, [
        createElement("header", { className: "docs-document-header" }, [
          createElement("h2", { text: doc.title }),
          createElement("span", { text: doc.name }),
        ]),
        renderMarkdown(doc.markdown),
      ])
    )
  );
  updatedText.textContent = `Last refreshed ${new Date(payload.updatedAt || Date.now()).toLocaleString()}`;
  setStatus(docs.length ? `Loaded ${docs.length} markdown file${docs.length === 1 ? "" : "s"}` : "No markdown files found", "is-ok");
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

async function loadDocs() {
  refreshButton.disabled = true;
  setStatus("Loading docs");
  try {
    const response = await fetch("/api/docs", { headers: { Accept: "application/json" } });
    if (response.status === 401) {
      showLogin("Session expired");
      return;
    }
    if (!response.ok) throw new Error(`Request failed with status ${response.status}`);
    renderDocs(await response.json());
  } catch (error) {
    updatedText.textContent = "Unable to load";
    setStatus(error.message || "Unable to load docs", "is-error");
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
    await loadDocs();
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
    await loadDocs();
  } catch {
    loginError.textContent = "Login failed";
  } finally {
    if (submitButton) submitButton.disabled = false;
  }
});

refreshButton.addEventListener("click", loadDocs);
checkSessionAndStart();
