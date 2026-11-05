"use strict";

// This endpoint reads the Master worksheet and returns JSONP for the GitHub Pages site.
const API_URL = "https://script.google.com/macros/s/AKfycbw_-kRO0YgDvL3n4VQ3xtepP4AZUzVcLoKX7uZc_CS5rMwfihPdWeNZ5QM2PloVx7Jt/exec";
const LINK_COLUMNS = new Set([1, 2]); // B and C only (zero-based indexes)
const statusElement = document.getElementById("status");
const countElement = document.getElementById("record-count");
const searchElement = document.getElementById("global-search");
const clearButton = document.getElementById("clear-filters");

let table = null;
let searchableFields = [];

function setStatus(message, isError) {
  statusElement.textContent = message;
  statusElement.classList.toggle("error", Boolean(isError));
}

function loadDatabase() {
  return new Promise(function (resolve, reject) {
    const callbackName = "kgDatabase_" + Date.now() + "_" + Math.random().toString(36).slice(2);
    const script = document.createElement("script");
    let completed = false;

    const timeoutId = window.setTimeout(function () {
      finish(new Error("The database did not respond in time. Please refresh and try again."));
    }, 60000);

    function finish(error, payload) {
      if (completed) return;
      completed = true;
      window.clearTimeout(timeoutId);
      delete window[callbackName];
      script.remove();
      if (error) reject(error);
      else resolve(payload);
    }

    window[callbackName] = function (payload) {
      if (!payload || payload.error) {
        finish(new Error(payload && payload.error ? payload.error : "The database returned no data."));
        return;
      }
      finish(null, payload);
    };

    script.async = true;
    script.onerror = function () {
      finish(new Error("The Apps Script endpoint could not be loaded. Check that the web app deployment is active and accessible."));
    };
    script.src = API_URL + "?callback=" + encodeURIComponent(callbackName) + "&_=" + Date.now();
    document.head.appendChild(script);
  });
}

function makeTextElement(value) {
  const span = document.createElement("span");
  span.textContent = value == null ? "" : String(value);
  return span;
}

function textFormatter(cell) {
  return makeTextElement(cell.getValue());
}

function linkFormatter(cell) {
  const fieldIndex = Number(cell.getField().slice(1));
  const row = cell.getRow().getData();
  const label = cell.getValue() == null ? "" : String(cell.getValue());
  const destination = row["url" + fieldIndex];

  if (!destination) return makeTextElement(label);

  let safeUrl;
  try {
    safeUrl = new URL(String(destination), window.location.href);
  } catch (_error) {
    return makeTextElement(label);
  }

  if (safeUrl.protocol !== "https:" && safeUrl.protocol !== "http:") {
    return makeTextElement(label);
  }

  const anchor = document.createElement("a");
  anchor.href = safeUrl.href;
  anchor.target = "_blank";
  anchor.rel = "noopener noreferrer";
  anchor.textContent = label || safeUrl.hostname;
  anchor.setAttribute("aria-label", anchor.textContent + " (opens in a new tab)");
  return anchor;
}

function normalizeResponse(payload) {
  if (!Array.isArray(payload.headers) || !Array.isArray(payload.rows)) {
    throw new Error("The endpoint response must contain headers and rows arrays.");
  }

  searchableFields = payload.headers.map(function (_header, index) {
    return "c" + index;
  });

const columns = payload.headers.map(function (header, index) {
  const definition = {
    title: header == null || String(header).trim() === ""
      ? "Column " + (index + 1)
      : String(header),
    field: "c" + index,
    headerFilter: "input",
    headerFilterPlaceholder: "Filter…",
    headerSort: true,
    sorter: "string",
    minWidth: index === 0 ? 190 : 115,
    frozen: index === 0,
    hozAlign: index === 0 ? "left" : "center",
    headerHozAlign: index === 0 ? "left" : "center",
    formatter: LINK_COLUMNS.has(index) ? linkFormatter : textFormatter,
  };

  if (index === 1) {
    definition.sorterParams = { alignEmptyValues: "top" };
  }

  if (index === 0) definition.width = 230;
  return definition;
});

  const data = payload.rows.filter(Array.isArray).map(function (row) {
    const record = {};
    payload.headers.forEach(function (_header, index) {
      const cell = row[index];
      const cellObject = cell && typeof cell === "object" ? cell : { text: cell, url: null };
      record["c" + index] = cellObject.text == null ? "" : String(cellObject.text);
      if (LINK_COLUMNS.has(index)) record["url" + index] = cellObject.url || "";
    });
    return record;
  });

  return { columns: columns, data: data };
}

function globalSearchFilter(rowData) {
  const query = searchElement.value.trim().toLocaleLowerCase();
  if (!query) return true;

  return searchableFields.some(function (field) {
    return String(rowData[field] || "").toLocaleLowerCase().includes(query);
  });
}

function applyGlobalSearch() {
  if (!table) return;
  if (searchElement.value.trim() === "") {
    table.clearFilter(); // Keeps the individual column header filters.
  } else {
    table.setFilter(globalSearchFilter);
  }
}

async function startDatabase() {
  if (typeof window.Tabulator === "undefined") {
    setStatus("The table library did not load. Check your internet connection and refresh.", true);
    return;
  }

  setStatus("Loading game database…", false);

  try {
    const payload = await loadDatabase();
    const normalized = normalizeResponse(payload);

    table = new window.Tabulator("#game-table", {
      data: normalized.data,
      columns: normalized.columns,
      height: "100%",
      layout: "fitData",
      movableColumns: true,
      movableRows: false,
      placeholder: "No games match these filters.",
      initialSort: [{ column: "c1", dir: "asc" }],
    });

    searchElement.addEventListener("input", applyGlobalSearch);
    clearButton.addEventListener("click", function () {
      searchElement.value = "";
      table.clearFilter(true);
    });

    const recordCount = Number(payload.totalRecords);
    const shownCount = Number.isFinite(recordCount) ? recordCount : normalized.data.length;
    countElement.textContent = shownCount.toLocaleString() + " games";
    setStatus("Loaded " + shownCount.toLocaleString() + " games from the Master worksheet.", false);
  } catch (error) {
    console.error("Keldric Gaming database error:", error);
    countElement.textContent = "";
    setStatus("Could not load the game database. " + error.message, true);
  }
}

startDatabase();
