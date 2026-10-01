# Sequencer extension

Private, browser-safe, read-only SolidJS viewer for saved Level Sequences. The host owns asset
acquisition, transport, project selection, theme, and the `@ue-shed/ui` `EffectRuntimeProvider`.
The extension imports no Workbench, Electron, Node, global preload bridge, or WASM package.

The root exports `SequenceViewer`, `ProjectSequenceSearch`, `FileSequenceOpener`, their props,
controls and read types, `MAX_SEQUENCE_FILE_BYTES` (64 MiB), and `sequenceStats`.
`./contract` exports the Effect Schemas and inferred types for `SequenceReadResult`,
`SequenceReadFailure`, `SequenceFailureReason`, `SequenceAssetPath`, `SequenceAssetCandidate`,
`SequenceAssetSearchRequest`, `SequenceAssetSearchResult`, and `SEQUENCE_ASSET_SEARCH_LIMIT`.

`SequenceViewer` accepts:

- Required `opener(controls)`, created once and placed beside the sequence title. Controls expose
  `open(Effect<SequenceReadResult, unknown>)`, reactive `loading` / `hasSequence` getters, and
  `observeSourceBusy(accessor)`. Register source activity during opener setup. Call `open` only from
  event handlers or effect callbacks.
- Optional mount-time `initialRead`, captured during setup before `onSettled`.
- Optional `footer(read, controls)` for host review tools. Controls expose `open` and `reveal(path)`,
  which selects a saved section or the first section of a referenced track.
- Optional `failureActions(failure)` inside the failure callout.
- Optional `transportFailureCopy` with `title`, `message`, and `recovery`.

Reads use the shared owner-scoped Effect action adapter. Replacement and teardown interrupt pending
work; cancellation retains the current sequence. Expected package failures remain decoded values;
transport failures use host-provided copy.

The compact summary shows coverage, counts, display rate and playback frames. The timeline groups
Root and binding tracks in disclosures, shades playback, positions sections and key markers by saved
tick frames, labels its ruler in display frames, and supports zoom and horizontal scrolling.
Labels and lanes share one grid per row, with a sticky 164px label cell (120px on mobile).
Fit fills the available panel; the inspector column appears after section selection. Track and
section type labels are shortened visually while saved names, classes and bounds remain in
accessible text or tooltips. Trackless bindings are compact rows. Channel property grids and
frame/value tables retain the original saved evidence text.
It caps rendering at 200 tracks,
200 sections per track and 2,000 markers. The inspector stacks beneath it below 900px.
Channels retain saved defaults, keys, interpolation/tangents, camera binding scope and section
settings; playback and blending are not evaluated.

`ProjectSequenceSearch` receives `searchSequences(request): Effect<SequenceAssetSearchResult, unknown>`,
`readSequence(path)`, controls and optional `noProjectHint`. It mirrors Blueprint indexed search,
including debounce, keyboard navigation and compact title-adjacent results. Workbench adapts its
existing `saved-review:inventory` candidate index; the extension knows no project filesystem.

`FileSequenceOpener` receives controls, `readFile(file)`, and optional `{ label, load() }` sample.
It uses `@ue-shed/ui`'s shared `FileDropZone`, also used by the Blueprint and inspector openers.
File size and extension checks precede the host reader; drops inside the containing viewer work
after a sequence is loaded. Listeners are released on unmount.

## WASM boundary

`./wasm` exports `adaptWasmSequenceResult(path, output)`, `readWasmSequence(runtime, path, bytes)`,
`WasmSequenceRuntime`, and the pure `sequenceStats`. The structural runtime requires only
`extractLevelSequences`; it imports no WASM implementation.

The Rust and WASM TypeScript declarations emit an envelope with schema version 1,
`complete` / `partial`, `sequences`, and projection diagnostics. That envelope differs from
`LevelSequenceRead`. Its nested schema version 6 record matches the protocol
`LevelSequenceProjection`, which is reused for validation. Zero sequences maps to native
`unsupported`; more than one sequence is invalid one-package evidence. The adapted ready result
reuses `LevelSequenceRead.fields` in the shared contract.

| WASM kind / output                                              | Read reason / outcome            |
| --------------------------------------------------------------- | -------------------------------- |
| `malformed_data`                                                | `malformed_package`              |
| `unsupported_version`                                           | `unsupported_version`            |
| `unsupported_format`, `unsupported_capability`, empty sequences | `unsupported_asset`              |
| `resource_limit`, `internal`, invalid schema, thrown runtime    | `reader_failure`                 |
| `complete`, `partial`                                           | Ready with `complete`, `partial` |

Native also maps `executable_missing` to `missing_reader`. Browser recovery never references
environment variables or native-reader configuration. The five parser diagnostic codes become
`asset_<code>` with warning severity; all other codes pass through, matching native
`scan_failure_code` and `protocol_adapter::emit_diagnostic`.

Workbench composes search and `SavedReviewPanel` at `#/sequences`. The public site composes the
same viewer at `/sequencer` with a local file opener and the existing module worker. Inspection
extracts sequences only for reported Level Sequence classes, offering ready evidence with at least
one track or binding through a one-shot `initialRead` handoff. Back retains the prior inspection.

## Verification

```powershell
pnpm --filter @ue-shed/extension-sequencer typecheck
node scripts/test.ts --without-uasset --project node extensions/sequencer apps/site/src/blueprints
node scripts/test.ts --without-uasset --project component extensions/sequencer apps/workbench/src/renderer/sequencer-route.component.test.tsx
```

Renderer/site builds prove StyleX extraction. The Workbench `saved-sequence.e2e.ts` and site
`site.e2e.ts` cover indexed native and browser fixture journeys, including mobile overflow.
The extension exports TypeScript source and needs no separate build.
