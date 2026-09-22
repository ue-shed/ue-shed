# @ue-shed/world

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
