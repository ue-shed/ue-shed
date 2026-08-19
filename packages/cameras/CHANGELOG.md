# @ue-shed/cameras

## 0.3.0

### Minor Changes

- a087286: Add caller-owned Review Capture and Map Capture destination adapters while retaining project-local
  Capture Runs as the default. Prepared attempts now own containment, exclusive creation, artifact
  ingestion, atomic publication, retained partial Map Capture attempts, and cancellation cleanup.

### Patch Changes

- Updated dependencies [bf27d37]
    - @ue-shed/protocol@0.3.0
    - @ue-shed/unreal-connection@0.3.0
    - @ue-shed/observability@0.3.0

## 0.2.0

### Minor Changes

- 51c0e1b: Publish engine discovery, project launch, editor readiness, PIE, and editor-world control as the
  headless `@ue-shed/engine` library. Publish Config Explorer and Project Custodian with browser-safe
  contracts and Node service layers. Add portable Map Capture plans, editor-world previews,
  orthographic tile-pyramid capture, safe map control, and more precise JSON and provisioning
  contracts.

### Patch Changes

- Updated dependencies [51c0e1b]
- Updated dependencies [51c0e1b]
    - @ue-shed/protocol@0.2.0
    - @ue-shed/unreal-connection@0.2.0
    - @ue-shed/observability@0.2.0

## 0.1.0

### Patch Changes

- 9c2cdce: Publish the stable 0.1 package set, including the headless Game Text and World Log Map History
  integration packages.
- Updated dependencies [9c2cdce]
    - @ue-shed/observability@0.1.0
    - @ue-shed/protocol@0.1.0
    - @ue-shed/unreal-connection@0.1.0
