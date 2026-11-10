"use strict";

// This endpoint reads the Master worksheet and returns JSONP for the GitHub Pages site.
const API_URL = "https://script.google.com/macros/s/AKfycbw_-kRO0YgDvL3n4VQ3xtepP4AZUzVcLoKX7uZc_CS5rMwfihPdWeNZ5QM2PloVx7Jt/exec";
const LINK_COLUMNS = new Set([1, 2]); // B and C only (zero-based indexes)
const statusElement = document.getElementById("status");
const countElement = document.getElementById("record-count");
const searchElement = document.getElementById("global-search");
const clearButton = document.getElementById("clear-filters");
const retryButton = document.getElementById("retry-database");
const fullscreenButton = document.getElementById("fullscreen-toggle");
const COLUMN_PREFERENCES_KEY = "keldric-gaming-hidden-columns-v1";

let table = null;
let searchableFields = [];
let isLoading = false;
let databaseControlsBound = false;
let databaseRows = [];
let hiddenColumnFields = loadHiddenColumns();
const columnFilterStates = new Map();
const columnFilterControls = new Map();
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
    success({
      query: state.query,
      selectedValues: state.selectedValues.slice(),
      notesOnly: state.notesOnly,
    });
    updateChoicesButton(choicesButton, state, field);
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
}

function normalizeResponse(payload) {
  if (!Array.isArray(payload.headers) || !Array.isArray(payload.rows)) {
    throw new Error("The endpoint response must contain headers and rows arrays.");
  }

  searchableFields = payload.headers.map(function (_header, index) {
    return "c" + index;
  });

  const isPhone = window.matchMedia("(max-width: 600px)").matches;

  const columns = payload.headers.map(function (header, index) {
    const definition = {
      title: header == null || String(header).trim() === ""
        ? "Column " + (index + 1)
        : String(header),
      field: "c" + index,
      visible: index === 0 || !hiddenColumnFields.has("c" + index),
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
  if (fullscreenButton && fullscreenButton.parentElement === headerActions) {
    headerActions.insertBefore(actionRow, fullscreenButton);
    actionRow.appendChild(fullscreenButton);
  } else {
    headerActions.appendChild(actionRow);
  }

  const toggleButton = document.createElement("button");
  toggleButton.id = "column-picker-toggle";
  toggleButton.type = "button";
  toggleButton.textContent = "Choose columns";
  toggleButton.setAttribute("aria-expanded", "false");
  toggleButton.setAttribute("aria-controls", "column-picker-menu");
  actionRow.insertBefore(toggleButton, fullscreenButton || null);

  const menu = document.createElement("div");
  menu.id = "column-picker-menu";
  menu.className = "column-picker-menu";
  menu.hidden = true;
  menu.setAttribute("role", "dialog");
  menu.setAttribute("aria-label", "Choose visible columns");

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
      entry.checkbox.checked = entry.field === "c0" || !hiddenColumnFields.has(entry.field);
    });
  }

  columns.forEach(function (definition) {
    const field = definition.field;
    const label = document.createElement("label");
    label.className = "column-picker-choice";

    const checkbox = document.createElement("input");
    checkbox.type = "checkbox";
    checkbox.checked = field === "c0" || !hiddenColumnFields.has(field);
    checkbox.disabled = field === "c0";

    const text = document.createElement("span");
    text.textContent = field === "c0" ? definition.title + " (always shown)" : definition.title;

    checkbox.addEventListener("change", function () {
      const column = table.getColumn(field);
      if (!column || field === "c0") {
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
      window.requestAnimationFrame(function () { table.redraw(true); });
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
      if (definition.field !== "c0") table.showColumn(definition.field);
    });
    saveHiddenColumns();
    syncCheckboxes();
    window.requestAnimationFrame(function () { table.redraw(true); });
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
      searchElement.addEventListener("input", applyGlobalSearch);
      clearButton.addEventListener("click", function () {
        searchElement.value = "";
        clearColumnFilters();
        table.clearFilter(true);
      });
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
