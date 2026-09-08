# @ue-shed/uasset

## 0.7.0

### Minor Changes

- Align this unchanged package with the synchronized UE Shed `0.7.0` release. There is no direct behavioral change.

## 0.6.0

### Minor Changes

- ff117a0: Add generation-bound Project Index counts through
  `countProjectIndex({ projectId, expectedGeneration, filters })`. Supply 1–16 `ProjectIndexFilter`
  values for maps, exact classes, class prefixes, class-name suffixes, or serialized names. Each
  value-based filter requires 1–64 non-empty values; empty filter lists are rejected. Overlapping
  matches count each package once. The production binary Catalog reads checked snapshot postings
  without transferring candidate headers, and the public helper validates result identity and generation.
- Inspect saved Blueprint graphs without launching Unreal through `readSavedBlueprint`, native IO,
  and the WASM inspection API. Return graph/node identities, saved positions, typed pins and defaults,
  canonical links, tagged node properties, and explicit coverage diagnostics. Inspection is read-only
  and limited to supported uncooked saved revisions; it does not compile or execute Blueprints.

    Improve Project Index discovery, header batching, refresh, and query transport. Bound native
    protocol-worker shutdown and preserve typed reader failures for recovery.

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

### Minor Changes

- bf27d37: Advance `uasset saved-world` output to the version 2 wire contract with finite effective
  location, quaternion rotation, scale, direct root-component attachment evidence, and explicit
  transform-resolution failures.

## 0.2.0

### Patch Changes

- 51c0e1b: Align the unchanged public packages with the synchronized UE Shed `0.2.0` suite release.

## 0.1.0

### Patch Changes

- 9c2cdce: Publish the stable 0.1 package set, including the headless Game Text and World Log Map History
  integration packages.
