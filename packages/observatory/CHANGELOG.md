# @ue-shed/observatory

## 0.19.0

### Patch Changes

- Updated dependencies [9112cd0]
    - @ue-shed/engine@0.19.0
    - @ue-shed/observability@0.19.0
    - @ue-shed/protocol@0.19.0
    - @ue-shed/unreal-connection@0.19.0

## 0.18.0

### Patch Changes

- Updated dependencies [b267701]
- Updated dependencies [fc109a5]
    - @ue-shed/protocol@0.18.0
    - @ue-shed/unreal-connection@0.18.0
    - @ue-shed/engine@0.18.0
    - @ue-shed/observability@0.18.0

## 0.17.1

### Patch Changes

- @ue-shed/engine@0.17.1
    - @ue-shed/observability@0.17.1
    - @ue-shed/protocol@0.17.1
    - @ue-shed/unreal-connection@0.17.1

## 0.17.0

### Minor Changes

- f233a3c: Observatory stream failures now carry a code and a retry flag. UEShedObservatory's StartActorObservation and SetActorObservationCadence failures used to be prose only. They now add `code` and `retrySafe` beside `message` and `recovery`. The codes are `invalid_json`, `missing_cadence`, `invalid_cadence`, `world_unavailable` (the only retry-safe one), `stream_inactive` and `platform_unsupported`.

    `setObservationCadence` passes the code and retry safety on in `ObservatoryConnectionError` (new optional `code`). Actor-feed start failures name the code in their message. Both fields are optional, so older plugins still decode, and their failures stay retry-safe as before.

- ba669e3: **Breaking:** the remaining packages' tagged errors gain the shared guidance shape from the first D4 slice: `message`, `recovery`, `retrySafe` and a typed `nextStep` (`"fix_input" | "retry" | "reconcile" | "escalate"`) beside their existing context fields. `nextStep: "retry"` appears only when `retrySafe` is true.

    Migration: read `nextStep` instead of parsing `message`. Code that constructs these errors itself (test doubles, custom layers) must pass `recovery`, `retrySafe` and `nextStep` where they are new.
    - Indeterminate session Apply failures require `reconcileSession` even when a lower-level port can safely replay a request. Pre-dispatch connection failures, Apply-result lookup and repeat-safe pending Save recovery retain their own guidance.
    - Compiled plugin builds require confirmed owned-process cleanup before advertising a safe repeat. Failed cleanup reports reconciliation and retains the termination failure; pure validation failures remain repeat-safe.
    - World preparation lease identity conflicts require reconciliation instead of retrying unchanged acquisition requirements.
    - Editor readiness preserves the prior slice's recovery actions and retry policy. Newly merged domain-parser errors also adopt the guidance fields.

- 2a05bc5: **Breaking:** exported raw decoders are unary domain parsers. Each package's parsers fail with its own contract error (`code: "invalid_contract"`, `message` naming the value, `recovery`, `retrySafe`, and the schema issue as `cause`) instead of Schema's parse error:
    - `@ue-shed/map-history`: `decodePerforceMapHistoryQuery`, `decodePerforceMapHistory`, `decodePerforceFastMapHistoryQuery`, `decodePerforceFastMapHistory`, `decodeMapHistoryQuery` and `decodeMapHistoryResult` become `parse*`, failing with `MapHistoryContractError`.
    - `@ue-shed/observatory`: `decodeWorldScoutResult` and `decodeWorldScoutFocusResult` become `parse*`, failing with `WorldScoutContractError`.
    - `@ue-shed/project-custodian`: `decodeCustodianScanRequest`, `decodeCustodianReport`, `decodeCustodianPrepareRequest`, `decodeCustodianProposal`, `decodeCustodianExecuteRequest` and `decodeCustodianReceipt` become `parse*`, failing with `CustodianContractError`.

    The private `@ue-shed/scenarios` package and the Map Capture, Content Observatory and Project Custodian extension clients get the same change, with `ScenarioContractError`, `MapCaptureContractError`, `ContentObservatoryContractError` and `CustodianClientContractError`.

    Migration: rename `decode*` to `parse*`, and handle the package's contract error where you handled a `SchemaError`.

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
    - @ue-shed/unreal-connection@0.17.0
    - @ue-shed/observability@0.17.0

## 0.16.2

### Patch Changes

- @ue-shed/engine@0.16.2
    - @ue-shed/observability@0.16.2
    - @ue-shed/protocol@0.16.2
    - @ue-shed/unreal-connection@0.16.2

## 0.16.1

### Patch Changes

- @ue-shed/engine@0.16.1
    - @ue-shed/observability@0.16.1
    - @ue-shed/protocol@0.16.1
    - @ue-shed/unreal-connection@0.16.1

## 0.16.0

### Patch Changes

- Updated dependencies [dbb471e]
- Updated dependencies [7d925d7]
    - @ue-shed/protocol@0.16.0
    - @ue-shed/engine@0.16.0
    - @ue-shed/unreal-connection@0.16.0
    - @ue-shed/observability@0.16.0

## 0.15.0

### Patch Changes

- @ue-shed/engine@0.15.0
    - @ue-shed/observability@0.15.0
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
- Updated dependencies [e96a922]
    - @ue-shed/protocol@0.14.0
    - @ue-shed/engine@0.14.0
    - @ue-shed/observability@0.14.0
    - @ue-shed/unreal-connection@0.14.0

## 0.13.0

### Patch Changes

- @ue-shed/engine@0.13.0
    - @ue-shed/observability@0.13.0
    - @ue-shed/protocol@0.13.0
    - @ue-shed/unreal-connection@0.13.0

## 0.12.0

### Patch Changes

- Updated dependencies [d90ae25]
    - @ue-shed/protocol@0.12.0
    - @ue-shed/engine@0.12.0
    - @ue-shed/unreal-connection@0.12.0
    - @ue-shed/observability@0.12.0

## 0.11.0

### Patch Changes

- Updated dependencies [1f01e74]
- Updated dependencies [a545cd5]
- Updated dependencies [580442c]
- Updated dependencies [67a611c]
    - @ue-shed/protocol@0.11.0
    - @ue-shed/engine@0.11.0
    - @ue-shed/unreal-connection@0.11.0
    - @ue-shed/observability@0.11.0

## 0.10.0

No direct behavioral change. Align with the UE Shed 0.10.0 suite and exact internal dependency pins.

### Patch Changes

- Updated dependencies [8e83f1a]
- Updated dependencies [f66ac19]
- Updated dependencies [5fd5bc7]
    - @ue-shed/protocol@0.10.0
    - @ue-shed/engine@0.10.0
    - @ue-shed/unreal-connection@0.10.0
    - @ue-shed/observability@0.10.0

## 0.9.3

No direct behavioral change. Align with the UE Shed 0.9.3 suite and exact internal dependency pins.

### Patch Changes

- Updated dependencies [0aa99d8]
    - @ue-shed/engine@0.9.3
    - @ue-shed/observability@0.9.3
    - @ue-shed/protocol@0.9.3
    - @ue-shed/unreal-connection@0.9.3

## 0.9.2

### Patch Changes

- Updated dependencies [53bb23f]
    - @ue-shed/engine@0.9.2
    - @ue-shed/observability@0.9.2
    - @ue-shed/protocol@0.9.2
    - @ue-shed/unreal-connection@0.9.2

## 0.9.1

### Patch Changes

- Updated dependencies [ce281fb]
- Updated dependencies [ce281fb]
    - @ue-shed/protocol@0.9.1
    - @ue-shed/engine@0.9.1
    - @ue-shed/unreal-connection@0.9.1
    - @ue-shed/observability@0.9.1

## 0.9.0

### Patch Changes

- Updated dependencies [a3b58fd]
- Updated dependencies [f69d878]
- Updated dependencies [b8c7623]
- Updated dependencies [679d972]
- Updated dependencies [e5c5811]
- Updated dependencies [3d4c6b1]
    - @ue-shed/protocol@0.9.0
    - @ue-shed/engine@0.9.0
    - @ue-shed/unreal-connection@0.9.0
    - @ue-shed/observability@0.9.0

## 0.8.0

### Patch Changes

- a1205bd: Use shared Core window activation for explicit actor navigation. Report window activation separately from actor selection, and leave foreground ownership unchanged during background follow updates.
- Updated dependencies [1a60713]
- Updated dependencies [aa83787]
- Updated dependencies [8c0d895]
- Updated dependencies [64ca9bf]
- Updated dependencies [33d9c5f]
- Updated dependencies [23d243a]
- Updated dependencies [2104cb1]
- Updated dependencies [aa83787]
- Updated dependencies [b0d2955]
- Updated dependencies [64ca9bf]
- Updated dependencies [2104cb1]
- Updated dependencies [12b93d1]
    - @ue-shed/protocol@0.8.0
    - @ue-shed/engine@0.8.0
    - @ue-shed/unreal-connection@0.8.0
    - @ue-shed/observability@0.8.0

## 0.7.1

Align this package with the synchronized UE Shed 0.7.1 suite and exact internal dependency pins. There is no direct behavioral change.

### Patch Changes

- @ue-shed/observability@0.7.1
    - @ue-shed/unreal-connection@0.7.1

## 0.7.0

### Patch Changes

- @ue-shed/unreal-connection@0.7.0
    - @ue-shed/observability@0.7.0

## 0.6.0

### Minor Changes

- 2760900: Add capture selection bounds and Lit capture readiness inspection, optional producer identity and plugin versions, actor catalog metadata, and structured Map Capture and Niagara progress. Expose library APIs and CLI workflows while retaining compatibility with producers that omit optional metadata and progress. Updated inspection operations require the advertised Core and Cameras capabilities.
- ff117a0: Add a headless selected Unreal target service with operation-scoped endpoint capture. Changing
  selection affects subsequent operations while active operations and their children retain their
  starting target. Review capture adapters can resolve an endpoint from an Effect at execution time.

    Expose browser-safe camera and world-observation contracts and pure helpers, plus an observability
    metrics entry point that does not load telemetry exporters. Existing root exports remain available.

### Patch Changes

- Updated dependencies [2760900]
- Updated dependencies [ff117a0]
    - @ue-shed/unreal-connection@0.6.0
    - @ue-shed/observability@0.6.0

## 0.5.1

### Patch Changes

- Align this package with the synchronized UE Shed `0.5.1` patch release. There is no direct
  behavioral change.

- @ue-shed/observability@0.5.1
    - @ue-shed/unreal-connection@0.5.1

## 0.5.0

### Patch Changes

- @ue-shed/observability@0.5.0
    - @ue-shed/unreal-connection@0.5.0

## 0.4.0

### Patch Changes

- @ue-shed/observability@0.4.0
    - @ue-shed/unreal-connection@0.4.0

## 0.3.0

### Patch Changes

- Updated dependencies [bf27d37]
    - @ue-shed/unreal-connection@0.3.0
    - @ue-shed/observability@0.3.0

## 0.2.0

### Patch Changes

- 51c0e1b: Align the unchanged public packages with the synchronized UE Shed `0.2.0` suite release.
- Updated dependencies [51c0e1b]
- Updated dependencies [51c0e1b]
    - @ue-shed/unreal-connection@0.2.0
    - @ue-shed/observability@0.2.0

## 0.1.0

### Patch Changes

- 9c2cdce: Publish the stable 0.1 package set, including the headless Game Text and World Log Map History
  integration packages.
- Updated dependencies [9c2cdce]
    - @ue-shed/observability@0.1.0
    - @ue-shed/unreal-connection@0.1.0
