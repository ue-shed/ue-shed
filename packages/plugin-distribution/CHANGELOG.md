# @ue-shed/plugin-distribution

## 0.8.0

### Patch Changes

- 1a60713: Add scoped camera arrangement editing, reviewed layouts and recipe import/export, a replaceable native
  Unreal menu, and atomic batch View approval. Persist effective actor hide/protect lists and produce
  Pure, Authored, or paired Review output through the shared renderer. Apply the same visibility policy
  to map-tile capture and live previews. Initial exclusions support loaded opaque non-Nanite static meshes;
  unsupported geometry and unresolved references fail explicitly. Capture requires no authoring UI.
- 23d243a: Add actor-scoped camera arrangement drafts, revision-aware durable commands and approval recovery,
  stable camera ownership in Review Set 1.4, and a replaceable Unreal RC authoring bridge. Provide
  independently optional native camera authoring bridge and reference menu plugins; saved cameras still
  capture with Core+Cameras only.
- b0d2955: Add opt-in editor background ticking for connected live camera streams without changing editor preferences. Release the override on pause, clear, loss of world authority, disconnect, or stalled delivery. Correct round-robin iteration and prioritize the focused camera. Hosts must publish/install matching protocol, cameras, and native plugin versions.
- Updated dependencies [aa83787]
- Updated dependencies [8c0d895]
- Updated dependencies [33d9c5f]
- Updated dependencies [aa83787]
- Updated dependencies [2104cb1]
- Updated dependencies [12b93d1]
    - @ue-shed/engine@0.8.0

## 0.7.1

### Patch Changes

- Support native Unreal 5.8 plugin builds alongside 5.7 by adapting JSON field access and widening portable source compatibility.
- @ue-shed/engine@0.7.1

## 0.7.0

### Patch Changes

- @ue-shed/engine@0.7.0

## 0.6.0

### Patch Changes

- Align this package with the synchronized UE Shed `0.6.0` suite release. There is no direct
  behavioral change.
- @ue-shed/engine@0.6.0

## 0.5.1

### Patch Changes

- 8085e3e: Persist durable Unreal actor GUIDs in Review Views and capture requests, resolve subjects by GUID in
  the Cameras plugin, and initialize revision sessions from the saved camera pose.

    Bind compiled plugin variants to their npm packages and wire contracts, and verify per-module and
    per-native-file provenance during cold-cache installation.

- @ue-shed/engine@0.5.1

## 0.5.0

### Minor Changes

- fba6229: Add exact compiled Unreal Editor plugin variants, immutable variant-aware caching and leases,
  compatibility selection, and a separately invoked supervised bundle builder.

### Patch Changes

- @ue-shed/engine@0.5.0

## 0.4.0

### Minor Changes

- Add the public headless service for installing, verifying, resolving, leasing, and pruning
  immutable UE Shed Unreal plugin distributions.
