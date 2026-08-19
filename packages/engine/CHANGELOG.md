# @ue-shed/engine

## 0.3.0

### Minor Changes

- 70ef061: Add an Effect-scoped supervised Unreal Editor session with validated launch inputs, capability-based
  readiness, typed exit outcomes, caller-owned POSIX process-group teardown, and a Windows x64 native
  supervisor that assigns the suspended editor to a private kill-on-close Job Object before resuming it.

### Patch Changes

- Updated dependencies [bf27d37]
    - @ue-shed/protocol@0.3.0
    - @ue-shed/unreal-connection@0.3.0

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
    - @ue-shed/unreal-connection@0.2.0
