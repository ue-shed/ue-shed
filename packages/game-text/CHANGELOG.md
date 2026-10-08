# @ue-shed/game-text

## 0.10.0

### Minor Changes

- 8d812df: Add pure Unreal localization quality checks, provenance-bearing version-1 change-set proposals,
  and `ue-shed loc check` with optional exclusive proposal JSON creation.
- 980ad73: Add compatible v2 culture budgets and glossaries, archive progress reports, and versioned manifest
  source baselines. Expose `loc report` with exclusive baseline creation and preserve v1 source rules.
- bbe2501: Join saved text with read-only Unreal localization evidence by namespace and key. Add coverage-qualified
  per-culture states, bounded localization query pages, translation search, state and word counts, and
  file evidence reports. Preserve String Table translator comments alongside developer notes.
- 64976b1: Track localization review state in a project-owned review file per target. Records keep reviewed,
  proofread, approved and machine translated flags against a fingerprint of the source and the
  translation that ships next, so later edits read as changed since review. Game Text adds review
  lenses, accepted check findings and reviewed and proofread report shares.
- 271dcd1: Write reviewed translation change sets into PO files. Changes are revalidated against fresh
  evidence: the source must match the manifest, and the replaced translation must match what ships
  next. Only the edited `msgstr` values change, through an atomic, hash-guarded replace. Game Text
  adds browser-safe edit request and result schemas for hosts that stage edits.

### Patch Changes

- Updated dependencies [8d812df]
- Updated dependencies [f66ac19]
- Updated dependencies [bdbcaec]
- Updated dependencies [64976b1]
- Updated dependencies [271dcd1]
    - @ue-shed/localization@0.10.0
    - @ue-shed/unreal-assets@0.10.0

## 0.9.3

No direct behavioral change. Align with the UE Shed 0.9.3 suite and exact internal dependency pins.

### Patch Changes

- @ue-shed/unreal-assets@0.9.3

## 0.9.2

### Patch Changes

- @ue-shed/unreal-assets@0.9.2

## 0.9.1

### Patch Changes

- @ue-shed/unreal-assets@0.9.1

## 0.9.0

### Minor Changes

- 3d4c6b1: Keep saved FText translator notes. Keyed text and StringTable entries saved by UE 5.8 expose
  `dev_notes` in `readSavedAsset` inspection output and compact text extraction, and Game Text
  exposes them on each `TextOccurrence.devNotes`, separate from the source string and localization
  identity. Older packages and empty notes produce `""`. `readSavedTable` text cells are unchanged.

### Patch Changes

- Updated dependencies [b8c7623]
- Updated dependencies [679d972]
- Updated dependencies [e5c5811]
- Updated dependencies [3d4c6b1]
    - @ue-shed/unreal-assets@0.9.0

## 0.8.0

### Patch Changes

- 64ca9bf: Inspect rich curve keys, Skeleton reference poses and bone indices, Sequencer float/double channels,
  bounded InstancedStruct values, and package/object metadata in UE 5.7 saved packages. Share the
  source-derived native layouts across native and WASM readers and preserve unsupported inner payloads.
- 64ca9bf: Use source-derived Unreal class and serialization models for supported saved assets. Share bounded
  native layout decoding between StringTables and enums, expose StringTable metadata in native and
  WASM inspection, and preserve saved string-table text identities.
- Updated dependencies [64ca9bf]
- Updated dependencies [64ca9bf]
- Updated dependencies [64ca9bf]
    - @ue-shed/unreal-assets@0.8.0

## 0.7.1

Align this package with the synchronized UE Shed 0.7.1 suite and exact internal dependency pins. There is no direct behavioral change.

### Patch Changes

- @ue-shed/unreal-assets@0.7.1

## 0.7.0

### Patch Changes

- @ue-shed/unreal-assets@0.7.0

## 0.6.0

### Minor Changes

- ff117a0: Add versioned Game Text investigation presets and complete filtered JSON/CSV exports, retaining
  text identities, all occurrences, quality rules, coverage, and project provenance. Query models
  can export full matching results independently of paginated UI results.

    Expose browser-safe investigation metadata and CSV helpers, plus a separate Node file adapter
    with bounded preset reads and atomic output writes. Workbench and the CLI use these APIs for
    saved investigations and replay against an explicitly selected project.

### Patch Changes

- Updated dependencies [ff117a0]
- Updated dependencies [efb6898]
- Updated dependencies
- Updated dependencies [ff117a0]
    - @ue-shed/unreal-assets@0.6.0

## 0.5.1

### Patch Changes

- Align this package with the synchronized UE Shed `0.5.1` patch release. There is no direct
  behavioral change.

- @ue-shed/unreal-assets@0.5.1

## 0.5.0

### Patch Changes

- @ue-shed/unreal-assets@0.5.0

## 0.4.0

### Patch Changes

- @ue-shed/unreal-assets@0.4.0

## 0.3.0

### Patch Changes

- Updated dependencies [bf27d37]
    - @ue-shed/unreal-assets@0.3.0

## 0.2.0

### Patch Changes

- 51c0e1b: Align the unchanged public packages with the synchronized UE Shed `0.2.0` suite release.
- Updated dependencies [51c0e1b]
    - @ue-shed/unreal-assets@0.2.0

## 0.1.0

### Patch Changes

- 9c2cdce: Publish the stable 0.1 package set, including the headless Game Text and World Log Map History
  integration packages.
- Updated dependencies [9c2cdce]
    - @ue-shed/unreal-assets@0.1.0
