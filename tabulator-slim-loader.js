import {
  Tabulator,
  EditModule,
  FilterModule,
  FormatModule,
  FrozenColumnsModule,
  MoveColumnsModule,
  ResizeColumnsModule,
  ResizeTableModule,
  SortModule,
  TooltipModule,
} from "https://esm.sh/tabulator-tables@6.5.0";

Tabulator.registerModule([
  EditModule,          // Header filter inputs
  FilterModule,        // Global and column filtering
  FormatModule,        // Custom cell formatters
  FrozenColumnsModule, // Keep the game name visible while scrolling
  MoveColumnsModule,   // Let visitors rearrange columns
  ResizeColumnsModule, // Column sizing
  ResizeTableModule,   // Redraw when the frame changes size
  SortModule,          // Column sorting
  TooltipModule,       // Game-note hover text
]);

window.Tabulator = Tabulator;

// Start the existing database application only after Tabulator is ready.
const app = document.createElement("script");
app.src = "app.js?v=20261114-filter-order-independent-1";
app.onerror = function () {
  const status = document.getElementById("status");
  if (status) status.textContent = "The database application could not load. Please reload the page.";
};
document.body.appendChild(app);
