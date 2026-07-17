# Data Authoring

The supported, batteries-included DataTable product. It is built only on public authoring packages
and SDK contracts, ships in Workbench, and remains embeddable by other hosts. Studios may replace or
augment its UI without rebuilding safe authoring semantics.

The maintained route uses the pinned Peculiar Sheets adapter for virtualized scalar editing, paste,
fill, delete, selection, and dirty-cell presentation. Explicit row actions, undo/redo, recent drafts,
discard, validation diagnostics, and semantic Session Review all call the browser-safe authoring
client; the grid and renderer never own draft truth.

## Adopt this slice

The [adoption guide](ADOPTING.md) defines the supported ownership boundary and Vite/StyleX recipe.
The [manifest](adoption.manifest.json) is the executable source of truth for the copied slice and its
kernel closure. Run `pnpm test:adoption:data-authoring` at the repository root to materialize and
verify a fresh foreign-host workspace without Workbench or Electron imports. The gate builds the
copied native reader, starts the copied `ShedHostLive` server, discovers all fixture DataTables, and
opens a real saved snapshot through the browser transport contract.
