# Data Authoring

The supported, batteries-included DataTable product. It is built only on public authoring packages
and SDK contracts, ships in Workbench, and remains embeddable by other hosts. Studios may replace or
augment its UI without rebuilding safe authoring semantics.

The maintained route uses the pinned Peculiar Sheets adapter for virtualized scalar editing, paste,
fill, delete, selection, and dirty-cell presentation. Explicit row actions, undo/redo, recent drafts,
discard, validation diagnostics, and semantic Session Review all call the browser-safe authoring
client; the grid and renderer never own draft truth.
