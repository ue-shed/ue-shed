# @ue-shed/uasset-inspection-wasm

## Unreleased

### Minor Changes

- Add a parse-once package handle: `runtime.openPackage(path, bytes)` returns a handle whose
  `inspect`, `extractText`, `extractTextures`, `extractAuthoringTable`, `extractLevelSequences`,
  `extractBlueprints`, and `extractAnimations` methods reuse one parse and one lazy export decode,
  returning the same results as the matching per-call runtime methods. Call `free()` (idempotent) to
  release the handle.

## 0.24.0

No direct behavioral change: released to keep the suite aligned.

## 0.23.0

## 0.22.0

## 0.21.0

### Minor Changes

- 1d22faa: Saved-asset limits and pure helpers are public, so hosts no longer copy them.
    - `@ue-shed/unreal-assets` exports `DEFAULT_TIMEOUT_MS`, `DEFAULT_CATALOG_TIMEOUT_MS` and
      `SAVED_REVIEW_MAX_CHANGES`. `./investigation-files` exports `INVESTIGATION_PRESET_MAX_BYTES` and
      `INVESTIGATION_EXPORT_MAX_BYTES`.
    - `searchBlueprint` accepts `maximumHits`; the default stays `MAX_BLUEPRINT_SEARCH_HITS`.
    - `@ue-shed/map-history/diff` is a browser-safe entry for `diffSavedWorldSnapshots`,
      `actorIdentityOf`, `actorIdentityKey` and `savedWorldTransformsEqual`.
    - `@ue-shed/project-custodian` exports `resolvePolicyDocument`, `PolicyResolution` and
      `ProjectTargetDefinition`, so a host can validate a policy before writing it.
    - `@ue-shed/uasset-inspection-wasm` declares the `DEFAULT_LIMITS` it already exported at runtime.

### Patch Changes

- ca41635: Read large saved Blueprints and Niagara packages faster with identical output. A Blueprint's
  graph membership is decoded once per owning export instead of once per graph and node (a 32 MB
  Blueprint went from 4.6 s to 0.35 s), fixed-size numeric array elements no longer allocate an
  error breadcrumb each, and text projection skips numeric leaves.
- 19c9412: Decode more saved Blueprint, Sequencer and Niagara data. On UE 4.27: editable node pin suffixes,
  soft object path structs, Blueprint class records, property GUID maps, numeric channels, Level
  Sequence binding maps, data table row handles saved without default fields, and Niagara variable
  records. On UE5: graph pins from saved revisions 1000 to 1018 (so `readSavedBlueprint` accepts
  them too), Blueprint class records, DynamicCast nodes, splines, Niagara variable records, field
  paths and newer numeric channel framing.
  Keep every coverage gap while distinguishing text-free data from data that may hide text.
  uasset-io 1.18 adds `textGapCounts` to package text records and `may_contain_text` to gaps;
  older negotiated clients omit these fields. Native and WASM text status use the same evidence.
  Game Text package text shards move to `package-text-v9`, so existing indexes re-extract packages
  once.

## 0.20.0

### Patch Changes

- No direct behavioral changes; version advanced for suite alignment.

## 0.19.0

### Patch Changes

- No direct behavioral changes; version advanced for suite alignment.

## 0.18.0

### Patch Changes

- 81fa128: Read saved Blueprint graph pin text on UE 4.27 and UE 5.6–5.8, retaining Unreal identities and
  addressable pin locations. Report skipped or rejected graph pin streams as partial coverage even
  when the package gather table omits their text. Match native subobject paths during saved repair
  verification. Re-extract cached package text on the next refresh so existing scans gain pin text.
  Join compiled Blueprint literals to matching saved pin identities within each package, preserving
  both occurrences and keeping different sources or unread pins separate.

## 0.17.1

## 0.17.0

## 0.16.2

## 0.16.1

No direct behavioral changes; version advanced for suite alignment.

## 0.16.0

## 0.15.0

## 0.14.0

### Minor Changes

- 8f9bcf1: Saved text coverage now follows the package's own gatherable text table, the list Unreal's asset
  gather reads. A package is partial only when a runtime entry from that table was not decoded;
  undecodable properties that hold no gatherable text (native Niagara structs, for example) remain
  reported as coverage gaps without making the package partial. The table is used only where Unreal's
  gather would use it; Blueprints with bytecode, which are saved without one, keep the previous
  decoder-gap rule. uasset-io v1.10 adds `gatherCoverage` to package text records, Game Text adds
  `coverage.missingGatherableText` and `gatherable_text_not_decoded` diagnostics with the unread
  source text and Unreal site, and user-defined enum display names are now read as text. Entries
  match on namespace, key and source text, so an unread source variant under a decoded key stays
  missing, and authored bracketed namespaces are compared as Unreal saved them. UE 5.8 user-defined
  enums, which save an extra underlying-type byte, now decode instead of failing.

## 0.13.0

## 0.12.0

## 0.11.0

## 0.10.0

### Minor Changes

- 8e83f1a: Read saved Game Text from Unreal 4.27 through 5.3 packages that use legacy property tags. The native
  reader and WASM inspection decode legacy tags, containers and text histories alongside the 5.4+
  layout. Text coverage gaps add `legacy_container_element_without_type_information`,
  `feature_unavailable_for_engine_version` and `property_decoder_rejected` reasons beside
  `unsupported_text_history`; consumers that switch exhaustively on the reason should handle them.

## 0.9.3

No direct behavioral change. Align with the UE Shed 0.9.3 suite and exact internal dependency pins.

## 0.9.2

## 0.9.1

## 0.9.0

### Minor Changes

- b8c7623: Add saved Blueprint and Sequencer review through the public reader, CLI, and Workbench:
  typed Level Sequence reads, reference inventory and resolution, and bounded comparisons with
  explicit incomplete evidence. Validate richer Blueprint graphs and regenerated sequences on
  Unreal 5.7 and 5.8. Include native property-bag decoding and saved animation summaries.
- 679d972: Decode boolean container bytes correctly and expose saved bool, integer, byte/enum, and visibility
  channels through Level Sequence schema 5. Preserve omitted defaults, channel flags and enum references;
  extend native/WASM, comparison, and Unreal 5.7/5.8 conformance.
- 8de1090: Export bounded DataTable authoring snapshots from the portable inspection projection through
  `extractAuthoringTable`. Keep native authoring JSON unchanged and compare every authoring fixture
  between the native protocol and WASM. Add the read-only website Data Tables viewer and inspector
  handoff using the shared grid and Patterns components.
- e5c5811: Expose shared Sequencer settings, scoped camera cuts, binding metadata and saved string/object
  channels through schema 6. Add Blueprint variable declarations, saved CDO overrides and component
  hierarchies/templates through schema 2. Publish bounded contracts and update native/WASM readers,
  reference navigation, comparisons and viewers with independent UE 5.7/5.8 fixture conformance.

    Decode source-checked inherited actor/component native records, including saved construction-script
    member references and conditional scene flags. Expose native evidence separately from tagged
    properties and include it in Blueprint comparisons/navigation and Sequencer reference coverage.

- 3d4c6b1: Decode saved GameplayTagContainer and common math properties through the shared native layouts,
  and expose saved scalar float/double and 3D transform channels through Level Sequence schema 4.
  Each `numeric_channels` entry keeps section-local frame keys, values, interpolation and tangent
  modes, weighted tangents, nullable defaults, extrapolation, tick resolution and ShowCurve; indexed
  paths such as `Translation[0]` preserve axis identity. Missing channels and unsupported sections
  remain explicit coverage gaps. Consumers upgrading from schema 3 must accept the new track kinds
  and required channel arrays.
- 3d4c6b1: Keep saved FText translator notes. Keyed text and StringTable entries saved by UE 5.8 expose
  `dev_notes` in `readSavedAsset` inspection output and compact text extraction, and Game Text
  exposes them on each `TextOccurrence.devNotes`, separate from the source string and localization
  identity. Older packages and empty notes produce `""`. `readSavedTable` text cells are unchanged.

## Unreleased

- Add `extractAuthoringTable` to Rust/WASM, initialized runtimes, and browser/Node convenience
  exports. Schema-1 envelopes carry the unchanged native authoring contract 2.1 snapshot and typed
  failures under the existing 64 MiB limits. Publish `authoring-table.v1.schema.json` and compare
  all authoring fixtures against native protocol output. The website uses the projection in its
  read-only Data Tables page.

## 0.8.0

### Minor Changes

- 64ca9bf: Inspect rich curve keys, Skeleton reference poses and bone indices, Sequencer float/double channels,
  bounded InstancedStruct values, and package/object metadata in UE 5.7 saved packages. Share the
  source-derived native layouts across native and WASM readers and preserve unsupported inner payloads.
- 64ca9bf: Use source-derived Unreal class and serialization models for supported saved assets. Share bounded
  native layout decoding between StringTables and enums, expose StringTable metadata in native and
  WASM inspection, and preserve saved string-table text identities.

### Patch Changes

- 64ca9bf: Reduce native parser allocation costs by borrowing struct names, formatting diagnostic paths only
  on failure, and reading sized arrays without cloning generated layouts. Reduce owned inspection
  memory for assets without Skeleton poses while preserving inspection JSON and analyzer behavior.

## 0.7.1

Align this package with the synchronized UE Shed 0.7.1 suite and exact internal dependency pins. There is no direct behavioral change.

## 0.7.0

### Minor Changes

- Align this unchanged package with the synchronized UE Shed `0.7.0` release. There is no direct behavioral change.

## 0.6.0

### Minor Changes

- Inspect saved Blueprint graphs without launching Unreal through `readSavedBlueprint`, native IO,
  and the WASM inspection API. Return graph/node identities, saved positions, typed pins and defaults,
  canonical links, tagged node properties, and explicit coverage diagnostics. Inspection is read-only
  and limited to supported uncooked saved revisions; it does not compile or execute Blueprints.

## 0.5.1

### Patch Changes

- Align this unchanged package with the synchronized UE Shed `0.5.1` patch release. There is no
  direct behavioral change.

## 0.5.0

### Patch Changes

- Align this unchanged package with the synchronized UE Shed `0.5.0` suite release. There is no
  direct behavioral change.

## 0.4.0

### Patch Changes

- Align this unchanged package with the synchronized UE Shed `0.4.0` suite release. There is no
  direct behavioral change.

## 0.3.0

## 0.2.0

### Patch Changes

- 51c0e1b: Align the unchanged public packages with the synchronized UE Shed `0.2.0` suite release.

## 0.1.0

### Patch Changes

- 9c2cdce: Publish the stable 0.1 package set, including the headless Game Text and World Log Map History
  integration packages.
