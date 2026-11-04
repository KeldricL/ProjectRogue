"use strict";

// The web app is configured for the Master worksheet and returns JSON or JSONP.
const API_URL = "https://script.google.com/macros/s/AKfycbw_-kRO0YgDvL3n4VQ3xtepP4AZUzVcLoKX7uZc_CS5rMwfihPdWeNZ5QM2PloVx7Jt/exec";
const LINK_COLUMNS = new Set([1, 2, 3, 4]); // B–E only
const statusNode = document.getElementById("status");
const countNode = document.getElementById("record-count");
const searchNode = document.getElementById("global-search");
let table;

function setStatus(message, isError = false) {
  statusNode.textContent = message;
  statusNode.classList.toggle("error", isError);
}

function loadDatabase() {
  return new Promise((resolve, reject) => {
    const callbackName = `kgDatabase_${Date.now()}_${Math.random().toString(36).slice(2)}`;
    const script = document.createElement("script");
    let settled = false;
    const timeout = window.setTimeout(() => finish(new Error("The database took too long to respond. Please try again.")), 90000);

    function finish(error, payload) {
      if (settled) return;
      settled = true;
      window.clearTimeout(timeout);
      delete window[callbackName];
      script.remove();
      if (error) reject(error);
      else resolve(payload);
    }

    window[callbackName] = (payload) => {
      if (!payload || payload.error) {
        finish(new Error(payload?.error || "The database returned an empty response."));
        return;
      }
      finish(null, payload);
    };
    script.onerror = () => finish(new Error("Could not load the Apps Script endpoint. Check that its web app deployment is active and accessible to anyone with the link."));
    script.src = `${API_URL}${API_URL.includes("?") ? "&" : "?"}callback=${encodeURIComponent(callbackName)}&_=${Date.now()}`;
    document.head.appendChild(script);
  });
}

function normalizePayload(payload) {
  if (!Array.isArray(payload.headers) || !Array.isArray(payload.rows)) {
    throw new Error("Unexpected response format. Expected headers and rows arrays.");
  }

  const columns = payload.headers.map((header, index) => ({
    title: String(header || `Column ${index + 1}`),
    titleFormatter: (_cell, formatterParams, onRendered) => {
      const title = document.createElement("span");
      title.textContent = formatterParams.title;
      return title;
    },
    titleFormatterParams: { title: String(header || `Column ${index + 1}`) },
    field: `c${index}`,
    headerFilter: "input",
    headerFilterPlaceholder: "Filter…",
    headerSort: true,
    sorter: "string",
    minWidth: index === 0 ? 190 : 115,
    width: index === 0 ? 230 : undefined,
    frozen: index === 0,
    movable: index !== 0,
    formatter: LINK_COLUMNS.has(index) ? linkFormatter : textFormatter,
  }));

  const data = payload.rows.map((row) => {
    const record = {};
    row.forEach((cell, index) => {
      const safeCell = cell && typeof cell === "object" ? cell : { text: cell, url: null };
      record[`c${index}`] = safeCell.text == null ? "" : String(safeCell.text);
      if (LINK_COLUMNS.has(index)) record[`url${index}`] = safeCell.url || "";
    });
    record.__searchText = Object.keys(record)
      .filter((key) => /^c\d+$/.test(key))
      .map((key) => record[key])
      .join(" ")
      .toLocaleLowerCase();
    return record;
  });

  return { columns, data };
}

function textFormatter(cell) {
  const text = document.createElement("span");
  text.textContent = cell.getValue() ?? "";
  return text;
}

function linkFormatter(cell) {
  const row = cell.getRow().getData();
  const index = Number(cell.getField().slice(1));
  const label = cell.getValue() ?? "";
  const url = row[`url${index}`];
  if (!url || !/^https?:\/\//i.test(url)) return label;

  const anchor = document.createElement("a");
  anchor.textContent = label;
  anchor.href = url;
  anchor.target = "_blank";
  anchor.rel = "noopener noreferrer";
  anchor.setAttribute("aria-label", `${label || "Open link"} (opens in a new tab)`);
  return anchor;
}

function applyGlobalSearch() {
  const query = searchNode.value.trim().toLocaleLowerCase();
  if (!query) {
    table.clearFilter();
    return;
  }
  table.setFilter("__searchText", "like", query);
}

async function start() {
  if (typeof Tabulator === "undefined") {
    setStatus("The table library did not load. Check your connection and refresh the page.", true);
    return;
  }

  try {
    const payload = await loadDatabase();
    const { columns, data } = normalizePayload(payload);
    table = new Tabulator("#game-table", {
      data,
      columns,
      height: "100%",
      layout: "fitData",
      movableColumns: true,
      movableRows: false,
      placeholder: "No games match these filters.",
      renderVertical: "virtual",
      initialSort: [{ column: "c0", dir: "asc" }],
      filterMode: "local",
    });
    searchNode.addEventListener("input", applyGlobalSearch);
    document.getElementById("clear-filters").addEventListener("click", () => {
      searchNode.value = "";
      table.clearFilter(true);
    });

    const count = Number.isFinite(Number(payload.totalRecords)) ? Number(payload.totalRecords) : data.length;
    countNode.textContent = `${count.toLocaleString()} games`;
    setStatus(`Loaded ${count.toLocaleString()} games from the Master worksheet.`);
  } catch (error) {
    console.error("Keldric Gaming database load failed:", error);
    setStatus(`Could not load the game database. ${error.message}`, true);
    countNode.textContent = "";
  }
}

start();
