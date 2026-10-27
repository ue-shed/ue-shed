# @ue-shed/niagara

## 0.23.0

### Minor Changes

- 430728c: Add the lightweight `@ue-shed/protocol/errors` subpath with the same error schemas as the root export. This entry point is additive. Reuse the shared guidance schemas across libraries and hosts; plugin distribution retains its independent fields with compile-time equality checks.

    Breaking: World preparation errors accept only the documented client and editor failure codes. Each code carries its own recovery guidance. Unknown producer codes fail contract decoding.

    Breaking: Niagara preview failures now require `nextStep` so hosts retain the next recovery action.

    Preserve Niagara session recovery, retry safety and next steps through preview error adaptation. Classify CLI plugin installation failures as input fixes, safe transient retries or escalation. Keep localization guidance host-neutral and add command hints in CLI output.

### Patch Changes

- d2a3165: Editor launches take per-run options, on both `UnrealProjectLauncher` and supervised sessions:
    - `startupMap` opens a map directly (`/Game/Maps/Arena`) instead of loading the default map first. A `/Game` map or a launched plugin's map that does not exist fails with `startup_map_missing` before spawning, because the editor would otherwise open the default map without a word.
    - `logPath` writes the run's editor log to an absolute path; the launch result, session handle and early-exit error name it.
    - `sourceControl: "disabled"` starts the editor without connecting to source control for that run.
    - `additionalArguments` passes other editor switches. Switches the launcher owns, or that would break the session or the user's project (plugins, Remote Control, `-NullRHI`, `-run=`, `-game`, crash-recovery switches and others), are refused with `invalid_request`; `reservedUnrealEditorArgument` gives the reason.
    - With plugins, `remoteControlAllowedFunctions` allows single engine or project functions on UE 5.8, and `remoteControlWebSocketPort` sets the WebSocket port, so a host no longer rewrites the launcher's arguments.
    - Supervised sessions add `unattended` (no dialogs; refused with `recovery_pending` while the project has unsaved work to recover, because the editor would delete it) and `window: "offscreen"` (UE 5 only).

    Live Coding is now really off in plugin sessions: `-NoLiveCoding` is a build-tool switch the editor ignores, so the launcher sets the Live Coding setting for the run instead. Niagara preview and other commandlets pass `-SCCProvider=None` in place of `-nop4`, which only AutomationTool reads.

- 1d9f850: The UEShedNiagara preview commandlet ends a render frame after every scene capture and session
  request. Host-owned sessions no longer grow by about 400 MiB per request, and they log process commit
  after each request. When auto-fit coverage already reaches the image edge, the capture now keeps the
  bounds-based camera and logs a warning instead of failing; edge activity still sets `needsReview`.
- Updated dependencies [d2a3165]
- Updated dependencies [33249ad]
- Updated dependencies [742a808]
- Updated dependencies [430728c]
    - @ue-shed/engine@0.23.0
    - @ue-shed/protocol@0.23.0

## 0.22.0

### Patch Changes

- Updated dependencies [1f38a2e]
- Updated dependencies [f682dbc]
- Updated dependencies [1d62dd0]
- Updated dependencies [150caea]
- Updated dependencies [05c1ba5]
- Updated dependencies [704c68b]
- Updated dependencies [5f6f15f]
    - @ue-shed/protocol@0.22.0
    - @ue-shed/engine@0.22.0

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
    - @ue-shed/engine@0.21.0
    - @ue-shed/protocol@0.21.0

## 0.20.0

### Patch Changes

- Updated dependencies [09972f9]
- Updated dependencies [f7e366f]
- Updated dependencies [68737a3]
    - @ue-shed/protocol@0.20.0
    - @ue-shed/engine@0.20.0

## 0.19.0

### Patch Changes

- Updated dependencies [9112cd0]
    - @ue-shed/engine@0.19.0
    - @ue-shed/protocol@0.19.0

## 0.18.0

### Patch Changes

- Updated dependencies [b267701]
- Updated dependencies [fc109a5]
    - @ue-shed/protocol@0.18.0
    - @ue-shed/engine@0.18.0

## 0.17.1

### Patch Changes

- @ue-shed/engine@0.17.1
    - @ue-shed/protocol@0.17.1

## 0.17.0

### Minor Changes

- ba669e3: **Breaking:** the remaining packages' tagged errors gain the shared guidance shape from the first D4 slice: `message`, `recovery`, `retrySafe` and a typed `nextStep` (`"fix_input" | "retry" | "reconcile" | "escalate"`) beside their existing context fields. `nextStep: "retry"` appears only when `retrySafe` is true.

    Migration: read `nextStep` instead of parsing `message`. Code that constructs these errors itself (test doubles, custom layers) must pass `recovery`, `retrySafe` and `nextStep` where they are new.
    - Indeterminate session Apply failures require `reconcileSession` even when a lower-level port can safely replay a request. Pre-dispatch connection failures, Apply-result lookup and repeat-safe pending Save recovery retain their own guidance.
    - Compiled plugin builds require confirmed owned-process cleanup before advertising a safe repeat. Failed cleanup reports reconciliation and retains the termination failure; pure validation failures remain repeat-safe.
    - World preparation lease identity conflicts require reconciliation instead of retrying unchanged acquisition requirements.
    - Editor readiness preserves the prior slice's recovery actions and retry policy. Newly merged domain-parser errors also adopt the guidance fields.

- 9ce62ee: Complete the TypeScript Effect/error audit and integrate native Game Text indexing in production
  hosts. Public schema parsers now return domain errors with the original parse issues. All production
  tagged errors carry recovery, retry safety and next-step guidance, with deliberate classification
  and cause retention at adapter boundaries. All eight reviewed SDKs enforce named public entry
  points and caller documentation, with no grandfathered raw decoder factories. Nested cause
  stringification, direct error translations and helper adapters are covered by regression guards.

    Use the new `GameTextIndexBuilderLive` layer with the host's `AssetReader`; CLI, Workbench and packed
    consumer conformance use the same native implementation. The TypeScript builder became test-only later in this release. Native worker/capability failures do not silently fall back. Scoped cancellation
    releases staging, writer leases and processes; native failures use stable codes independent of prose.
    PO provenance changes no longer force an otherwise eligible native join to rebuild fully.

    Obsolete public `*Shape` aliases are removed from connection, asset reader/Project Index and camera
    entry points; use their `*Api` names. Private `columnarTextCorpusQuery` and
    `makeGameTextSearchWorker` constructors are no longer exported. See the
    [migration guide](https://github.com/ue-shed/ue-shed/blob/main/docs/engineering/effect-audit-migration.md) for error and composition changes.

    AssetReader test layers now require a complete explicit port, including configuration and projection
    operations; omitted operations no longer install runtime "not stubbed" failures. Protocol transport
    budget/validator helpers are private to the asset-reader adapter.

    Game Text and Enhanced Input distinguish `reader_failed` from `invalid_project`; Game Text workspace
    index failures use `index_failed`. Reader recovery guidance and structured causes survive these
    translations. Portable localization failures keep installation candidates, authored payloads and
    secret configuration private through explicitly sanitized causes.

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
    - @ue-shed/engine@0.17.0

## 0.16.2

### Patch Changes

- @ue-shed/engine@0.16.2

## 0.16.1

### Patch Changes

- @ue-shed/engine@0.16.1

## 0.16.0

### Patch Changes

- @ue-shed/engine@0.16.0

## 0.15.0

### Patch Changes

- @ue-shed/engine@0.15.0

## 0.14.0

### Patch Changes

- d8eca33: Upgrade Effect and its integrations to stable 4.0.4. Update renamed schema and configuration APIs,
  JSON Schema validation, synchronous cache queries, retained resource cleanup, and Remote Control
  response handling while preserving authoritative wire contracts and existing workflow behavior.
  Published libraries now require the application to provide `effect@^4.0.0` as a peer dependency,
  and `@ue-shed/observability` also requires `@effect/opentelemetry@^4.0.0`. Install these in the
  application (or reuse compatible existing versions) so UE Shed shares the application's Effect
  runtime. Workspace development and tests remain pinned to Effect 4.0.4 through the catalog.
- Updated dependencies [d8eca33]
- Updated dependencies [e96a922]
    - @ue-shed/engine@0.14.0

## 0.13.0

### Patch Changes

- @ue-shed/engine@0.13.0

## 0.12.0

### Patch Changes

- @ue-shed/engine@0.12.0

## 0.11.0

### Patch Changes

- Updated dependencies [a545cd5]
    - @ue-shed/engine@0.11.0

## 0.10.0

No direct behavioral change. Align with the UE Shed 0.10.0 suite and exact internal dependency pins.

### Patch Changes

- Updated dependencies [f66ac19]
- Updated dependencies [5fd5bc7]
    - @ue-shed/engine@0.10.0

## 0.9.3

No direct behavioral change. Align with the UE Shed 0.9.3 suite and exact internal dependency pins.

### Patch Changes

- Updated dependencies [0aa99d8]
    - @ue-shed/engine@0.9.3

## 0.9.2

### Patch Changes

- Updated dependencies [53bb23f]
    - @ue-shed/engine@0.9.2

## 0.9.1

### Patch Changes

- @ue-shed/engine@0.9.1

## 0.9.0

### Patch Changes

- Ignore invisible half-float background variation during native camera fitting so it does not
  falsely reject auto-fit previews as clipped at the image edge.
- @ue-shed/engine@0.9.0

## 0.8.0

### Patch Changes

- Updated dependencies [aa83787]
- Updated dependencies [8c0d895]
- Updated dependencies [33d9c5f]
- Updated dependencies [aa83787]
- Updated dependencies [2104cb1]
- Updated dependencies [12b93d1]
    - @ue-shed/engine@0.8.0

## 0.7.1

Align this package with the synchronized UE Shed 0.7.1 suite and exact internal dependency pins. There is no direct behavioral change.

### Patch Changes

- @ue-shed/engine@0.7.1

## 0.7.0

### Patch Changes

- @ue-shed/engine@0.7.0

## 0.6.0

### Minor Changes

- 9bd7735: Add Niagara review profiles, lit scene capture, automatic camera fitting, and matched dark/light backgrounds. Expose activity-window and poster selection helpers, material diagnostics, and a local verified video encoder while retaining saved-camera transparent capture.
- 2760900: Add capture selection bounds and Lit capture readiness inspection, optional producer identity and plugin versions, actor catalog metadata, and structured Map Capture and Niagara progress. Expose library APIs and CLI workflows while retaining compatibility with producers that omit optional metadata and progress. Updated inspection operations require the advertised Core and Cameras capabilities.

### Patch Changes

- @ue-shed/engine@0.6.0

## 0.5.1

### Patch Changes

- Align this package with the synchronized UE Shed `0.5.1` patch release. There is no direct
  behavioral change.

- @ue-shed/engine@0.5.1

## 0.5.0

### Patch Changes

- @ue-shed/engine@0.5.0

## 0.4.0

### Minor Changes

- be0fa20: Add portable headless Niagara preview capture, validation, and atomic publication.

### Patch Changes

- Expose the Niagara preview schemas through a browser-safe package entry point for typed host and
  review interfaces.
- Updated dependencies [be0fa20]
    - @ue-shed/engine@0.4.0
