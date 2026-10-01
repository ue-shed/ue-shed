# Data Authoring

The supported, batteries-included DataTable product. It is built only on public authoring packages
and SDK contracts, ships in Workbench, and remains embeddable by other hosts. Studios may replace or
augment its UI without rebuilding safe authoring semantics.

The maintained route uses the pinned Peculiar Sheets adapter for virtualized scalar editing, paste,
fill, delete, selection, and dirty-cell presentation. Explicit row actions, undo/redo, recent drafts,
discard, validation diagnostics, and semantic Session Review all call the browser-safe authoring
client; the grid and renderer never own draft truth.

## Read-only browser viewer

`@ue-shed/extension-data-authoring/viewer` exports `DataTableViewer`,
`FileDataTableOpener`, the standalone grid and Patterns view, and their pure presentation helpers.
This entry does not import the maintained editor route, authoring client or Workbench. The shell
lives in the extension so any browser host can compose it with its own reader, sample and failure
actions. Workbench's editor remains on the existing entry.

Set `AuthoringTableGrid.readOnly` to disable cell and row mutations while retaining selection.
The viewer always does so, even when reflection descriptors mark a column editable. It provides
one compact summary, client-side row filtering, Grid/Charts switching and a name/value cell
inspector; referenced tables are shown as not loaded. The spreadsheet scrolls within its frame
and the inspector stacks below 900px. Row names form a pinned, read-only first column with row-header
semantics in both hosts. Column widths follow saved content within bounds, and the frame follows
the row count up to 70vh. The cell inspector shows the row key and property type; composite parents
use short names with their full paths available on hover.

The shared grid translates sheet coordinates to field coordinates at its operation boundary,
rejects mutations of the row-name column, and keeps view sorting separate from canonical row order.
Dirty rows show an inline "edited" marker beside their name; selection and dirty-cell styling follow
the displayed row identity after sorting. Column sizing remains local and keyed by column ID; the
pinned spreadsheet exposes no column reordering.

`@ue-shed/extension-data-authoring/wasm` exports `adaptWasmAuthoringTable` and
`readWasmAuthoringTable`. Hosts supply a structural runtime exposing `extractAuthoringTable`;
the extension has no WASM package dependency. Effect Schema validates the schema-1 envelope and
the authoritative protocol snapshot. Native snapshot diagnostics remain unchanged; browser warning
codes use the same known `asset_` prefixes as other viewers and retain unknown codes.

The website hosts this shell at `/data-tables`, including a local file picker/drop zone and the
existing `DT_Scalars` sample. Adapter and jsdom tests cover evidence, recovery, selection, filtering,
read-only grid configuration and opener behavior; site Playwright covers the real spreadsheet and
inspector handoff at desktop and mobile widths.

## Adopt this slice

The [adoption guide](ADOPTING.md) defines the supported ownership boundary and Vite/StyleX recipe.
The [manifest](adoption.manifest.json) is the executable source of truth for the copied slice and its
kernel closure. Run `pnpm test:adoption:data-authoring` at the repository root to materialize and
verify a fresh foreign-host workspace without Workbench or Electron imports. The gate builds the
copied native reader, starts the copied `ShedHostLive` server, discovers all fixture DataTables, and
opens a real saved snapshot through the browser transport contract.
