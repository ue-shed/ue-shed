# @ue-shed/map-history

## 0.19.0

### Patch Changes

- @ue-shed/protocol@0.19.0
    - @ue-shed/unreal-assets@0.19.0

## 0.18.0

### Patch Changes

- Updated dependencies [b267701]
- Updated dependencies [fc109a5]
    - @ue-shed/protocol@0.18.0
    - @ue-shed/unreal-assets@0.18.0

## 0.17.1

### Patch Changes

- @ue-shed/protocol@0.17.1
    - @ue-shed/unreal-assets@0.17.1

## 0.17.0

### Minor Changes

- ba669e3: **Breaking:** the remaining packages' tagged errors gain the shared guidance shape from the first D4 slice: `message`, `recovery`, `retrySafe` and a typed `nextStep` (`"fix_input" | "retry" | "reconcile" | "escalate"`) beside their existing context fields. `nextStep: "retry"` appears only when `retrySafe` is true.

    Migration: read `nextStep` instead of parsing `message`. Code that constructs these errors itself (test doubles, custom layers) must pass `recovery`, `retrySafe` and `nextStep` where they are new.
    - Indeterminate session Apply failures require `reconcileSession` even when a lower-level port can safely replay a request. Pre-dispatch connection failures, Apply-result lookup and repeat-safe pending Save recovery retain their own guidance.
    - Compiled plugin builds require confirmed owned-process cleanup before advertising a safe repeat. Failed cleanup reports reconciliation and retains the termination failure; pure validation failures remain repeat-safe.
    - World preparation lease identity conflicts require reconciliation instead of retrying unchanged acquisition requirements.
    - Editor readiness preserves the prior slice's recovery actions and retry policy. Newly merged domain-parser errors also adopt the guidance fields.

- d8e2f99: Errors are translated on purpose instead of being caught wholesale or matched with `instanceof`.
    - **Breaking (`@ue-shed/host`):** authoring session failures no longer expose an internal error tag as their public `code`. The codes are `session_live_failed`, `session_storage_failed`, `session_transition_refused`, `draft_intent_rejected`, `invalid_session_id`, `session_corrupt`, `session_not_found`, `editor_capability_missing` and `editor_connection_failed`; `authoring_session_failure` remains the default. Every session pipe names the failures it translates, so a new failure type is a compile error instead of a silently caught one. Live and connection failures now report their real `retrySafe`.
    - Tagged errors are matched by tag (`Schema.is` guards such as `isSnapshotStoreError`, `isLocalizationError` and `isProjectIndexError`, `Effect.catchTag`, or `Predicate.isTagged`), never with `instanceof`, so checks keep working across package copies and after a schema round trip.
    - The shared Game Text index decides whether to retry a racing open from the `missing` code instead of searching the message for `ENOENT`.

    Migration: hosts that branched on authoring session codes such as `AuthoringSessionStorageError` should switch to the new codes. Code that matched UE Shed errors with `instanceof` should match on `_tag` or use the exported guards.

- 2a05bc5: **Breaking:** exported raw decoders are unary domain parsers. Each package's parsers fail with its own contract error (`code: "invalid_contract"`, `message` naming the value, `recovery`, `retrySafe`, and the schema issue as `cause`) instead of Schema's parse error:
    - `@ue-shed/map-history`: `decodePerforceMapHistoryQuery`, `decodePerforceMapHistory`, `decodePerforceFastMapHistoryQuery`, `decodePerforceFastMapHistory`, `decodeMapHistoryQuery` and `decodeMapHistoryResult` become `parse*`, failing with `MapHistoryContractError`.
    - `@ue-shed/observatory`: `decodeWorldScoutResult` and `decodeWorldScoutFocusResult` become `parse*`, failing with `WorldScoutContractError`.
    - `@ue-shed/project-custodian`: `decodeCustodianScanRequest`, `decodeCustodianReport`, `decodeCustodianPrepareRequest`, `decodeCustodianProposal`, `decodeCustodianExecuteRequest` and `decodeCustodianReceipt` become `parse*`, failing with `CustodianContractError`.

    The private `@ue-shed/scenarios` package and the Map Capture, Content Observatory and Project Custodian extension clients get the same change, with `ScenarioContractError`, `MapCaptureContractError`, `ContentObservatoryContractError` and `CustodianClientContractError`.

    Migration: rename `decode*` to `parse*`, and handle the package's contract error where you handled a `SchemaError`.

### Patch Changes

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

- Updated dependencies [2bae469]
- Updated dependencies [bb9d55e]
- Updated dependencies [f403f84]
- Updated dependencies [49cf8f0]
- Updated dependencies [ba669e3]
- Updated dependencies [a8adf03]
- Updated dependencies [d585b1a]
- Updated dependencies [d8e2f99]
- Updated dependencies [9ce62ee]
- Updated dependencies [0e2a894]
- Updated dependencies [a33fffb]
- Updated dependencies [13ed5b7]
- Updated dependencies [9370ea6]
- Updated dependencies [70dec0a]
- Updated dependencies [2f9469b]
- Updated dependencies [2747ae8]
    - @ue-shed/protocol@0.17.0
    - @ue-shed/unreal-assets@0.17.0

## 0.16.2

### Patch Changes

- @ue-shed/protocol@0.16.2
    - @ue-shed/unreal-assets@0.16.2

## 0.16.1

### Patch Changes

- @ue-shed/protocol@0.16.1
    - @ue-shed/unreal-assets@0.16.1

## 0.16.0

### Patch Changes

- Updated dependencies [dbb471e]
- Updated dependencies [7d925d7]
- Updated dependencies [6608e6a]
    - @ue-shed/protocol@0.16.0
    - @ue-shed/unreal-assets@0.16.0

## 0.15.0

### Patch Changes

- @ue-shed/protocol@0.15.0
    - @ue-shed/unreal-assets@0.15.0

## 0.14.0

### Minor Changes

- edd423c: Require `p4client-ts@0.13.0`. Map History now runs Perforce commands through p4client-ts's native
  Effect `P4` layer on the application's Effect runtime, so they share its interruption and no
  separate Promise runtime is created; p4client-ts also takes `effect@^4.0.0` as a peer, so one
  Effect installation serves both. `perforceHistorySourceLayer` accepts p4client-ts 0.13's
  `P4ClientOptions`, which move the top-level `port`, `user`, `client` and `charset` into
  `connection`, plus an optional layer factory for tests. Perforce configuration failures still map to `perforce_configuration`.
  Install the matching exact `p4client-ts` version alongside this package.

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
    - @ue-shed/unreal-assets@0.14.0

## 0.13.0

### Minor Changes

- 634e912: Require `p4client-ts@0.12.1`. Perforce failures that previously returned empty results now surface as
  typed Map History errors: permission failures map to `perforce_authentication`, paths outside the
  client view to `ambiguous_depot_mapping`, and unknown user or charset failures to
  `perforce_configuration`. Install the matching exact `p4client-ts` version alongside this package.

### Patch Changes

- @ue-shed/protocol@0.13.0
    - @ue-shed/unreal-assets@0.13.0

## 0.12.0

### Patch Changes

- Updated dependencies [d90ae25]
- Updated dependencies [d99dcf6]
    - @ue-shed/protocol@0.12.0
    - @ue-shed/unreal-assets@0.12.0

## 0.11.0

### Patch Changes

- Updated dependencies [982743f]
- Updated dependencies [1f01e74]
- Updated dependencies [a545cd5]
- Updated dependencies [580442c]
- Updated dependencies [67a611c]
- Updated dependencies [9b08c67]
    - @ue-shed/unreal-assets@0.11.0
    - @ue-shed/protocol@0.11.0

## 0.10.0

No direct behavioral change. Align with the UE Shed 0.10.0 suite and exact internal dependency pins.

### Patch Changes

- Updated dependencies [8e83f1a]
- Updated dependencies [5fd5bc7]
    - @ue-shed/protocol@0.10.0
    - @ue-shed/unreal-assets@0.10.0

## 0.9.3

No direct behavioral change. Align with the UE Shed 0.9.3 suite and exact internal dependency pins.

### Patch Changes

- @ue-shed/protocol@0.9.3
    - @ue-shed/unreal-assets@0.9.3

## 0.9.2

### Patch Changes

- @ue-shed/protocol@0.9.2
    - @ue-shed/unreal-assets@0.9.2

## 0.9.1

### Patch Changes

- Updated dependencies [ce281fb]
- Updated dependencies [ce281fb]
    - @ue-shed/protocol@0.9.1
    - @ue-shed/unreal-assets@0.9.1

## 0.9.0

### Patch Changes

- Updated dependencies [a3b58fd]
- Updated dependencies [f69d878]
- Updated dependencies [b8c7623]
- Updated dependencies [679d972]
- Updated dependencies [e5c5811]
- Updated dependencies [3d4c6b1]
    - @ue-shed/protocol@0.9.0
    - @ue-shed/unreal-assets@0.9.0

## 0.8.0

### Patch Changes

- Updated dependencies [1a60713]
- Updated dependencies [8c0d895]
- Updated dependencies [64ca9bf]
- Updated dependencies [64ca9bf]
- Updated dependencies [33d9c5f]
- Updated dependencies [23d243a]
- Updated dependencies [2104cb1]
- Updated dependencies [b0d2955]
- Updated dependencies [64ca9bf]
- Updated dependencies [2104cb1]
    - @ue-shed/protocol@0.8.0
    - @ue-shed/unreal-assets@0.8.0

## 0.7.1

Align this package with the synchronized UE Shed 0.7.1 suite and exact internal dependency pins. There is no direct behavioral change.

### Patch Changes

- @ue-shed/protocol@0.7.1
    - @ue-shed/unreal-assets@0.7.1

## 0.7.0

### Patch Changes

- Updated dependencies [1c03e0f]
    - @ue-shed/protocol@0.7.0
    - @ue-shed/unreal-assets@0.7.0

## 0.6.0

### Patch Changes

- Align this package with the synchronized UE Shed `0.6.0` suite release. There is no direct
  behavioral change.
- Updated dependencies [9bd7735]
- Updated dependencies [ff117a0]
- Updated dependencies [efb6898]
- Updated dependencies [2f1137a]
- Updated dependencies [2760900]
- Updated dependencies
- Updated dependencies [ff117a0]
    - @ue-shed/protocol@0.6.0
    - @ue-shed/unreal-assets@0.6.0

## 0.5.1

### Patch Changes

- Align this package with the synchronized UE Shed `0.5.1` patch release. There is no direct
  behavioral change.

- @ue-shed/protocol@0.5.1
    - @ue-shed/unreal-assets@0.5.1

## 0.5.0

### Patch Changes

- @ue-shed/protocol@0.5.0
    - @ue-shed/unreal-assets@0.5.0

## 0.4.0

### Patch Changes

- @ue-shed/protocol@0.4.0
    - @ue-shed/unreal-assets@0.4.0

## 0.3.0

### Minor Changes

- bf27d37: Version the saved-world projection to v2 with finite effective location, quaternion rotation, scale,
  and direct root-component attachment evidence. Map History schema v2 records the new actor shape and
  distinguishes attachment, effective-transform, and transform-resolution changes.

### Patch Changes

- Updated dependencies [bf27d37]
    - @ue-shed/protocol@0.3.0
    - @ue-shed/unreal-assets@0.3.0

## 0.2.0

### Patch Changes

- 51c0e1b: Align the unchanged public packages with the synchronized UE Shed `0.2.0` suite release.
- Updated dependencies [51c0e1b]
- Updated dependencies [51c0e1b]
    - @ue-shed/protocol@0.2.0
    - @ue-shed/unreal-assets@0.2.0

## 0.1.0

### Patch Changes

- 9c2cdce: Publish the stable 0.1 package set, including the headless Game Text and World Log Map History
  integration packages.
- Updated dependencies [9c2cdce]
    - @ue-shed/protocol@0.1.0
    - @ue-shed/unreal-assets@0.1.0
