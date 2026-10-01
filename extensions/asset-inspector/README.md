# Asset Inspector extension

Private, browser-safe SolidJS 2 + StyleX viewer for generic saved-package inspection. A host owns
file acquisition, runtime initialization, transport, theme, navigation, and the `@ue-shed/ui`
`EffectRuntimeProvider`. The extension imports no WASM implementation, Node, Electron, or app code.

The root exports `AssetInspector`, `FileAssetOpener`, `PropertyTree`, `InspectionValueView`,
`MAX_ASSET_FILE_BYTES` (64 MiB), their prop/control types, `AssetRelatedView`, and the contract and
adapter exports.
`/contract` exports `AssetInspection`, `InspectedAsset`, `AssetInspectionReadResult`,
`AssetInspectionFailureReason`, and their inferred types, including `ReadyAssetInspection`.
`/wasm` exports `adaptWasmInspectionResult(fileName, fileBytes, output)`,
`readWasmInspection(runtime, fileName, bytes)`, and the structural `WasmInspectionRuntime` interface.
These subpaths import no UI code.

`AssetInspector` takes `opener(controls)`, optional one-shot `initialRead`, and optional
`relatedViews(read)` descriptors. Each descriptor is an action (`kind`, `label`, `href`, optional
`description` and `onClick`) or a quiet note (`kind`, `message`), rendered in the summary toolbar.
Controls expose `open(Effect)`, `loading`, and `hasInspection`. Call
`open` from an event or effect callback. Replacement and teardown cancel pending reads through the
shared Effect action adapter. Typed parser failures and browser transport failures have separate
readable states. `FileAssetOpener` takes these controls, `readFile(file)`, and optional
`samples: [{ label, load() }]`; it validates extension and size before reading. Files are read-only.

## Schema boundary

Generic inspection is Rust's schema version 8, shared by native and WASM serializers in
`crates/uasset-inspection/src/generic.rs` and `generic/json.rs`. The adapter validates unknown output
with Effect Schema and composes protocol metadata, properties, decode errors, and asset variants.

The protocol `SavedAssetInspection` is the narrower contract used by the generated IO event JSON
schema. It requires numeric `legacy_ue3`, omits package table locations, and discards common fields
on some asset variants. Existing IO, catalog, text, audit, and input consumers use that shape.
Changing it would require coordinated IO contract regeneration and consumer verification. This
extension therefore owns the generic schema composition, without changing the protocol contract:

- `legacy_ue3` accepts a number or null, matching Rust's `Option<i32>` and WASM declarations.
- `names`, `imports`, and `exports` retain required count/offset records; optional
  `soft_object_paths` retains count, offset, and parsed count.
- Common properties, class paths, native data, and tail sizes survive across asset variants.
  Rust omits empty specialized arrays; those decode to empty arrays.
- WASM declaration fields are not proof of presence: Rust omits class paths on DataTables and
  omits empty bones, curve rows, enum entries, struct fields, and string-table entries.

Errors map `malformed_data` to `malformed_package`, `unsupported_format` to `unsupported_asset`,
`unsupported_version` and `unsupported_capability` directly, and resource limits, internal errors,
invalid evidence, and runtime exceptions to `reader_failure`, with browser recovery copy.

## Display and hosts

The inspector renders StringTables, enums, user-defined structs, DataTables/composite tables,
curves, skeleton parent hierarchies, tagged properties, native records, opaque reasons, package
metadata, and decode coverage. Search walks decoded names and values. Tables cap at 200 matching
rows, DataTables at 50 columns, and trees at 200 children per branch / 64 levels; limits are visible.
Nested values mount when expanded or searched. There are no JSON dumps.

The compact summary combines identity, coverage, statistics, file acquisition, and related actions.
Multi-export packages use a scrollable navigator beside one selected detail on desktop, and an
export select above the detail below 900px. The primary export comes first and is selected by
default; single-export packages hide the navigator. Search narrows both exports and detail evidence.
Property names and type tags occupy one column, values the other. DataTable types live in column
headers, tables size to their contents, and empty string-table notes are omitted. Package header
and metadata disclosures sit quietly together below the detail.

Related views remain host-owned. The website selects a Blueprint link only after the shared
Blueprint WASM adapter returns ready evidence containing at least one graph. Control Rig and
graphless Blueprints explain the missing view. A tab-local decoded handoff opens `/blueprints`
without picking the file again. The website offers three repository fixtures through Vite `?url`
imports and keeps all selected-file bytes local.
Non-Blueprints show no graph-view action or note. Samples appear as three small buttons.

Targeted verification after installing workspace links:

```powershell
pnpm --filter @ue-shed/extension-asset-inspector typecheck
node scripts/test.ts --without-uasset --project node extensions/asset-inspector apps/site/src
node scripts/test.ts --without-uasset --project component extensions/asset-inspector
pnpm run check:precommit
pnpm site:check
```

Adapter/component tests use canned evidence and need no built WASM. Site e2e uses real fixtures
on desktop and mobile. This extension changes presentation and schema composition, not Unreal
serialization or parser/codegen behavior.

The shared [Sequencer extension](../sequencer/README.md) provides saved Level Sequence timelines
on the site at `/sequencer` and in Workbench. All three file openers use the shared
`@ue-shed/ui` `FileDropZone`; their accessible file-picker labels remain host-specific.
The site inspector offers "Open in Sequencer viewer" only for adapted ready evidence with at
least one track or binding. A single worker request inspects the file and extracts Blueprint
evidence, then extracts sequence evidence only when inspection reports a Level Sequence class.
Both related viewers consume tab-local, one-shot decoded reads; Back restores inspection.
