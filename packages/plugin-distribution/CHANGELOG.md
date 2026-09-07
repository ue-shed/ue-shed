# @ue-shed/plugin-distribution

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
