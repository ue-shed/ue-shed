# @ue-shed/unreal-connection

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

## 0.21.0

### Minor Changes

- 9d91e8e: Hosts can configure Remote Control access, editor launches and plugin sources without changing UE
  Shed. All additions are optional; existing calls behave as before.
    - `makeRemoteControlClient` accepts `passphrase`, sent as Unreal's Remote Control `Passphrase`
      header, and extra `headers` for every request. An editor's HTTP 401 now reports a refused
      passphrase, with `fix_input` guidance, instead of a generic refusal.
    - A launch can add the host's own Remote Control classes to the UE 5.8 allowlist:
      `remoteControlAllowedClasses` on the `with_plugins` launch mode and on
      `SupervisedEditorSessionRequest`. `unrealRemoteControlPermissions(pluginIds, additionalClasses)`
      and the `RemoteControlAllowedClass` schema (`Module.Class`) are exported.
    - `readEngineInstallation(root)` reads an engine root's version without the registry or a project.
    - `EditorConnectionRequest.requestTimeout` bounds each manifest request.
    - Test layers: `makeEditorWindowActivationTestLayer`, `makeEditorForegroundPermissionTestLayer`,
      `makeEditorForegroundResponsivenessTestLayer`, `makePluginDistributionTestLayer` and
      `makeCompiledPluginBuilderTestLayer`.
    - `githubReleaseSourceLayer` accepts `assetNames`, so it serves bundles other than Map Review's.

### Patch Changes

- Updated dependencies [19c9412]
- Updated dependencies [05f4e1a]
    - @ue-shed/protocol@0.21.0

## 0.20.0

### Minor Changes

- bc3e398: Show in Unreal and asset opening work on UE 4.27. The 4.27 Game Text plugin bundle now builds
  `UEShedCoreEditor` with asset navigation and window activation only (play sessions, world control
  and foreground responsiveness stay UE5 only), so a 4.27 editor advertises
  `editor.asset-navigation.v1`, `editor.asset-open.v1` and `editor.window-activation.v1`. Core
  advertises each `UEShedCoreEditor` capability only when its class is built; UE5 manifests are
  unchanged. Class paths and Remote Control allowlists are the same on every engine.

### Patch Changes

- Updated dependencies [09972f9]
- Updated dependencies [f7e366f]
- Updated dependencies [68737a3]
    - @ue-shed/protocol@0.20.0

## 0.19.0

### Patch Changes

- @ue-shed/protocol@0.19.0

## 0.18.0

### Minor Changes

- b267701: Add the independently negotiated `editor.asset-open.v1` capability in UEShedCoreEditor and
  `openUnrealAsset({ endpoint, objectPath, bringToFront })` for trusted hosts. The separate
  `unreal-editor-asset-open` 1.0 contract reports accepted opens as `ok`, and missing assets, load
  failures and editor refusals as `unavailable` with recovery guidance. Locate continues to reveal
  Content Browser assets without opening them. Core's existing Remote Control class permission covers
  the new function. Hosts retain action choice and focus policy.

### Patch Changes

- Updated dependencies [b267701]
- Updated dependencies [fc109a5]
    - @ue-shed/protocol@0.18.0

## 0.17.1

### Patch Changes

- @ue-shed/protocol@0.17.1

## 0.17.0

### Minor Changes

- a8adf03: **Breaking:** tagged errors in `@ue-shed/unreal-connection`, `@ue-shed/unreal-assets` and `@ue-shed/cameras` share one shape: `message`, `recovery`, `retrySafe` and a typed `nextStep` (`"fix_input" | "retry" | "reconcile" | "escalate"`) beside their existing context fields.
    - `@ue-shed/protocol` exports `ErrorGuidanceFields` and `ErrorNextStep` for that shape.
    - `RemoteControlClientError`, `UnrealConnectionError`, `UnrealCapabilityError`, `AssetReaderError`, `InvestigationError`, the six `ProjectIndex*` errors and the camera, capture, map-tile and review errors now carry `recovery` and `nextStep`. Errors that had no `retrySafe` gain it.
    - `nextStep: "retry"` appears only when `retrySafe` is true. Mutations whose outcome is unknown after a transport failure report `reconcile`.
    - Low-level `RemoteControlClient.request` defaults to non-idempotent. Set `idempotent: true` only for reads or operations with a proven replay guarantee. A lost response, timeout or server failure can occur after applying a mutation; it is never proof that replay is safe.
    - Renderer reads preserve typed connection guidance, and malformed capability/preflight responses require escalation instead of transient retries.
    - `EditorConnectionError` also adopts the shared guidance fields. Editor readiness preserves upstream recovery instructions and polls only transient failures with `nextStep: "retry"`; permanent refusals and malformed responses fail immediately even when repeating the read is safe.
    - Malformed outer HTTP JSON follows the same recovery rules as malformed Remote Control envelopes: reconcile uncertain mutations and escalate read protocol failures.

    Migration: read `nextStep` instead of parsing `message` or branching on `kind`/`code` to decide what to do next. Code that constructs these errors itself (test doubles, custom reader or Remote Control layers) must pass `recovery`, `nextStep` and, where new, `retrySafe`.

- d585b1a: Error messages no longer embed a stringified cause (`String(cause)` or `Cause.pretty`). Each message says what failed and which ids are involved; the original failure is kept on the error's `cause` field (`ErrorCauseFields` from `@ue-shed/protocol`), so message text changes across these packages and several apps.
    - Game Text's cache failures are classified by filesystem code instead of reporting every failure as "unavailable, retry": `ENOENT` is `missing`, `EBUSY` is `busy`, and `EACCES`, `EPERM` and `ENOSPC` keep `unavailable` with a specific recovery.
    - `TextCorpusScanError` and `TextCorpusPublicError` gain the `invalid_options` code for malformed scan options, which were reported as `scan_limit_exceeded`.
    - The camera render `artifact_invalid` failure is split into codes that say which artifact check failed.

    Migration: match on codes and `nextStep`, not on message text. Read `cause` when you need the underlying failure for diagnostics. Handle `invalid_options` wherever you switch on Game Text scan error codes.

    The CLI prints retained input schema issues below classified messages, including the offending row-ID element and expected type. Game Text refresh and invalidation retain configuration keys and issues as their cause. New native-index and worker boundaries retain original failures alongside classified messages.

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

- 2747ae8: Add public-export documentation across `@ue-shed/protocol` and `@ue-shed/unreal-connection` (Plan 058 D11). The documented schemas, decoders and services explain wire or Unreal meaning, units and bounds, contract or protocol versions, and decoding failures. Failures are described in prose, not as `@throws`.

    A new lint rule, `anti-slop/require-jsdoc-on-exports`, covers both packages with explicit exceptions. Re-exports are covered at their declaration, and a type or interface named after a documented schema constant shares its documentation. Four files remain outside this lint scope: `protocol/src/index.ts`, `protocol/src/error-guidance.ts`, `unreal-connection/src/index.ts` and `unreal-connection/src/remote-control-client.ts`. D11 remains in progress for those boundaries and the remaining packages.

    No API changes.

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

## 0.16.2

### Patch Changes

- @ue-shed/protocol@0.16.2

## 0.16.1

### Patch Changes

- @ue-shed/protocol@0.16.1

## 0.16.0

### Patch Changes

- Updated dependencies [dbb471e]
- Updated dependencies [7d925d7]
    - @ue-shed/protocol@0.16.0

## 0.15.0

### Patch Changes

- @ue-shed/protocol@0.15.0

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

## 0.13.0

### Patch Changes

- @ue-shed/protocol@0.13.0

## 0.12.0

### Patch Changes

- Updated dependencies [d90ae25]
    - @ue-shed/protocol@0.12.0

## 0.11.0

### Patch Changes

- Updated dependencies [1f01e74]
- Updated dependencies [a545cd5]
- Updated dependencies [580442c]
- Updated dependencies [67a611c]
    - @ue-shed/protocol@0.11.0

## 0.10.0

### Minor Changes

- 5fd5bc7: Expose initialized live DataTable defaults and bounded actor/component row-reference lookup.
  Add an optional Unreal automation provider with explicit local-player input injection and owned
  CSV capture control, typed headless clients, shared contracts, and an authoring/automation source
  bundle. Existing hosts adopt the versioned UE Shed contracts without legacy native endpoints.

    Text values now carry their localization identity (snapshot 2.3, Apply 1.2): localized namespace and
    key, string-table entry, culture-invariant, or generated. Apply writes text from that identity,
    mints keys in the table package on request, and keeps identity for Apply 1.1 clients that rewrite an
    unchanged display string. Apply 1.2 refuses to remove a row whose text identity changed since
    review. Producer refusals are typed `UnrealConnectionError` codes. A new
    `editor-host` plugin bundle combines camera authoring with DataTable authoring.

### Patch Changes

- Updated dependencies [8e83f1a]
- Updated dependencies [5fd5bc7]
    - @ue-shed/protocol@0.10.0

## 0.9.3

No direct behavioral change. Align with the UE Shed 0.9.3 suite and exact internal dependency pins.

### Patch Changes

- @ue-shed/protocol@0.9.3

## 0.9.2

### Patch Changes

- @ue-shed/protocol@0.9.2

## 0.9.1

### Patch Changes

- Updated dependencies [ce281fb]
- Updated dependencies [ce281fb]
    - @ue-shed/protocol@0.9.1

## 0.9.0

### Patch Changes

- Updated dependencies [a3b58fd]
- Updated dependencies [f69d878]
- Updated dependencies [b8c7623]
- Updated dependencies [679d972]
- Updated dependencies [e5c5811]
- Updated dependencies [3d4c6b1]
    - @ue-shed/protocol@0.9.0

## 0.8.0

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

## 0.7.1

Align this package with the synchronized UE Shed 0.7.1 suite and exact internal dependency pins. There is no direct behavioral change.

### Patch Changes

- @ue-shed/protocol@0.7.1

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
