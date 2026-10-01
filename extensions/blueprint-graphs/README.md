# Blueprint Graphs extension

Private, browser-safe SolidJS viewer for saved Blueprint graphs. Pure graph navigation, search,
layout, and display transformations remain in `@ue-shed/blueprints`. The host owns asset acquisition,
transport, project selection, theme, and the `@ue-shed/ui` `EffectRuntimeProvider`.

The root export provides `BlueprintGraphViewer`, `ProjectBlueprintSearch`, their prop/control types,
and the contracts. `@ue-shed/extension-blueprint-graphs/contract` exports the single definitions of
`BlueprintGraphReadResult`, `BlueprintGraphFailureReason`, `BlueprintAssetCandidate`,
`BlueprintAssetSearchRequest`, `BlueprintAssetSearchResult`, `BlueprintAssetPath`, and
`BLUEPRINT_ASSET_SEARCH_LIMIT`. The result, request, candidate, reason, and path exports are Effect
Schemas with inferred types. This subpath imports no UI code.

`BlueprintGraphViewerProps` accepts:

- `opener(controls): JSX.Element`, required. The viewer creates it once and places it in the empty
  state or beside the open Blueprint title. `BlueprintGraphOpenerControls` exposes `open(read)`,
  reactive `loading` and `hasBlueprint` getters, and `observeSourceBusy(accessor)` for the route's
  `aria-busy` state. Register the accessor synchronously during opener setup; the viewer derives
  activity directly from it, including initial loading. Registration does not write reactive state.
  Call `open(read)` from event handlers or effect callbacks such as `onSettled`, never during render.
- `initialRead?: BlueprintGraphReadEffect`, an optional mount-time read for host navigation.
- `failureActions?(failure): JSX.Element`, optional host actions inside the package failure
  callout. The message and recovery occupy separate lines. The website uses this slot to inspect
  the same non-Blueprint file without choosing it again.
- `footer?(read, controls): JSX.Element`, rendered for a ready read. `read` is
  `ReadyBlueprintGraphRead`; `BlueprintGraphFooterControls` exposes `open(read)` and
  `reveal(objectPath)` to select a graph or node without resetting the viewport.
  Invoke these controls from event handlers or effect callbacks, never during render.
- `transportFailureCopy?: BlueprintGraphTransportFailureCopy`, containing `title`, `message`, and
  `recovery`. The default copy is host-neutral.

`BlueprintGraphReadEffect` is `Effect.Effect<BlueprintGraphReadResult, unknown>` with no required
environment. Reads use the shared owner-scoped action adapter: replacement and teardown interrupt
pending work; cancelled results retain the previous graph; Effect failures show transport failure.
Hosts keep their typed failures until this rendering boundary.

`ProjectBlueprintSearchProps` accepts the opener `controls`,
`searchBlueprints(request): Effect.Effect<BlueprintAssetSearchResult, unknown>`,
`readBlueprint(path): BlueprintGraphReadEffect`, and optional `noProjectHint` copy. It owns the
debounced project search, result list, dropdown, and keyboard navigation. A different host can
provide any opener that calls `controls.open()` with a read; the core has no project-index dependency.

Workbench lazy-loads this package and composes its IPC functions and `SavedReviewPanel` in
`apps/workbench/src/renderer/blueprint-graphs-route.tsx`. It overrides host-specific copy and turns
`initialAssetPath` into `initialRead`. The References / Compare implementation stays in Workbench.

Verify with `pnpm --filter @ue-shed/extension-blueprint-graphs typecheck` and
`node scripts/test.ts --project component extensions/blueprint-graphs`. The Workbench renderer build
also proves StyleX compilation across the package boundary.

## Local file and WASM hosts

The root also exports `FileBlueprintOpener`, `FileBlueprintOpenerProps`, `FileBlueprintSample`,
and `MAX_BLUEPRINT_FILE_BYTES` (64 MiB). Provide the viewer's `controls`, an Effect-based
`readFile(file)` function, and optionally `{ label, load() }` for a sample. The opener validates
size before invoking the reader, supplies an accessible file input and drop zone, and becomes a
compact file-picker button once a Blueprint is open. Drops anywhere inside the containing viewer
also open files; listeners are released on unmount.

`@ue-shed/extension-blueprint-graphs/wasm` exports `adaptWasmBlueprintResult(path, output)` and
`readWasmBlueprint(runtime, path, bytes)`, plus the structural `WasmBlueprintRuntime` interface.
Both return `Effect<BlueprintGraphReadResult>` without importing the WASM package or UI. Hosts
may initialize a runtime themselves or pass output returned by a worker to the adapter. The adapter
validates the WASM envelope and reuses `BlueprintGraphProjection` from `@ue-shed/protocol`.
The one-package projection supports zero or one Blueprint; multiple records are invalid evidence.

| WASM kind / result                                                | Viewer reason / outcome                       |
| ----------------------------------------------------------------- | --------------------------------------------- |
| `unsupported_capability`                                          | `control_rig`                                 |
| `unsupported_version`                                             | `unsupported_version`                         |
| `malformed_data`                                                  | `malformed_package`                           |
| `unsupported_format`                                              | `unsupported_asset`                           |
| `resource_limit`, `internal`, invalid evidence, runtime exception | `reader_failure`                              |
| Empty `blueprints`                                                | `unsupported_asset` (native `unsupported`)    |
| `ok`, `partial`                                                   | Ready with `complete`, `partial` respectively |

The five parser diagnostic codes (`malformed_data`, `resource_limit`, `unsupported_format`,
`unsupported_version`, `unsupported_capability`) become `asset_<code>`; other codes pass through
unchanged. Severity is `warning`, matching native `scan_failure_code` and
`protocol_adapter::emit_diagnostic`. Recovery copy addresses a browser,
without native executable configuration. The site composes this surface at `/blueprints` with
an Effect-scoped module worker; Workbench still uses its native reader.

The website also composes the [Asset Inspector](../asset-inspector/README.md) at `/inspect`.
Its worker can inspect a package and extract Blueprint evidence in one request. Graph-displayable
ready evidence opens this viewer through `initialRead`, without a second file pick or reload.
The site owns the tab-local handoff and navigation. A non-Blueprint file dropped on `/blueprints`
offers inspection of the same file. The extension's file opener and graph contract stay unchanged.

Adapter tests are in the node project; opener/viewer tests are in the component project:

```powershell
node scripts/test.ts --without-uasset --project node extensions/blueprint-graphs/src/wasm-reader.test.ts
node scripts/test.ts --without-uasset --project component extensions/blueprint-graphs
```

These unit tests need no WASM dist. The repository's real-WASM tests are explicit script lanes,
not a Vitest built-dist fixture pattern, so real browser fixture coverage belongs to `pnpm site:check`.

The shared [Sequencer extension](../sequencer/README.md) provides saved Level Sequence timelines
on the site at `/sequencer` and in Workbench. All three file openers use the shared
`@ue-shed/ui` `FileDropZone`; their accessible file-picker labels remain host-specific.
The site inspector offers "Open in Sequencer viewer" only for adapted ready evidence with at
least one track or binding. A single worker request inspects the file and extracts Blueprint
evidence, then extracts sequence evidence only when inspection reports a Level Sequence class.
Both related viewers consume tab-local, one-shot decoded reads; Back restores inspection.
