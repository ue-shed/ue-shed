# @ue-shed/unreal-connection

## 0.7.0

### Patch Changes

- Updated dependencies [1c03e0f]
    - @ue-shed/protocol@0.7.0

## 0.6.0

### Minor Changes

- 2760900: Add capture selection bounds and Lit capture readiness inspection, optional producer identity and plugin versions, actor catalog metadata, and structured Map Capture and Niagara progress. Expose library APIs and CLI workflows while retaining compatibility with producers that omit optional metadata and progress. Updated inspection operations require the advertised Core and Cameras capabilities.
- ff117a0: Add a headless selected Unreal target service with operation-scoped endpoint capture. Changing
  selection affects subsequent operations while active operations and their children retain their
  starting target. Review capture adapters can resolve an endpoint from an Effect at execution time.

    Expose browser-safe camera and world-observation contracts and pure helpers, plus an observability
    metrics entry point that does not load telemetry exporters. Existing root exports remain available.

### Patch Changes

- Updated dependencies [9bd7735]
- Updated dependencies [ff117a0]
- Updated dependencies [2f1137a]
- Updated dependencies [2760900]
- Updated dependencies
    - @ue-shed/protocol@0.6.0

## 0.5.1

### Patch Changes

- Align this package with the synchronized UE Shed `0.5.1` patch release. There is no direct
  behavioral change.

- @ue-shed/protocol@0.5.1

## 0.5.0

### Patch Changes

- @ue-shed/protocol@0.5.0

## 0.4.0

### Patch Changes

- @ue-shed/protocol@0.4.0

## 0.3.0

### Patch Changes

- Updated dependencies [bf27d37]
    - @ue-shed/protocol@0.3.0

## 0.2.0

### Minor Changes

- 51c0e1b: Publish engine discovery, project launch, editor readiness, PIE, and editor-world control as the
  headless `@ue-shed/engine` library. Publish Config Explorer and Project Custodian with browser-safe
  contracts and Node service layers. Add portable Map Capture plans, editor-world previews,
  orthographic tile-pyramid capture, safe map control, and more precise JSON and provisioning
  contracts.

### Patch Changes

- Updated dependencies [51c0e1b]
    - @ue-shed/protocol@0.2.0

## 0.1.0

### Patch Changes

- 9c2cdce: Publish the stable 0.1 package set, including the headless Game Text and World Log Map History
  integration packages.
- Updated dependencies [9c2cdce]
    - @ue-shed/protocol@0.1.0
