# @ue-shed/world

## 0.21.0

### Minor Changes

- 5aa35e7: Capture, world preparation and observation can be composed and tested by hosts. Defaults are
  unchanged.
    - `@ue-shed/cameras` exports `MAP_TILE_CAPTURE_MAX_TILES_PER_REQUEST` (also from `./browser` and
      `./map-tiles`) and `makeMapCaptureTestLayer`.
    - `worldPreparationLayer(endpoint, { requestTimeout })` and `makeWorldPreparation` take a request
      timeout (default 30 seconds) for large World Partition maps. `withPreparedWorld` passes a lease ID
      and duration. `WorldVector`, `WorldExtent`, `WorldLayerRequirement` and `WorldContract` types are
      exported.
    - `observatoryLayer` requires `EditorWindowActivation`, so a host can supply its own focus handling.
      `ObservatoryLive` composes it with the engine's activation as before. `makeObservatoryTestLayer`
      provides a complete Observatory for tests.
    - `@ue-shed/niagara` exports `NIAGARA_PREVIEW_MAXIMUM_TOTAL_PIXELS`, and `./browser` now includes
      the pure presentation helpers.

### Patch Changes

- Updated dependencies [9d91e8e]
- Updated dependencies [19c9412]
- Updated dependencies [05f4e1a]
    - @ue-shed/unreal-connection@0.21.0
    - @ue-shed/protocol@0.21.0

## 0.20.0

### Patch Changes

- Updated dependencies [09972f9]
- Updated dependencies [f7e366f]
- Updated dependencies [bc3e398]
- Updated dependencies [68737a3]
    - @ue-shed/protocol@0.20.0
    - @ue-shed/unreal-connection@0.20.0

## 0.19.0

### Patch Changes

- @ue-shed/protocol@0.19.0
    - @ue-shed/unreal-connection@0.19.0

## 0.18.0

### Patch Changes

- Updated dependencies [b267701]
- Updated dependencies [fc109a5]
    - @ue-shed/protocol@0.18.0
    - @ue-shed/unreal-connection@0.18.0

## 0.17.1

### Patch Changes

- @ue-shed/protocol@0.17.1
    - @ue-shed/unreal-connection@0.17.1

## 0.17.0

### Minor Changes

- ba669e3: **Breaking:** the remaining packages' tagged errors gain the shared guidance shape from the first D4 slice: `message`, `recovery`, `retrySafe` and a typed `nextStep` (`"fix_input" | "retry" | "reconcile" | "escalate"`) beside their existing context fields. `nextStep: "retry"` appears only when `retrySafe` is true.

    Migration: read `nextStep` instead of parsing `message`. Code that constructs these errors itself (test doubles, custom layers) must pass `recovery`, `retrySafe` and `nextStep` where they are new.
    - Indeterminate session Apply failures require `reconcileSession` even when a lower-level port can safely replay a request. Pre-dispatch connection failures, Apply-result lookup and repeat-safe pending Save recovery retain their own guidance.
    - Compiled plugin builds require confirmed owned-process cleanup before advertising a safe repeat. Failed cleanup reports reconciliation and retains the termination failure; pure validation failures remain repeat-safe.
    - World preparation lease identity conflicts require reconciliation instead of retrying unchanged acquisition requirements.
    - Editor readiness preserves the prior slice's recovery actions and retry policy. Newly merged domain-parser errors also adopt the guidance fields.

### Patch Changes

- Updated dependencies [2bae469]
- Updated dependencies [bb9d55e]
- Updated dependencies [f403f84]
- Updated dependencies [ba669e3]
- Updated dependencies [a8adf03]
- Updated dependencies [d585b1a]
- Updated dependencies [9ce62ee]
- Updated dependencies [0e2a894]
- Updated dependencies [a33fffb]
- Updated dependencies [13ed5b7]
- Updated dependencies [9370ea6]
- Updated dependencies [70dec0a]
- Updated dependencies [2f9469b]
- Updated dependencies [2747ae8]
    - @ue-shed/protocol@0.17.0
    - @ue-shed/unreal-connection@0.17.0

## 0.16.2

### Patch Changes

- @ue-shed/protocol@0.16.2
    - @ue-shed/unreal-connection@0.16.2

## 0.16.1

### Patch Changes

- @ue-shed/protocol@0.16.1
    - @ue-shed/unreal-connection@0.16.1

## 0.16.0

### Patch Changes

- Updated dependencies [dbb471e]
- Updated dependencies [7d925d7]
    - @ue-shed/protocol@0.16.0
    - @ue-shed/unreal-connection@0.16.0

## 0.15.0

### Patch Changes

- @ue-shed/protocol@0.15.0
    - @ue-shed/unreal-connection@0.15.0

## 0.14.0

### Patch Changes

- d8eca33: Upgrade Effect and its integrations to stable 4.0.4. Update renamed schema and configuration APIs,
  JSON Schema validation, synchronous cache queries, retained resource cleanup, and Remote Control
  response handling while preserving authoritative wire contracts and existing workflow behavior.
  Published libraries now require the application to provide `effect@^4.0.0` as a peer dependency,
  and `@ue-shed/observability` also requires `@effect/opentelemetry@^4.0.0`. Install these in the
  application (or reuse compatible existing versions) so UE Shed shares the application's Effect
  runtime. Workspace development and tests remain pinned to Effect 4.0.4 through the catalog.
- Updated dependencies [8f9bcf1]
- Updated dependencies [d8eca33]
    - @ue-shed/protocol@0.14.0
    - @ue-shed/unreal-connection@0.14.0

## 0.13.0

### Patch Changes

- @ue-shed/protocol@0.13.0
    - @ue-shed/unreal-connection@0.13.0

## 0.12.0

### Patch Changes

- Updated dependencies [d90ae25]
    - @ue-shed/protocol@0.12.0
    - @ue-shed/unreal-connection@0.12.0

## 0.11.0

### Patch Changes

- Updated dependencies [1f01e74]
- Updated dependencies [a545cd5]
- Updated dependencies [580442c]
- Updated dependencies [67a611c]
    - @ue-shed/protocol@0.11.0
    - @ue-shed/unreal-connection@0.11.0

## 0.10.0

No direct behavioral change. Align with the UE Shed 0.10.0 suite and exact internal dependency pins.

### Patch Changes

- Updated dependencies [8e83f1a]
- Updated dependencies [5fd5bc7]
    - @ue-shed/protocol@0.10.0
    - @ue-shed/unreal-connection@0.10.0

## 0.9.3

No direct behavioral change. Align with the UE Shed 0.9.3 suite and exact internal dependency pins.

### Patch Changes

- @ue-shed/protocol@0.9.3
    - @ue-shed/unreal-connection@0.9.3

## 0.9.2

### Patch Changes

- @ue-shed/protocol@0.9.2
    - @ue-shed/unreal-connection@0.9.2

## 0.9.1

### Patch Changes

- Updated dependencies [ce281fb]
- Updated dependencies [ce281fb]
    - @ue-shed/protocol@0.9.1
    - @ue-shed/unreal-connection@0.9.1

## 0.9.0

### Patch Changes

- Updated dependencies [a3b58fd]
- Updated dependencies [f69d878]
- Updated dependencies [b8c7623]
- Updated dependencies [679d972]
- Updated dependencies [e5c5811]
- Updated dependencies [3d4c6b1]
    - @ue-shed/protocol@0.9.0
    - @ue-shed/unreal-connection@0.9.0

## 0.8.0

### Minor Changes

- 2104cb1: Add scoped editor world preparation with unloaded actor planning, actor context regions, bounded renewable leases, Data Layer ownership and explicit readiness evidence. Share native preparation with camera rendering and expose headless prepared capture and CLI recovery operations.

    Start lease renewal windows after synchronous loading, reserve cleanup capacity separately from active ownership, and preserve caller defects and interruption when restoration fails. Expose single-poll readiness as `checkReady`.

    Restore camera viewport state during UE 5.8 map teardown when the engine has already cleared the pilot lock, while preserving normal ownership checks.

### Patch Changes

- Updated dependencies [1a60713]
- Updated dependencies [8c0d895]
- Updated dependencies [64ca9bf]
- Updated dependencies [33d9c5f]
- Updated dependencies [23d243a]
- Updated dependencies [2104cb1]
- Updated dependencies [b0d2955]
- Updated dependencies [64ca9bf]
- Updated dependencies [2104cb1]
    - @ue-shed/protocol@0.8.0
    - @ue-shed/unreal-connection@0.8.0
