"use strict";

// This endpoint reads the Master worksheet and returns JSONP for the GitHub Pages site.
const API_URL = "https://script.google.com/macros/s/AKfycbw_-kRO0YgDvL3n4VQ3xtepP4AZUzVcLoKX7uZc_CS5rMwfihPdWeNZ5QM2PloVx7Jt/exec";
const LINK_COLUMNS = new Set([1, 2]); // B and C only (zero-based indexes)
const GEMSTATION_TRIGGER = "##gemstation";
const GEMSTATION_DATE_FIELD = "c46"; // AU, zero-based column index
const GEMSTATION_VISIBLE_FIELDS = new Set(["c0", "c2", "c3", "c4", "c6", "c42", "c43", GEMSTATION_DATE_FIELD]);
const COMPARISON_FILTER_OPTIONS = [
  { abbreviation: "Atomicrops-like", phrase: "Atomicrops" },
  { abbreviation: "Brotato-Like", phrase: "Brotato" },
  { abbreviation: "COTL-Like", phrase: "Cult of the Lamb" },
  { abbreviation: "Dead Cells-Like", phrase: "Dead Cells" },
  { abbreviation: "DMD-Like", phrase: "Death Must Die" },
  { abbreviation: "ETG-Like", phrase: "Enter the Gungeon" },
  { abbreviation: "Hades-Like", phrase: "Hades" },
  { abbreviation: "Megabonk-Like", phrase: "Megabonk" },
  { abbreviation: "ROR2-Like", phrase: "Risk of Rain 2" },
  { abbreviation: "Soulstone-like", phrase: "Soulstone Survivors" },
  { abbreviation: "Spelunky-Like", phrase: "Spelunky" },
  { abbreviation: "STS-Like", phrase: "Slay the Spire" },
  { abbreviation: "TBOI-Like", phrase: "Binding of Isaac" },
  { abbreviation: "VS-Like", phrase: "Vampire Survivors" },
  { abbreviation: "Ziggurat-Like", phrase: "Ziggurat" },
];
const statusElement = document.getElementById("status");
const countElement = document.getElementById("record-count");
const searchElement = document.getElementById("global-search");
const clearButton = document.getElementById("clear-filters");
const retryButton = document.getElementById("retry-database");
const fullscreenButton = document.getElementById("fullscreen-toggle");
const COLUMN_PREFERENCES_KEY = "keldric-gaming-hidden-columns-v1";
const ANALYTICS_SEARCH_DEBOUNCE_MS = 1000;

let table = null;
let searchableFields = [];
let databaseHeaders = [];
let isLoading = false;
let databaseControlsBound = false;
let databaseRows = [];
let hiddenColumnFields = loadHiddenColumns();
let gemstationModeActive = false;
let columnPickerToggleButton = null;
let columnPickerMenu = null;
let comparisonFilterSelect = null;
let comparisonFilterField = "";
let surpriseDialogParts = null;
let surpriseEligibleRows = [];
let surpriseHistory = [];
let surpriseHistoryIndex = -1;
let syncColumnPickerCheckboxes = function () {};
const columnFilterStates = new Map();
const columnFilterControls = new Map();
const analyticsTimers = new Map();
let activeValueMenu = null;
let valueMenuElement = null;

function loadHiddenColumns() {
  try {
    const stored = JSON.parse(window.localStorage.getItem(COLUMN_PREFERENCES_KEY) || "[]");
    if (!Array.isArray(stored)) return new Set();
    return new Set(stored.filter(function (field) {
      return typeof field === "string" && /^c\d+$/.test(field) && field !== "c0";
    }));
  } catch (_error) {
    return new Set();
  }
}

function saveHiddenColumns() {
  try {
    window.localStorage.setItem(COLUMN_PREFERENCES_KEY, JSON.stringify(Array.from(hiddenColumnFields)));
  } catch (_error) {
    // The chooser still works for this visit if browser storage is unavailable.
  }
}

function setStatus(message, isError) {
  statusElement.textContent = message;
  statusElement.classList.toggle("error", Boolean(isError));
}

function sendUsageEvent(eventName, parameters) {
  if (typeof window.gtag !== "function") return;
  window.gtag("event", eventName, Object.assign({ transport_type: "beacon" }, parameters || {}));
}

function safeAnalyticsText(value, maxLength) {
  const text = String(value == null ? "" : value).trim().replace(/\s+/g, " ");
  if (text.length < 2 || /@|https?:\/\/|www\./i.test(text)) return "";
  const digitCount = (text.match(/\d/g) || []).length;
  if (digitCount >= 7) return "";
  return text.slice(0, maxLength || 80);
}

function activeResultCount() {
  if (!table || typeof table.getDataCount !== "function") return 0;
  return table.getDataCount("active");
}

function analyticsDestinationUrl(url) {
  let parsed;
  try {
    parsed = new URL(String(url));
  } catch (_error) {
    return "";
  }

  const hostname = parsed.hostname.toLocaleLowerCase();
  if (hostname === "youtu.be" || hostname === "youtube.com" || hostname.endsWith(".youtube.com")) {
    let videoId = parsed.searchParams.get("v") || "";
    if (!videoId && hostname === "youtu.be") videoId = parsed.pathname.split("/").filter(Boolean)[0] || "";
    if (!videoId) {
      const videoPath = parsed.pathname.match(/^\/(?:shorts|embed|live)\/([A-Za-z0-9_-]+)/i);
      if (videoPath) videoId = videoPath[1];
    }
    if (videoId) return "https://www.youtube.com/watch?v=" + encodeURIComponent(videoId);
  }

  const safeParameters = new URLSearchParams();
  parsed.searchParams.forEach(function (value, key) {
    if (/^(utm_.+|fbclid|gclid|dclid|msclkid|ref|ref_src|si|snr)$/i.test(key)) return;
    if (/email|phone|token|auth|session/i.test(key) || /@|https?:\/\//i.test(value)) return;
    safeParameters.append(key, value);
  });

  const query = safeParameters.toString();
  return parsed.origin + parsed.pathname + (query ? "?" + query : "");
}

function scheduleSearchUsage(scope, field, title, readQuery) {
  const timerKey = "search:" + scope + ":" + field;
  const oldTimer = analyticsTimers.get(timerKey);
  if (oldTimer) window.clearTimeout(oldTimer);

  const rawQuery = String(readQuery() || "").trim();
  if (!rawQuery || rawQuery.toLocaleLowerCase() === GEMSTATION_TRIGGER) return;

  const timer = window.setTimeout(function () {
    analyticsTimers.delete(timerKey);
    const currentQuery = String(readQuery() || "").trim();
    const queryTerm = safeAnalyticsText(currentQuery, 80);
    if (!queryTerm || currentQuery.toLocaleLowerCase() === GEMSTATION_TRIGGER) return;

    const parameters = {
      search_scope: scope,
      search_term: queryTerm,
      result_count: activeResultCount(),
    };
    if (field) parameters.column_name = safeAnalyticsText(title, 60) || "Column";
    sendUsageEvent("database_search", parameters);
  }, ANALYTICS_SEARCH_DEBOUNCE_MS);

  analyticsTimers.set(timerKey, timer);
}

function scheduleColumnFilterUsage(field, title, state) {
  const timerKey = "filter:" + field;
  const oldTimer = analyticsTimers.get(timerKey);
  if (oldTimer) window.clearTimeout(oldTimer);

  const snapshot = {
    query: String(state.query || "").trim(),
    selectedValues: Array.isArray(state.selectedValues) ? state.selectedValues.slice() : [],
    notesOnly: Boolean(state.notesOnly),
  };

  const timer = window.setTimeout(function () {
    analyticsTimers.delete(timerKey);
    const values = snapshot.selectedValues
      .slice(0, 5)
      .map(function (value) { return safeAnalyticsText(value, 24); })
      .filter(Boolean);
    const filterTypes = [];
    if (snapshot.query) filterTypes.push("text");
    if (snapshot.selectedValues.length) filterTypes.push("selected_values");
    if (snapshot.notesOnly) filterTypes.push("notes_only");

    sendUsageEvent("database_filter", {
      column_name: safeAnalyticsText(title, 60) || "Column",
      filter_type: filterTypes.join(",") || "cleared",
      selected_value_count: snapshot.selectedValues.length,
      selected_values: values.join(" | ").slice(0, 100),
      notes_only: snapshot.notesOnly,
      result_count: activeResultCount(),
    });
  }, ANALYTICS_SEARCH_DEBOUNCE_MS);

  analyticsTimers.set(timerKey, timer);
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

function gameNameFormatter(cell) {
  const gameName = cell.getValue() == null ? "" : String(cell.getValue());
  const note = String(cell.getRow().getData().note0 || "").trim();
  if (!note) return makeTextElement(gameName);

  const wrapper = document.createElement("span");
  wrapper.className = "game-name-with-note";

  const name = document.createElement("span");
  name.className = "game-name-note-text";
  name.textContent = gameName;

  const indicator = document.createElement("span");
  indicator.className = "game-note-indicator";
  indicator.textContent = "i";
  indicator.title = "This game has a note. Hover to read it.";
  indicator.setAttribute("aria-label", "This game has a note. Hover to read it.");

  wrapper.append(name, indicator);
  return wrapper;
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
  anchor.addEventListener("click", function () {
    sendUsageEvent("database_link_click", {
      game_name: safeAnalyticsText(row.c0, 80),
      column_name: safeAnalyticsText(cell.getColumn().getDefinition().title, 60) || "Link",
      link_domain: safeAnalyticsText(safeUrl.hostname, 100),
      destination_url: analyticsDestinationUrl(safeUrl.href),
    });
  });
  return anchor;
}

function getColumnFilterState(field) {
  if (!columnFilterStates.has(field)) {
    columnFilterStates.set(field, { query: "", selectedValues: [], notesOnly: false });
  }
  return columnFilterStates.get(field);
}

function createColumnHeaderFilter(cell, _onRendered, success) {
  const column = cell.getColumn();
  const field = column.getField();
  const title = column.getDefinition().title;
  const state = getColumnFilterState(field);

  const wrapper = document.createElement("div");
  wrapper.className = "column-filter-control";

  const input = document.createElement("input");
  input.type = "search";
  input.className = "column-filter-text";
  input.placeholder = "Filter…";
  input.setAttribute("aria-label", "Filter " + title);
  input.autocomplete = "off";
  input.value = state.query;

  const choicesButton = document.createElement("button");
  choicesButton.type = "button";
  choicesButton.className = "column-filter-choices";
  choicesButton.textContent = "▾";
  choicesButton.title = "Choose values for " + title;
  choicesButton.setAttribute("aria-label", "Choose values for " + title);
  choicesButton.setAttribute("aria-haspopup", "dialog");
  choicesButton.setAttribute("aria-expanded", "false");

  function commitFilter() {
    state.query = input.value;
    if (field === comparisonFilterField && comparisonFilterSelect) {
      const matchingOption = COMPARISON_FILTER_OPTIONS.find(function (option) {
        return option.abbreviation.toLocaleLowerCase() === state.query.trim().toLocaleLowerCase();
      });
      comparisonFilterSelect.value = matchingOption ? matchingOption.abbreviation : "";
    }
    success({
      query: state.query,
      selectedValues: state.selectedValues.slice(),
      notesOnly: state.notesOnly,
    });
    updateChoicesButton(choicesButton, state, field);
    scheduleSearchUsage("column", field, title, function () { return input.value; });
  }

  input.addEventListener("input", commitFilter);
  choicesButton.addEventListener("click", function (event) {
    event.preventDefault();
    event.stopPropagation();
    openColumnValueMenu(field, title, choicesButton, success);
  });

  wrapper.append(input, choicesButton);
  columnFilterControls.set(field, { input: input, button: choicesButton, success: success });
  updateChoicesButton(choicesButton, state, field);
  return wrapper;
}

function combinedColumnHeaderFilter(filterValue, cellValue, rowData) {
  if (!filterValue) return true;

  const value = cellValue == null ? "" : String(cellValue);
  const query = String(filterValue.query || "").trim().toLocaleLowerCase();
  const selectedValues = Array.isArray(filterValue.selectedValues) ? filterValue.selectedValues : [];

  if (query && !value.toLocaleLowerCase().includes(query)) return false;
  if (selectedValues.length && !selectedValues.includes(value)) return false;
  if (filterValue.notesOnly && !String(rowData && rowData.note0 || "").trim()) return false;
  return true;
}

function getColumnValueOptions(field) {
  const counts = new Map();
  databaseRows.forEach(function (row) {
    const value = row[field] == null ? "" : String(row[field]);
    counts.set(value, (counts.get(value) || 0) + 1);
  });

  return Array.from(counts.entries()).map(function (entry) {
    return { value: entry[0], count: entry[1] };
  }).sort(function (a, b) {
    return (a.value || "").localeCompare(b.value || "", undefined, { sensitivity: "base" });
  });
}

function updateChoicesButton(button, state, field) {
  const active = state.selectedValues.length > 0 || state.notesOnly;
  button.classList.toggle("is-active", active);
  button.setAttribute("aria-pressed", String(active));
  if (active) {
    const selectedMessage = state.selectedValues.length
      ? state.selectedValues.length + " values selected"
      : "";
    const notesMessage = state.notesOnly ? "games with notes only" : "";
    button.title = [selectedMessage, notesMessage].filter(Boolean).join("; ") + " for " + field + "; change choices";
  } else {
    button.title = "Choose values for " + field;
  }
}

function ensureColumnValueMenu() {
  if (valueMenuElement) return valueMenuElement;

  const menu = document.createElement("div");
  menu.className = "column-value-menu";
  menu.hidden = true;
  menu.setAttribute("role", "dialog");
  menu.setAttribute("aria-label", "Filter column values");

  const headingRow = document.createElement("div");
  headingRow.className = "column-value-menu-heading";
  const title = document.createElement("strong");
  title.className = "column-value-menu-title";
  const closeButton = document.createElement("button");
  closeButton.type = "button";
  closeButton.className = "column-value-menu-close";
  closeButton.textContent = "×";
  closeButton.setAttribute("aria-label", "Close choices");
  headingRow.append(title, closeButton);

  const search = document.createElement("input");
  search.type = "search";
  search.className = "column-value-menu-search";
  search.placeholder = "Find a value…";
  search.setAttribute("aria-label", "Find a value in this column");
  search.autocomplete = "off";

  const notesOnlyLabel = document.createElement("label");
  notesOnlyLabel.className = "column-value-notes-only";
  const notesOnlyCheckbox = document.createElement("input");
  notesOnlyCheckbox.type = "checkbox";
  const notesOnlyText = document.createElement("span");
  notesOnlyText.textContent = "Only games with notes";
  notesOnlyLabel.append(notesOnlyCheckbox, notesOnlyText);

  const actions = document.createElement("div");
  actions.className = "column-value-menu-actions";
  const selectAllButton = document.createElement("button");
  selectAllButton.type = "button";
  selectAllButton.textContent = "Select all";
  const clearChoicesButton = document.createElement("button");
  clearChoicesButton.type = "button";
  clearChoicesButton.textContent = "Clear choices";
  actions.append(selectAllButton, clearChoicesButton);

  const list = document.createElement("div");
  list.className = "column-value-menu-list";
  list.setAttribute("role", "group");

  const message = document.createElement("div");
  message.className = "column-value-menu-message";
  message.setAttribute("aria-live", "polite");

  const footer = document.createElement("div");
  footer.className = "column-value-menu-footer";
  const selectedCount = document.createElement("span");
  selectedCount.className = "column-value-menu-selected-count";
  const doneButton = document.createElement("button");
  doneButton.type = "button";
  doneButton.className = "column-value-menu-done";
  doneButton.textContent = "Done";
  footer.append(selectedCount, doneButton);

  menu.append(headingRow, search, notesOnlyLabel, actions, list, message, footer);
  document.body.appendChild(menu);
  valueMenuElement = menu;

  search.addEventListener("input", renderColumnValueOptions);
  notesOnlyCheckbox.addEventListener("change", function () {
    if (!activeValueMenu) return;
    activeValueMenu.state.notesOnly = notesOnlyCheckbox.checked;
    commitActiveValueMenu();
    renderColumnValueOptions();
  });
  list.addEventListener("change", function (event) {
    if (!activeValueMenu || !event.target.matches("input[type='checkbox']")) return;
    const value = event.target.value;
    const selected = new Set(activeValueMenu.state.selectedValues);
    if (event.target.checked) selected.add(value);
    else selected.delete(value);
    activeValueMenu.state.selectedValues = Array.from(selected);
    commitActiveValueMenu();
    renderColumnValueOptions();
  });

  selectAllButton.addEventListener("click", function () {
    if (!activeValueMenu) return;
    activeValueMenu.state.selectedValues = activeValueMenu.options.map(function (item) { return item.value; });
    commitActiveValueMenu();
    renderColumnValueOptions();
  });

  clearChoicesButton.addEventListener("click", function () {
    if (!activeValueMenu) return;
    activeValueMenu.state.selectedValues = [];
    commitActiveValueMenu();
    renderColumnValueOptions();
  });

  function close() {
    closeColumnValueMenu(true);
  }
  closeButton.addEventListener("click", close);
  doneButton.addEventListener("click", close);

  document.addEventListener("pointerdown", function (event) {
    if (!activeValueMenu) return;
    if (menu.contains(event.target) || activeValueMenu.button.contains(event.target)) return;
    closeColumnValueMenu(false);
  });

  document.addEventListener("keydown", function (event) {
    if (event.key === "Escape" && activeValueMenu) closeColumnValueMenu(true);
  });

  document.addEventListener("scroll", function (event) {
    if (!activeValueMenu || menu.contains(event.target)) return;
    positionColumnValueMenu();
  }, true);
  window.addEventListener("resize", positionColumnValueMenu);

  return menu;
}

function openColumnValueMenu(field, title, button, success) {
  const menu = ensureColumnValueMenu();
  activeValueMenu = {
    field: field,
    title: title,
    button: button,
    success: success,
    state: getColumnFilterState(field),
    options: getColumnValueOptions(field),
  };

  menu.querySelector(".column-value-menu-title").textContent = "Filter: " + title;
  menu.querySelector(".column-value-menu-search").value = "";
  const notesOnlyLabel = menu.querySelector(".column-value-notes-only");
  const notesOnlyCheckbox = notesOnlyLabel.querySelector("input");
  notesOnlyLabel.hidden = field !== "c0";
  notesOnlyCheckbox.checked = field === "c0" && activeValueMenu.state.notesOnly;
  menu.hidden = false;
  button.setAttribute("aria-expanded", "true");
  renderColumnValueOptions();
  positionColumnValueMenu();
  menu.querySelector(".column-value-menu-search").focus();
}

function renderColumnValueOptions() {
  if (!activeValueMenu || !valueMenuElement) return;

  const menu = valueMenuElement;
  const search = menu.querySelector(".column-value-menu-search").value.trim().toLocaleLowerCase();
  const list = menu.querySelector(".column-value-menu-list");
  const message = menu.querySelector(".column-value-menu-message");
  const selected = new Set(activeValueMenu.state.selectedValues);
  const matches = activeValueMenu.options.filter(function (option) {
    const label = option.value === "" ? "(blank)" : option.value;
    return label.toLocaleLowerCase().includes(search);
  });
  const visible = matches.slice(0, 250);

  list.replaceChildren();
  visible.forEach(function (option) {
    const label = document.createElement("label");
    label.className = "column-value-choice";
    const checkbox = document.createElement("input");
    checkbox.type = "checkbox";
    checkbox.value = option.value;
    checkbox.checked = selected.has(option.value);
    const text = document.createElement("span");
    text.className = "column-value-choice-label";
    text.textContent = option.value === "" ? "(blank)" : option.value;
    const count = document.createElement("span");
    count.className = "column-value-choice-count";
    count.textContent = option.count.toLocaleString();
    label.append(checkbox, text, count);
    list.appendChild(label);
  });

  if (!matches.length) {
    message.textContent = "No values match that search.";
  } else if (matches.length > visible.length) {
    message.textContent = "Showing the first 250 of " + matches.length.toLocaleString() + " values. Search to narrow the list.";
  } else {
    message.textContent = matches.length.toLocaleString() + " values";
  }

  const selectedText = selected.size ? selected.size.toLocaleString() + " selected" : "No value filter";
  menu.querySelector(".column-value-menu-selected-count").textContent =
    activeValueMenu.state.notesOnly ? selectedText + " · notes only" : selectedText;
}

function commitActiveValueMenu() {
  if (!activeValueMenu) return;
  const state = activeValueMenu.state;
  activeValueMenu.success({
    query: state.query,
    selectedValues: state.selectedValues.slice(),
    notesOnly: state.notesOnly,
  });
  updateChoicesButton(activeValueMenu.button, state, activeValueMenu.title);
  scheduleColumnFilterUsage(activeValueMenu.field, activeValueMenu.title, state);
}

function positionColumnValueMenu() {
  if (!activeValueMenu || !valueMenuElement || valueMenuElement.hidden) return;
  const menu = valueMenuElement;

  if (window.matchMedia("(max-width: 600px)").matches) {
    menu.style.left = "";
    menu.style.top = "";
    menu.style.transform = "";
    return;
  }

  menu.style.transform = "none";
  const rect = activeValueMenu.button.getBoundingClientRect();
  const width = menu.offsetWidth;
  const height = menu.offsetHeight;
  const left = Math.max(8, Math.min(rect.left, window.innerWidth - width - 8));
  let top = rect.bottom + 6;
  if (top + height > window.innerHeight - 8) top = rect.top - height - 6;
  top = Math.max(8, Math.min(top, window.innerHeight - height - 8));
  menu.style.left = left + "px";
  menu.style.top = top + "px";
}

function closeColumnValueMenu(returnFocus) {
  if (!activeValueMenu || !valueMenuElement) return;
  const button = activeValueMenu.button;
  valueMenuElement.hidden = true;
  button.setAttribute("aria-expanded", "false");
  activeValueMenu = null;
  if (returnFocus) button.focus();
}

function clearColumnFilters() {
  columnFilterStates.forEach(function (state) {
    state.query = "";
    state.selectedValues = [];
    state.notesOnly = false;
  });
  columnFilterControls.forEach(function (control, field) {
    control.input.value = "";
    updateChoicesButton(control.button, getColumnFilterState(field), field);
  });
  closeColumnValueMenu(false);
  if (comparisonFilterSelect) comparisonFilterSelect.value = "";
}

function normalizeResponse(payload) {
  if (!Array.isArray(payload.headers) || !Array.isArray(payload.rows)) {
    throw new Error("The endpoint response must contain headers and rows arrays.");
  }

  searchableFields = payload.headers.map(function (_header, index) {
    return "c" + index;
  });
  databaseHeaders = payload.headers.map(function (header, index) {
    const label = header == null ? "" : String(header).replace(/\?+/g, "").trim();
    return label || "Column " + (index + 1);
  });
  comparisonFilterField = "";
  payload.headers.some(function (header, index) {
    if (String(header == null ? "" : header).replace(/\?+/g, "").trim().toLocaleLowerCase() !== "comparison") return false;
    comparisonFilterField = "c" + index;
    return true;
  });

  const isPhone = window.matchMedia("(max-width: 600px)").matches;

  const columns = payload.headers.map(function (header, index) {
    const definition = {
      title: databaseHeaders[index],
      field: "c" + index,
      visible: index === 0 || (index !== 46 && !hiddenColumnFields.has("c" + index)),
      headerFilter: createColumnHeaderFilter,
      headerFilterFunc: combinedColumnHeaderFilter,
      headerFilterLiveFilter: false,
      headerSort: true,
      sorter: "string",
      minWidth: index === 0
        ? (isPhone ? 130 : 190)
        : (isPhone ? 90 : 115),
      frozen: index === 0,
      hozAlign: index === 0 ? "left" : "center",
      headerHozAlign: index === 0 ? "left" : "center",
      formatter: index === 0
        ? gameNameFormatter
        : (LINK_COLUMNS.has(index) ? linkFormatter : textFormatter),
    };

    if (index === 0) {
      definition.tooltip = function (_event, cell) {
        const note = String(cell.getRow().getData().note0 || "").trim();
        if (!note) return false;
        const tooltip = document.createElement("div");
        tooltip.className = "game-note-tooltip-content";
        tooltip.textContent = note;
        return tooltip;
      };
    }

    if (index === 1) {
      definition.sorter = function (a, b, aRow, bRow) {
        const aData = aRow.getData();
        const bData = bRow.getData();
        const aText = a == null ? "" : String(a).trim();
        const bText = b == null ? "" : String(b).trim();
        const aUrl = String(aData.url1 || "").trim();
        const bUrl = String(bData.url1 || "").trim();
        const aHasData = Boolean(aText || aUrl);
        const bHasData = Boolean(bText || bUrl);

        // This is a grouping sort: rows with Video Links first, blanks last.
        // Return 0 within each group so the secondary Game Name sort can order them.
        if (aHasData === bHasData) return 0;
        return aHasData ? -1 : 1;
      };
    }

    if (index === 46) {
      definition.sorter = function (a, b) {
        const aText = a == null ? "" : String(a).trim();
        const bText = b == null ? "" : String(b).trim();
        const aTime = Date.parse(aText);
        const bTime = Date.parse(bText);
        const aValid = Number.isFinite(aTime);
        const bValid = Number.isFinite(bTime);
        if (aValid && bValid) return aTime - bTime;
        if (aValid !== bValid) return aValid ? 1 : -1;
        return aText.localeCompare(bText, undefined, { numeric: true, sensitivity: "base" });
      };
    }

    if (index === 0) definition.width = isPhone ? 150 : 230;
    return definition;
  });

  const data = payload.rows.filter(Array.isArray).map(function (row) {
    const record = {};
    payload.headers.forEach(function (_header, index) {
      const cell = row[index];
      const cellObject = cell && typeof cell === "object" ? cell : { text: cell, url: null };
      record["c" + index] = cellObject.text == null ? "" : String(cellObject.text);
      if (LINK_COLUMNS.has(index)) record["url" + index] = cellObject.url || "";
      if (index === 0) record.note0 = String(cellObject.note || "");
    });
    record._searchText = searchableFields.map(function (field) {
      return String(record[field] || "").toLocaleLowerCase();
    }).join("\u0000");
    return record;
  });

  // Establish the default order before Tabulator initializes. This avoids
  // multi-sort precedence differences: YouTube-linked games first, then names A-Z.
  function videoLinkPriority(record) {
    const label = String(record.c1 || "").trim();
    const url = String(record.url1 || "").trim();
    if (/youtube|youtu\.be/i.test(label + " " + url)) return 0;
    if (label || url) return 1;
    return 2;
  }

  data.sort(function (a, b) {
    const priorityDifference = videoLinkPriority(a) - videoLinkPriority(b);
    if (priorityDifference !== 0) return priorityDifference;
    return String(a.c0 || "").localeCompare(String(b.c0 || ""), undefined, {
      sensitivity: "base",
      numeric: true,
    });
  });

  databaseRows = data;
  return { columns: columns, data: data };
}

const NON_DATA_VALUES = new Set(["n", "none", "na", "n/a"]);

function cleanGameValue(value) {
  return String(value == null ? "" : value).trim();
}

function isMeaningfulGameValue(value) {
  const text = cleanGameValue(value);
  return Boolean(text) && !NON_DATA_VALUES.has(text.toLocaleLowerCase());
}

function hasAtLeastThreeDataPoints(row) {
  let count = 0;
  for (let index = 5; index <= 38; index += 1) {
    if (isMeaningfulGameValue(row["c" + index])) count += 1;
    if (count >= 3) return true;
  }
  return false;
}

function findSurpriseCardFields() {
  const comparisonIndex = databaseHeaders.findIndex(function (header) {
    return header.toLocaleLowerCase().includes("comparison");
  });
  const gameTypeIndices = databaseHeaders.map(function (header, index) {
    return /game\s*type/i.test(header) ? index : -1;
  }).filter(function (index) { return index >= 0; });
  let themeIndices = databaseHeaders.map(function (header, index) {
    return /\bthemes?\b/i.test(header) ? index : -1;
  }).filter(function (index) { return index >= 0; }).slice(0, 2);

  if (!themeIndices.length) {
    themeIndices = [42, 43].filter(function (index) { return index < databaseHeaders.length; });
  } else if (themeIndices.length === 1 && databaseHeaders.length > 43) {
    const fallbackThemeIndex = themeIndices[0] === 42 ? 43 : 42;
    if (fallbackThemeIndex < databaseHeaders.length) themeIndices.push(fallbackThemeIndex);
  }

  return {
    comparison: comparisonIndex,
    themes: themeIndices,
    gameTypes: gameTypeIndices,
  };
}

function createSurpriseDialog() {
  if (surpriseDialogParts) return surpriseDialogParts;

  const dialog = document.createElement("dialog");
  dialog.className = "surprise-dialog";
  dialog.setAttribute("aria-label", "Surprise game");

  const layout = document.createElement("div");
  layout.className = "surprise-dialog-layout";

  const previousButton = document.createElement("button");
  previousButton.type = "button";
  previousButton.className = "surprise-nav-button surprise-previous";
  previousButton.setAttribute("aria-label", "Previous surprise game");
  previousButton.title = "Previous game";
  previousButton.textContent = "←";
  previousButton.hidden = true;
  previousButton.addEventListener("click", function () { moveSurpriseHistory(-1); });

  const nextButton = document.createElement("button");
  nextButton.type = "button";
  nextButton.className = "surprise-nav-button surprise-next";
  nextButton.setAttribute("aria-label", "Another random game");
  nextButton.title = "Another random game";
  nextButton.textContent = "→";
  nextButton.addEventListener("click", function () { moveSurpriseHistory(1); });

  const card = document.createElement("article");
  card.className = "surprise-card";

  const cardHeader = document.createElement("header");
  cardHeader.className = "surprise-card-header";
  const title = document.createElement("h2");
  title.className = "surprise-game-title";
  const closeButton = document.createElement("button");
  closeButton.type = "button";
  closeButton.className = "surprise-close";
  closeButton.setAttribute("aria-label", "Close surprise game card");
  closeButton.textContent = "×";
  closeButton.addEventListener("click", function () { dialog.close(); });
  cardHeader.append(title, closeButton);

  const body = document.createElement("div");
  body.className = "surprise-card-body";
  const primary = document.createElement("section");
  primary.className = "surprise-primary-fields";
  primary.setAttribute("aria-label", "Game summary");
  const tags = document.createElement("section");
  tags.className = "surprise-tags";
  tags.setAttribute("aria-label", "Comparison and themes");
  const details = document.createElement("section");
  details.className = "surprise-details";
  details.setAttribute("aria-label", "Game details");
  const links = document.createElement("section");
  links.className = "surprise-links";
  links.setAttribute("aria-label", "Game links and thumbnails");
  body.append(primary, tags, details, links);
  card.append(cardHeader, body);

  layout.append(previousButton, card, nextButton);
  dialog.appendChild(layout);
  document.body.appendChild(dialog);
  dialog.addEventListener("click", function (event) {
    if (event.target === dialog) dialog.close();
  });

  surpriseDialogParts = {
    dialog: dialog,
    previousButton: previousButton,
    nextButton: nextButton,
    body: body,
    title: title,
    primary: primary,
    tags: tags,
    details: details,
    links: links,
  };
  return surpriseDialogParts;
}

function appendSurpriseSectionHeading(parent, headingText) {
  const heading = document.createElement("h3");
  heading.className = "surprise-section-heading";
  heading.textContent = headingText;
  parent.appendChild(heading);
}

function appendSurpriseFact(parent, fieldIndex, value) {
  if (!isMeaningfulGameValue(value)) return;
  const fact = document.createElement("div");
  fact.className = "surprise-primary-fact";
  const label = document.createElement("span");
  label.className = "surprise-field-label";
  label.textContent = databaseHeaders[fieldIndex] || "Column " + (fieldIndex + 1);
  const answer = document.createElement("span");
  answer.className = "surprise-field-value";
  answer.textContent = cleanGameValue(value);
  fact.append(label, answer);
  parent.appendChild(fact);
}

function splitGameTags(value) {
  return cleanGameValue(value).split(/[,;|\n]+/).map(function (tag) {
    return tag.trim();
  }).filter(isMeaningfulGameValue);
}

function appendSurpriseTagGroup(parent, fieldIndex, value) {
  if (fieldIndex < 0 || !isMeaningfulGameValue(value)) return;
  const group = document.createElement("div");
  group.className = "surprise-tag-group";
  const label = document.createElement("h3");
  label.className = "surprise-tag-heading";
  label.textContent = databaseHeaders[fieldIndex] || "Tags";
  const chipList = document.createElement("div");
  chipList.className = "surprise-tag-list";
  splitGameTags(value).forEach(function (tagText) {
    const chip = document.createElement("span");
    chip.className = "surprise-tag";
    chip.textContent = tagText;
    chipList.appendChild(chip);
  });
  if (!chipList.childElementCount) return;
  group.append(label, chipList);
  parent.appendChild(group);
}

function appendSurpriseDetails(parent, row, excludedFields) {
  const detailFields = [];
  const yesFeatures = [];
  for (let index = 6; index <= 38; index += 1) {
    const field = "c" + index;
    const value = cleanGameValue(row[field]);
    if (excludedFields.has(index) || !isMeaningfulGameValue(value)) continue;
    if (/^(y|yes)$/i.test(value)) {
      yesFeatures.push(databaseHeaders[index]);
      continue;
    }
    detailFields.push({ index: index, value: value });
  }
  if (!detailFields.length && !yesFeatures.length) return;

  appendSurpriseSectionHeading(parent, "Game details");
  if (detailFields.length) {
    const grid = document.createElement("div");
    grid.className = "surprise-detail-grid";
    detailFields.forEach(function (item) {
      const entry = document.createElement("div");
      entry.className = "surprise-detail-item";
      const label = document.createElement("span");
      label.className = "surprise-detail-label";
      label.textContent = databaseHeaders[item.index];
      const separator = document.createElement("span");
      separator.className = "surprise-detail-separator";
      separator.textContent = "—";
      const value = document.createElement("span");
      value.className = "surprise-detail-value";
      value.textContent = item.value;
      entry.append(label, separator, value);
      grid.appendChild(entry);
    });
    parent.appendChild(grid);
  }

  if (yesFeatures.length) {
    const featureSection = document.createElement("div");
    featureSection.className = "surprise-feature-section";
    const featureHeading = document.createElement("h4");
    featureHeading.className = "surprise-feature-heading";
    featureHeading.textContent = "Features";
    const featureList = document.createElement("div");
    featureList.className = "surprise-feature-list";
    yesFeatures.forEach(function (featureTitle) {
      const chip = document.createElement("span");
      chip.className = "surprise-feature-chip";
      chip.textContent = featureTitle;
      featureList.appendChild(chip);
    });
    featureSection.append(featureHeading, featureList);
    parent.appendChild(featureSection);
  }
}

function getSurpriseLinkKind(url, label) {
  let hostname = "";
  try { hostname = new URL(url).hostname.toLocaleLowerCase(); } catch (_error) {}
  const combined = (hostname + " " + label).toLocaleLowerCase();
  if (/youtube|youtu\.be/.test(combined)) return "youtube";
  if (/steampowered|steamcommunity/.test(combined)) return "steam";
  if (/itch\.io/.test(combined)) return "itch";
  return "website";
}

function getYoutubeVideoId(url) {
  try {
    const parsed = new URL(url);
    if (parsed.hostname.toLocaleLowerCase() === "youtu.be") return parsed.pathname.split("/").filter(Boolean)[0] || "";
    const queryId = parsed.searchParams.get("v");
    if (queryId) return queryId;
    const pathMatch = parsed.pathname.match(/^\/(?:shorts|embed|live)\/([A-Za-z0-9_-]+)/i);
    return pathMatch ? pathMatch[1] : "";
  } catch (_error) {
    return "";
  }
}

function getSurpriseThumbnailCandidates(link) {
  const kind = getSurpriseLinkKind(link.url, link.label);
  const candidates = [];
  if (kind === "youtube") {
    const videoId = getYoutubeVideoId(link.url);
    if (videoId) candidates.push("https://img.youtube.com/vi/" + encodeURIComponent(videoId) + "/mqdefault.jpg");
  }
  if (kind === "steam") {
    const appMatch = link.url.match(/(?:store\.steampowered\.com|steamcommunity\.com)\/app\/(\d+)/i);
    if (appMatch) {
      const appId = appMatch[1];
      candidates.push(
        "https://shared.steamstatic.com/store_item_assets/steam/apps/" + appId + "/header.jpg",
        "https://shared.akamai.steamstatic.com/store_item_assets/steam/apps/" + appId + "/header.jpg",
        "https://cdn.akamai.steamstatic.com/steam/apps/" + appId + "/header.jpg",
        "https://cdn.akamai.steamstatic.com/steam/apps/" + appId + "/capsule_231x87.jpg"
      );
    }
  }
  try {
    const parsed = new URL(link.url);
    candidates.push("https://www.google.com/s2/favicons?domain_url=" + encodeURIComponent(parsed.origin) + "&sz=128");
  } catch (_error) {
    return candidates;
  }
  return candidates;
}

function trackSurpriseLinkClick(row, link, index) {
  let hostname = "";
  try { hostname = new URL(link.url).hostname; } catch (_error) {}
  sendUsageEvent("database_link_click", {
    game_name: safeAnalyticsText(row.c0, 80),
    column_name: safeAnalyticsText(databaseHeaders[index], 60) || "Game link",
    link_domain: safeAnalyticsText(hostname, 100),
    destination_url: analyticsDestinationUrl(link.url),
  });
}

function appendSurpriseLinks(parent, row) {
  const foundLinks = [1, 2].map(function (index) {
    const url = cleanGameValue(row["url" + index]);
    if (!/^https?:\/\//i.test(url)) return null;
    return {
      index: index,
      url: url,
      label: cleanGameValue(row["c" + index]),
      kind: getSurpriseLinkKind(url, cleanGameValue(row["c" + index])),
    };
  }).filter(Boolean);
  const order = { youtube: 0, steam: 1, website: 2, itch: 3 };
  foundLinks.sort(function (a, b) { return order[a.kind] - order[b.kind]; });

  appendSurpriseSectionHeading(parent, "Links");
  if (!foundLinks.length) {
    const message = document.createElement("p");
    message.className = "surprise-no-links";
    message.textContent = "No game links are listed.";
    parent.appendChild(message);
    return;
  }

  const linkCards = document.createElement("div");
  linkCards.className = "surprise-link-cards";
  foundLinks.forEach(function (link) {
    const kindLabel = { youtube: "YouTube", steam: "Steam", website: "Website", itch: "itch.io" }[link.kind];
    const label = link.label || kindLabel;
    const linkCard = document.createElement("div");
    linkCard.className = "surprise-link-card";
    const anchor = document.createElement("a");
    anchor.href = link.url;
    anchor.target = "_blank";
    anchor.rel = "noopener noreferrer";
    anchor.className = "surprise-game-link";
    anchor.textContent = label;
    anchor.addEventListener("click", function () { trackSurpriseLinkClick(row, link, link.index); });
    linkCard.appendChild(anchor);

    const thumbnailAnchor = document.createElement("a");
    thumbnailAnchor.href = link.url;
    thumbnailAnchor.target = "_blank";
    thumbnailAnchor.rel = "noopener noreferrer";
    thumbnailAnchor.className = "surprise-thumbnail-link";
    thumbnailAnchor.setAttribute("aria-label", label + " thumbnail (opens in a new tab)");
    thumbnailAnchor.addEventListener("click", function () { trackSurpriseLinkClick(row, link, link.index); });
    const thumbnailCandidates = getSurpriseThumbnailCandidates(link);
    if (thumbnailCandidates.length) {
      const image = document.createElement("img");
      image.alt = "";
      image.loading = "lazy";
      let thumbnailCandidateIndex = 0;
      image.addEventListener("error", function () {
        thumbnailCandidateIndex += 1;
        if (thumbnailCandidateIndex < thumbnailCandidates.length) {
          image.src = thumbnailCandidates[thumbnailCandidateIndex];
        } else {
          thumbnailAnchor.classList.add("thumbnail-unavailable");
          image.remove();
          thumbnailAnchor.textContent = kindLabel;
        }
      });
      thumbnailAnchor.appendChild(image);
      image.src = thumbnailCandidates[0];
    } else {
      thumbnailAnchor.classList.add("thumbnail-unavailable");
      thumbnailAnchor.textContent = kindLabel;
    }
    linkCard.appendChild(thumbnailAnchor);
    linkCards.appendChild(linkCard);
  });
  parent.appendChild(linkCards);
}

function renderSurpriseGame(row) {
  const parts = createSurpriseDialog();
  parts.title.textContent = cleanGameValue(row.c0) || "Untitled game";
  parts.primary.replaceChildren();
  parts.tags.replaceChildren();
  parts.details.replaceChildren();
  parts.links.replaceChildren();

  [3, 4, 5].forEach(function (index) {
    appendSurpriseFact(parts.primary, index, row["c" + index]);
  });

  const cardFields = findSurpriseCardFields();
  const tagColumns = document.createElement("div");
  tagColumns.className = "surprise-tag-columns";
  const gameTypeColumn = document.createElement("div");
  gameTypeColumn.className = "surprise-tag-column surprise-game-types-column";
  const categoryColumn = document.createElement("div");
  categoryColumn.className = "surprise-tag-column surprise-category-tags-column";
  cardFields.gameTypes.forEach(function (index) {
    appendSurpriseTagGroup(gameTypeColumn, index, row["c" + index]);
  });
  appendSurpriseTagGroup(categoryColumn, cardFields.comparison, row["c" + cardFields.comparison]);
  cardFields.themes.forEach(function (index) {
    appendSurpriseTagGroup(categoryColumn, index, row["c" + index]);
  });
  if (gameTypeColumn.childElementCount) tagColumns.appendChild(gameTypeColumn);
  if (categoryColumn.childElementCount) tagColumns.appendChild(categoryColumn);
  if (tagColumns.childElementCount === 1) tagColumns.classList.add("single-tag-column");
  if (tagColumns.childElementCount) parts.tags.appendChild(tagColumns);

  const excludedDetailFields = new Set([5, cardFields.comparison].concat(cardFields.themes, cardFields.gameTypes));
  appendSurpriseDetails(parts.details, row, excludedDetailFields);
  appendSurpriseLinks(parts.links, row);
  if (!parts.primary.childElementCount) parts.primary.hidden = true;
  else parts.primary.hidden = false;
  if (!parts.tags.childElementCount) parts.tags.hidden = true;
  else parts.tags.hidden = false;
  if (!parts.details.childElementCount) parts.details.hidden = true;
  else parts.details.hidden = false;

  parts.previousButton.hidden = surpriseHistoryIndex <= 0;
  parts.nextButton.hidden = false;
  if (!parts.dialog.open) parts.dialog.showModal();
  else parts.body.scrollTop = 0;
}

function openSurpriseMe() {
  if (!table) return;
  const activeRows = table.getData("active");
  surpriseEligibleRows = activeRows.filter(hasAtLeastThreeDataPoints);
  if (!surpriseEligibleRows.length) {
    setStatus("No games with at least 3 data points match the current search and filters.", true);
    return;
  }
  const selected = surpriseEligibleRows[Math.floor(Math.random() * surpriseEligibleRows.length)];
  surpriseHistory = [selected];
  surpriseHistoryIndex = 0;
  renderSurpriseGame(selected);
}

function moveSurpriseHistory(direction) {
  if (direction < 0) {
    if (surpriseHistoryIndex <= 0) return;
    surpriseHistoryIndex -= 1;
    renderSurpriseGame(surpriseHistory[surpriseHistoryIndex]);
    return;
  }

  if (surpriseHistoryIndex < surpriseHistory.length - 1) {
    surpriseHistoryIndex += 1;
    renderSurpriseGame(surpriseHistory[surpriseHistoryIndex]);
    return;
  }

  if (!surpriseEligibleRows.length) return;
  const currentRow = surpriseHistory[surpriseHistoryIndex];
  const options = surpriseEligibleRows.filter(function (row) { return row !== currentRow; });
  const pool = options.length ? options : surpriseEligibleRows;
  const nextRow = pool[Math.floor(Math.random() * pool.length)];
  surpriseHistory.push(nextRow);
  surpriseHistoryIndex += 1;
  renderSurpriseGame(nextRow);
}

function globalSearchFilter(rowData) {
  const query = searchElement.value.trim().toLocaleLowerCase();
  if (!query) return true;

  if (typeof rowData._searchText === "string") {
    return rowData._searchText.includes(query);
  }

  return searchableFields.some(function (field) {
    return String(rowData[field] || "").toLocaleLowerCase().includes(query);
  });
}

function applyGlobalSearch() {
  if (!table) return;
  if (searchElement.value.trim().toLocaleLowerCase() === GEMSTATION_TRIGGER) {
    enterGemstationMode();
    return;
  }
  if (gemstationModeActive) leaveGemstationMode();

  if (searchElement.value.trim() === "") {
    table.clearFilter(); // Keeps the individual column header filters.
  } else {
    table.setFilter(globalSearchFilter);
  }
}

function hasActiveUserFilters() {
  if (gemstationModeActive || searchElement.value.trim()) return true;
  return Array.from(columnFilterStates.values()).some(function (state) {
    return Boolean(
      String(state.query || "").trim() ||
      (Array.isArray(state.selectedValues) && state.selectedValues.length) ||
      state.notesOnly
    );
  });
}

function enterGemstationMode() {
  if (!table || gemstationModeActive) return;
  if (!table.getColumn(GEMSTATION_DATE_FIELD)) {
    setStatus("The Gemstation view needs the database feed to include Master columns through AU.", true);
    return;
  }

  gemstationModeActive = true;
  clearColumnFilters();
  table.clearFilter(true);
  table.getColumns().forEach(function (column) {
    const field = column.getField();
    if (GEMSTATION_VISIBLE_FIELDS.has(field)) column.show();
    else column.hide();
  });
  if (columnPickerMenu) columnPickerMenu.hidden = true;
  if (columnPickerToggleButton) {
    columnPickerToggleButton.disabled = true;
    columnPickerToggleButton.setAttribute("aria-expanded", "false");
  }
  if (comparisonFilterSelect) comparisonFilterSelect.disabled = true;
  table.setFilter(function (rowData) {
    return Boolean(String(rowData[GEMSTATION_DATE_FIELD] || "").trim());
  });
  table.setSort(GEMSTATION_DATE_FIELD, "desc");
  setStatus("Gemstation view: submitted games, newest first.", false);
}

function leaveGemstationMode() {
  if (!gemstationModeActive || !table) return;
  gemstationModeActive = false;
  table.clearFilter(true);
  clearColumnFilters();
  table.clearSort();
  table.getColumns().forEach(function (column) {
    const field = column.getField();
    if (field === "c0" || (field !== GEMSTATION_DATE_FIELD && !hiddenColumnFields.has(field))) column.show();
    else column.hide();
  });
  if (columnPickerToggleButton) columnPickerToggleButton.disabled = false;
  if (comparisonFilterSelect) comparisonFilterSelect.disabled = !comparisonFilterField;
  syncColumnPickerCheckboxes();

  const query = searchElement.value.trim();
  if (query) table.setFilter(globalSearchFilter);
  else table.clearFilter();
  const count = Number(countElement.textContent.replace(/[^0-9]/g, ""));
  setStatus("Loaded " + (Number.isFinite(count) ? count.toLocaleString() : databaseRows.length.toLocaleString()) + " games from the Master worksheet.", false);
}

async function toggleFullscreen() {
  try {
    if (document.fullscreenElement) {
      await document.exitFullscreen();
      return;
    }

    if (!document.fullscreenEnabled || typeof document.documentElement.requestFullscreen !== "function") {
      setStatus("Full screen is not available in this browser or embed.", true);
      return;
    }

    await document.documentElement.requestFullscreen();
  } catch (error) {
    console.error("Keldric Gaming full-screen error:", error);
    setStatus("Could not enter full screen. Check that the Blogger iframe allows full screen, or press Esc to exit.", true);
  }
}

fullscreenButton.addEventListener("click", toggleFullscreen);

document.addEventListener("fullscreenchange", function () {
  const isFullscreen = Boolean(document.fullscreenElement);
  fullscreenButton.textContent = isFullscreen ? "Exit full screen" : "Full screen";
  fullscreenButton.setAttribute("aria-pressed", String(isFullscreen));
  if (table) window.requestAnimationFrame(function () { table.redraw(true); });
});

function addColumnPicker(columns) {
  const headerActions = document.querySelector(".header-actions");
  if (!headerActions) return;

  const actionRow = document.createElement("div");
  actionRow.className = "header-button-row";
  const fullscreenRow = document.createElement("div");
  fullscreenRow.className = "header-button-row";
  if (fullscreenButton && fullscreenButton.parentElement === headerActions) {
    headerActions.insertBefore(actionRow, fullscreenButton);
    headerActions.insertBefore(fullscreenRow, fullscreenButton);
    fullscreenRow.appendChild(fullscreenButton);
  } else {
    headerActions.append(actionRow, fullscreenRow);
    if (fullscreenButton) fullscreenRow.appendChild(fullscreenButton);
  }

  const toggleButton = document.createElement("button");
  toggleButton.id = "column-picker-toggle";
  toggleButton.type = "button";
  toggleButton.textContent = "Choose columns";
  toggleButton.setAttribute("aria-expanded", "false");
  toggleButton.setAttribute("aria-controls", "column-picker-menu");
  columnPickerToggleButton = toggleButton;

  const surpriseButton = document.createElement("button");
  surpriseButton.id = "surprise-me-button";
  surpriseButton.type = "button";
  surpriseButton.textContent = "Surprise me";
  surpriseButton.setAttribute("aria-label", "Show a random game matching the current filters");
  surpriseButton.addEventListener("click", openSurpriseMe);

  const comparisonSelect = document.createElement("select");
  comparisonSelect.id = "comparison-game-filter";
  comparisonSelect.className = "comparison-filter-select";
  comparisonSelect.setAttribute("aria-label", "Filter Comparison by game");
  const defaultOption = document.createElement("option");
  defaultOption.value = "";
  defaultOption.textContent = "Compare by game…";
  comparisonSelect.appendChild(defaultOption);
  COMPARISON_FILTER_OPTIONS.forEach(function (option) {
    const item = document.createElement("option");
    item.value = option.abbreviation;
    item.textContent = option.phrase;
    comparisonSelect.appendChild(item);
  });
  comparisonFilterSelect = comparisonSelect;
  comparisonSelect.disabled = !comparisonFilterField;
  if (!comparisonFilterField) comparisonSelect.title = "The database feed does not include a Comparison column.";
  actionRow.append(comparisonSelect, toggleButton, surpriseButton);

  comparisonSelect.addEventListener("change", function () {
    if (!comparisonFilterField) return;
    const control = columnFilterControls.get(comparisonFilterField);
    if (!control) return;
    const state = getColumnFilterState(comparisonFilterField);
    state.query = comparisonSelect.value;
    state.selectedValues = [];
    state.notesOnly = false;
    control.input.value = state.query;
    control.success({
      query: state.query,
      selectedValues: [],
      notesOnly: false,
    });
    updateChoicesButton(control.button, state, comparisonFilterField);
    scheduleSearchUsage("column", comparisonFilterField, "Comparison", function () {
      return state.query;
    });
  });

  const menu = document.createElement("div");
  menu.id = "column-picker-menu";
  menu.className = "column-picker-menu";
  menu.hidden = true;
  menu.setAttribute("role", "dialog");
  menu.setAttribute("aria-label", "Choose visible columns");
  columnPickerMenu = menu;

  const menuHeader = document.createElement("div");
  menuHeader.className = "column-picker-header";

  const menuTitle = document.createElement("strong");
  menuTitle.textContent = "Visible columns";

  const showAllButton = document.createElement("button");
  showAllButton.type = "button";
  showAllButton.className = "column-picker-show-all";
  showAllButton.textContent = "Show all";

  const choiceList = document.createElement("div");
  choiceList.className = "column-picker-list";
  choiceList.setAttribute("role", "group");
  choiceList.setAttribute("aria-label", "Database columns");

  const doneButton = document.createElement("button");
  doneButton.type = "button";
  doneButton.className = "column-picker-done";
  doneButton.textContent = "Done";

  menuHeader.append(menuTitle, showAllButton);
  menu.append(menuHeader, choiceList, doneButton);
  headerActions.appendChild(menu);

  const checkboxes = [];

  function syncCheckboxes() {
    checkboxes.forEach(function (entry) {
      entry.checkbox.checked = entry.field === "c0" || (entry.field !== GEMSTATION_DATE_FIELD && !hiddenColumnFields.has(entry.field));
    });
  }
  syncColumnPickerCheckboxes = syncCheckboxes;

  columns.forEach(function (definition) {
    const field = definition.field;
    const label = document.createElement("label");
    label.className = "column-picker-choice";

    const checkbox = document.createElement("input");
    checkbox.type = "checkbox";
    checkbox.checked = field === "c0" || (field !== GEMSTATION_DATE_FIELD && !hiddenColumnFields.has(field));
    checkbox.disabled = field === "c0" || field === GEMSTATION_DATE_FIELD;

    const text = document.createElement("span");
    text.textContent = field === "c0"
      ? definition.title + " (always shown)"
      : (field === GEMSTATION_DATE_FIELD ? definition.title + " (Gemstation view only)" : definition.title);

    checkbox.addEventListener("change", function () {
      const column = table.getColumn(field);
      if (!column || field === "c0" || field === GEMSTATION_DATE_FIELD) {
        checkbox.checked = true;
        return;
      }

      if (checkbox.checked) {
        column.show();
        hiddenColumnFields.delete(field);
      } else {
        column.hide();
        hiddenColumnFields.add(field);
      }

      saveHiddenColumns();
      window.requestAnimationFrame(function () {
        table.redraw(true);
      });
    });

    label.append(checkbox, text);
    choiceList.appendChild(label);
    checkboxes.push({ field: field, checkbox: checkbox });
  });

  function closeMenu() {
    menu.hidden = true;
    toggleButton.setAttribute("aria-expanded", "false");
  }

  toggleButton.addEventListener("click", function () {
    menu.hidden = !menu.hidden;
    toggleButton.setAttribute("aria-expanded", String(!menu.hidden));
    if (!menu.hidden) {
      const firstEnabled = choiceList.querySelector("input:not(:disabled)");
      if (firstEnabled) firstEnabled.focus();
    }
  });

  showAllButton.addEventListener("click", function () {
    hiddenColumnFields.clear();
    columns.forEach(function (definition) {
      if (definition.field !== "c0" && definition.field !== GEMSTATION_DATE_FIELD) table.showColumn(definition.field);
    });
    saveHiddenColumns();
    syncCheckboxes();
    window.requestAnimationFrame(function () {
      table.redraw(true);
    });
  });

  doneButton.addEventListener("click", function () {
    closeMenu();
    toggleButton.focus();
  });

  document.addEventListener("click", function (event) {
    if (!menu.hidden && !menu.contains(event.target) && !toggleButton.contains(event.target)) {
      closeMenu();
    }
  });

  document.addEventListener("keydown", function (event) {
    if (event.key === "Escape" && !menu.hidden) {
      closeMenu();
      toggleButton.focus();
    }
  });
}

async function startDatabase() {
  if (isLoading) return;
  isLoading = true;
  retryButton.hidden = true;
  retryButton.disabled = true;
  retryButton.textContent = "Reloading…";

  if (typeof window.Tabulator === "undefined") {
    setStatus("The table library did not load. Check your internet connection and refresh.", true);
    retryButton.hidden = false;
    retryButton.disabled = false;
    retryButton.textContent = "Reload database";
    isLoading = false;
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
    });

    addColumnPicker(normalized.columns);

    if (!databaseControlsBound) {
      searchElement.addEventListener("input", function () {
        applyGlobalSearch();
        scheduleSearchUsage("all_columns", "", "", function () { return searchElement.value; });
      });
      clearButton.addEventListener("click", function () {
        const filtersWereActive = hasActiveUserFilters();
        searchElement.value = "";
      if (gemstationModeActive) {
        leaveGemstationMode();
        return;
      }
        if (filtersWereActive) sendUsageEvent("database_filters_cleared", { result_count: databaseRows.length });
        clearColumnFilters();
        table.clearFilter(true);
      });
    applyGlobalSearch();
      databaseControlsBound = true;
    }

    const recordCount = Number(payload.totalRecords);
    const shownCount = Number.isFinite(recordCount) ? recordCount : normalized.data.length;
    countElement.textContent = shownCount.toLocaleString() + " games";
    setStatus("Loaded " + shownCount.toLocaleString() + " games from the Master worksheet.", false);
  } catch (error) {
    console.error("Keldric Gaming database error:", error);
    if (table) {
      setStatus("Could not reload the database. The currently loaded data is still shown. " + error.message, true);
    } else {
      countElement.textContent = "";
      setStatus("Could not load the game database. " + error.message, true);
    }
    retryButton.hidden = false;
  } finally {
    retryButton.disabled = false;
    retryButton.textContent = "Reload database";
    isLoading = false;
  }
}

retryButton.addEventListener("click", startDatabase);

startDatabase();
