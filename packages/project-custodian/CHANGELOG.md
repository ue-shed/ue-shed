# @ue-shed/project-custodian

## 0.17.1

## 0.17.0

### Minor Changes

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

## 0.16.2

## 0.16.1

No direct behavioral changes; version advanced for suite alignment.

## 0.16.0

## 0.15.0

## 0.14.0

### Patch Changes

- d8eca33: Upgrade Effect and its integrations to stable 4.0.4. Update renamed schema and configuration APIs,
  JSON Schema validation, synchronous cache queries, retained resource cleanup, and Remote Control
  response handling while preserving authoritative wire contracts and existing workflow behavior.
  Published libraries now require the application to provide `effect@^4.0.0` as a peer dependency,
  and `@ue-shed/observability` also requires `@effect/opentelemetry@^4.0.0`. Install these in the
  application (or reuse compatible existing versions) so UE Shed shares the application's Effect
  runtime. Workspace development and tests remain pinned to Effect 4.0.4 through the catalog.

## 0.13.0

## 0.12.0

## 0.11.0

## 0.10.0

No direct behavioral change. Align with the UE Shed 0.10.0 suite and exact internal dependency pins.

## 0.9.3

No direct behavioral change. Align with the UE Shed 0.9.3 suite and exact internal dependency pins.

## 0.9.2

## 0.9.1

## 0.9.0

Align this package with the synchronized UE Shed 0.9.0 suite and exact internal dependency pins. There is no direct behavioral change.

## 0.8.0

## 0.7.1

Align this package with the synchronized UE Shed 0.7.1 suite and exact internal dependency pins. There is no direct behavioral change.

## 0.7.0

### Minor Changes

- Align this unchanged package with the synchronized UE Shed `0.7.0` release. There is no direct behavioral change.

## 0.6.0

### Patch Changes

- Align this unchanged package with the synchronized UE Shed `0.6.0` suite release. There is no
  direct behavioral change.

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

## 0.2.0

### Minor Changes

- 51c0e1b: Publish engine discovery, project launch, editor readiness, PIE, and editor-world control as the
  headless `@ue-shed/engine` library. Publish Config Explorer and Project Custodian with browser-safe
  contracts and Node service layers. Add portable Map Capture plans, editor-world previews,
  orthographic tile-pyramid capture, safe map control, and more precise JSON and provisioning
  contracts.
