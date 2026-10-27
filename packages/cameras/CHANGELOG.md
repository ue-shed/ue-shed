# @ue-shed/cameras

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
    - @ue-shed/unreal-connection@0.22.0
    - @ue-shed/world@0.22.0
    - @ue-shed/observability@0.22.0

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

- Updated dependencies [5aa35e7]
- Updated dependencies [9d91e8e]
- Updated dependencies [19c9412]
- Updated dependencies [05f4e1a]
    - @ue-shed/world@0.21.0
    - @ue-shed/unreal-connection@0.21.0
    - @ue-shed/protocol@0.21.0
    - @ue-shed/observability@0.21.0

## 0.20.0

### Patch Changes

- Updated dependencies [09972f9]
- Updated dependencies [f7e366f]
- Updated dependencies [bc3e398]
- Updated dependencies [68737a3]
    - @ue-shed/protocol@0.20.0
    - @ue-shed/unreal-connection@0.20.0
    - @ue-shed/world@0.20.0
    - @ue-shed/observability@0.20.0

## 0.19.0

### Patch Changes

- @ue-shed/observability@0.19.0
    - @ue-shed/protocol@0.19.0
    - @ue-shed/unreal-connection@0.19.0
    - @ue-shed/world@0.19.0

## 0.18.0

### Patch Changes

- 760610f: Failures no longer read as success or as something they are not:
    - **Plugin store:**
        - A lease that cannot be read, or is still being written, keeps its release from being pruned. Only a lease that stays undecodable for 30 seconds is treated as abandoned.
        - A cache lock that cannot be read is treated as held.
    - **Resuming a review authoring session:** the Review Set is reported missing only when its file is gone. A Review Set that cannot be read or does not decode fails with its own reason and recovery, so a recoverable session is not discarded.

- 8268fd1: Reject non-boolean JSON values in native camera render policies instead of coercing strings and
  numbers. Include every native automation test in the full Unreal plugin verification gate.
- Updated dependencies [b267701]
- Updated dependencies [fc109a5]
    - @ue-shed/protocol@0.18.0
    - @ue-shed/unreal-connection@0.18.0
    - @ue-shed/world@0.18.0
    - @ue-shed/observability@0.18.0

## 0.17.1

### Patch Changes

- @ue-shed/observability@0.17.1
    - @ue-shed/protocol@0.17.1
    - @ue-shed/unreal-connection@0.17.1
    - @ue-shed/world@0.17.1

## 0.17.0

### Minor Changes

- 653830e: Camera authoring bridge failures name their cause. UEShedCameraAuthoringBridge and its native setup collapsed about 50 causes into five statuses (`busy`, `stale`, `unavailable`, `invalid`, `detached`) that only the prose told apart.

    Requests carrying `codedFailures: true` receive a stable `code`, for example `scope_mismatch`, `revision_conflict`, `editor_owned`, `camera_not_in_arrangement` or `setup_owned`. The status stays the same coarse category. The camera-authoring v1 request contract carries this opt-in, and `CameraBridgeResponse` accepts the optional `code` (lower snake case, at most 64 characters). `readyCameraBridge` passes it on as `CameraBridgeError.cause`.

    The SDK opts in by default and respects an explicit `false`. New plugins preserve the exact legacy three-field failure shape when the flag is absent or false, including setup failures. Older plugins ignore the flag, and their responses still decode. Existing `code` categories on `CameraBridgeError` are unchanged.

- f403f84: Camera status, configure and provisioning failures are now valid, coded JSON. UEShedCameras used to build these responses with `Printf`, so a quote, backslash or control character in a message made the JSON invalid, and authored-preview visibility put prose into the `error` code field.

    The plugin now writes failures with the JSON writer. `error` is always a stable code (visibility failures report `invalid-visibility`), prose moves to a new `message` field, and GetStatus and Configure failures gain `status: "failed"`.
    - `@ue-shed/protocol`: `CameraControlFailure` describes the wire failure. Decoding stays inside the camera adapter so callers receive its domain error.
    - `@ue-shed/cameras`: `getCameraStatus` and `configureCameras` turn a coded failure into a `CameraControlError` that carries `code` (new, optional), instead of reporting it as an invalid response. Provisioning errors include the plugin's `message` beside its code.

    All fields are additive, and responses from older plugins still decode. No migration needed.

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

- d8e2f99: Errors are translated on purpose instead of being caught wholesale or matched with `instanceof`.
    - **Breaking (`@ue-shed/host`):** authoring session failures no longer expose an internal error tag as their public `code`. The codes are `session_live_failed`, `session_storage_failed`, `session_transition_refused`, `draft_intent_rejected`, `invalid_session_id`, `session_corrupt`, `session_not_found`, `editor_capability_missing` and `editor_connection_failed`; `authoring_session_failure` remains the default. Every session pipe names the failures it translates, so a new failure type is a compile error instead of a silently caught one. Live and connection failures now report their real `retrySafe`.
    - Tagged errors are matched by tag (`Schema.is` guards such as `isSnapshotStoreError`, `isLocalizationError` and `isProjectIndexError`, `Effect.catchTag`, or `Predicate.isTagged`), never with `instanceof`, so checks keep working across package copies and after a schema round trip.
    - The shared Game Text index decides whether to retry a racing open from the `missing` code instead of searching the message for `ENOENT`.

    Migration: hosts that branched on authoring session codes such as `AuthoringSessionStorageError` should switch to the new codes. Code that matched UE Shed errors with `instanceof` should match on `_tag` or use the exported guards.

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

- e1d29ec: **Breaking:** layers compose through requirements, and test layers are complete fakes.
    - `@ue-shed/authoring` (private, no release): `authoringSessionServiceLayer(config)` and `makeAuthoringSessionService(config)` no longer take an id-generator Layer. They require `AuthoringIdGenerator`.
    - `@ue-shed/authoring-catalog` (private, no release): `authoringLiveConnectionLayer(connection)` is removed. Provide the connection as the `AuthoringLiveConnection` service.
    - `@ue-shed/cameras`: `makeReviewRepositoryTestLayer` and `makeReviewAuthoringTestLayer` take the complete service. They no longer fill `listSets` or `inspectSubject` with a defect.
    - `@ue-shed/game-text`: the internal project-view layer requires the `SharedIndex` it wraps instead of taking it as a Layer; `sharedIndexNodeLayer` is unchanged.
    - Workbench (private, no release): a project test layer that supplies `recent` also supplies `openRecent`; `current` alone cannot implement opening another project.

    Migration:
    - Write `authoringSessionServiceLayer(config).pipe(Layer.provide(AuthoringIdGeneratorLive))` and `makeAuthoringSessionService(config).pipe(Effect.provide(AuthoringIdGeneratorLive))`. Tests provide `authoringIdGeneratorLayer(...)` the same way.
    - Replace `Effect.provide(authoringLiveConnectionLayer(connection))` with `Effect.provideService(AuthoringLiveConnection, connection)`.
    - Callers of the two cameras test layers supply `listSets` and `inspectSubject` themselves.
    - Project test hosts with a recent list implement `openRecent` and keep `current` and selection reads consistent with the opened root.

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
    - @ue-shed/world@0.17.0
    - @ue-shed/unreal-connection@0.17.0
    - @ue-shed/observability@0.17.0

## 0.16.2

### Patch Changes

- @ue-shed/observability@0.16.2
    - @ue-shed/protocol@0.16.2
    - @ue-shed/unreal-connection@0.16.2
    - @ue-shed/world@0.16.2

## 0.16.1

### Patch Changes

- @ue-shed/observability@0.16.1
    - @ue-shed/protocol@0.16.1
    - @ue-shed/unreal-connection@0.16.1
    - @ue-shed/world@0.16.1

## 0.16.0

### Patch Changes

- Updated dependencies [dbb471e]
- Updated dependencies [7d925d7]
    - @ue-shed/protocol@0.16.0
    - @ue-shed/unreal-connection@0.16.0
    - @ue-shed/world@0.16.0
    - @ue-shed/observability@0.16.0

## 0.15.0

### Patch Changes

- @ue-shed/observability@0.15.0
    - @ue-shed/protocol@0.15.0
    - @ue-shed/unreal-connection@0.15.0
    - @ue-shed/world@0.15.0

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
    - @ue-shed/observability@0.14.0
    - @ue-shed/unreal-connection@0.14.0
    - @ue-shed/world@0.14.0

## 0.13.0

### Patch Changes

- @ue-shed/observability@0.13.0
    - @ue-shed/protocol@0.13.0
    - @ue-shed/unreal-connection@0.13.0
    - @ue-shed/world@0.13.0

## 0.12.0

### Minor Changes

- d90ae25: Add composable map source planning, lossless RGBA8 cropping, and linear-light parent derivation.
  Callers can choose individual tile captures or larger source blocks per zoom with explicit size
  and decoded-memory limits, while retaining control of rendering, codecs, scheduling and publication.

    Expose optional, capability-checked screenshot warmup frames on the editor-viewport renderer.
    Native screenshot warmup is separate from outer settling; the scoped override restores the original
    engine value and priority after each frame and on interruption. Extended capability discovery is
    explicitly negotiated; the original capability response remains compatible with strict v1 clients.
    Existing capture defaults remain intact.

### Patch Changes

- Updated dependencies [d90ae25]
    - @ue-shed/protocol@0.12.0
    - @ue-shed/unreal-connection@0.12.0
    - @ue-shed/world@0.12.0
    - @ue-shed/observability@0.12.0

## 0.11.0

### Patch Changes

- Updated dependencies [1f01e74]
- Updated dependencies [a545cd5]
- Updated dependencies [580442c]
- Updated dependencies [67a611c]
    - @ue-shed/protocol@0.11.0
    - @ue-shed/unreal-connection@0.11.0
    - @ue-shed/world@0.11.0
    - @ue-shed/observability@0.11.0

## 0.10.0

No direct behavioral change. Align with the UE Shed 0.10.0 suite and exact internal dependency pins.

### Patch Changes

- Updated dependencies [8e83f1a]
- Updated dependencies [5fd5bc7]
    - @ue-shed/protocol@0.10.0
    - @ue-shed/unreal-connection@0.10.0
    - @ue-shed/world@0.10.0
    - @ue-shed/observability@0.10.0

## 0.9.3

No direct behavioral change. Align with the UE Shed 0.9.3 suite and exact internal dependency pins.

### Patch Changes

- @ue-shed/observability@0.9.3
    - @ue-shed/protocol@0.9.3
    - @ue-shed/unreal-connection@0.9.3
    - @ue-shed/world@0.9.3

## 0.9.2

### Patch Changes

- @ue-shed/observability@0.9.2
    - @ue-shed/protocol@0.9.2
    - @ue-shed/unreal-connection@0.9.2
    - @ue-shed/world@0.9.2

## 0.9.1

### Patch Changes

- ce281fb: Tell an open camera set apart from another render session. When a camera set is open in the
  editor, the renderer now refuses a session with the new `authoring_open` code, the message "A
  camera set is open in the editor." and the recovery "Close the camera set, then retry."
  `editor_busy` now means only another render session or an unrelated screenshot, and its recovery
  says to wait for that session. Failures carry the blocking issue's recovery instead of a generic
  one, including Review and map-tile captures. `isEditorOwnershipRejection` identifies both codes, and
  Review capture reports them as retry-safe view failures with the native message instead of a
  connection failure. The camera render wire adds `authoring_open` to its failure codes. Older plugins
  keep sending `editor_busy`. Packages before this release don't recognise `authoring_open` and
  report it as `render_connection_failed`, so upgrade the package with the plugin.
- ce281fb: Add opt-in `editorPreviews` to the provisioned live feed. With `editorPreviews: true`,
  `ensureProvisionedCameras` previews show the child actors that ChildActorComponents spawn for
  editor-only owners, such as spawn-volume previews, using the same rule as
  `renderer.editorPreviews` on renders. A host's live preview can then match its captures, including
  while a camera set is open and render sessions are refused with `authoring_open`.

    The plugin rescans before each batch of preview frames. It restores the original flags when the
    feed is cleared or reprovisioned without the option, when the world is cleaned up, when Play
    starts, and on shutdown. Saves never write the changed flag. Render sessions, camera panel
    previews and the feed now share one reference-counted reveal, so one of them finishing never hides
    a preview another still shows.

    The request uses provisioning version 5 only when the option is on, so other requests are
    unchanged. Status and `getCameraStatus` report `editorPreviews.revealedChildActors` while the feed
    shows previews. Older plugins ignore the option, so `ensureProvisionedCameras` fails with the new
    `ProvisionedCameraError` code `unsupported_capability`. Retry without the option to fall back. A
    missing visibility echo (version 4) now carries the same code. The provisioning contract adds
    `editorPreviews` and version 5, and `CameraStatus` adds optional `editorPreviews`. Update the plugin
    with the package to use the option.

- Updated dependencies [ce281fb]
- Updated dependencies [ce281fb]
    - @ue-shed/protocol@0.9.1
    - @ue-shed/unreal-connection@0.9.1
    - @ue-shed/world@0.9.1
    - @ue-shed/observability@0.9.1

## 0.9.0

### Minor Changes

- f5610db: Polish the native Unreal camera panel for level designers. It opens from **Window → Cameras (UE
  Shed)** in the Level Editor section (menu search finds "camera" or "UE Shed") as a short
  **Cameras** tab with an icon and tooltip. **Select** frames the camera with its subject, or switches
  the pilot while piloting. **Save views** is the primary action and the footer says how many views
  are not saved yet. Numbers and the Visibility page use plain wording ("Distance (1 = fits
  subject)", "Margin (% per side)", "What saved shots show") instead of raw values. Every preview tile
  and camera-list row says whether its shot shows the subject (visible, partly hidden, blocked, not in
  the shot or didn't render), measured with the review capture's depth comparison, and the summary
  counts only shots that show it. Previews honour `renderer.editorPreviews`, which the Capture tab can
  now turn on. Camera-list rows show thumbnails from the same preview renders.
- a3b58fd: Add opt-in `renderer.editorPreviews` to camera render policies. When true, viewport and
  SceneCapture renders show child actors that ChildActorComponents spawn for editor-only owners,
  such as spawn-volume previews, while the owners and other editor-only content stay hidden. The
  plugin restores the original editor-only flags when the session ends, fails or its world is
  cleaned up, and saves never write the changed flag. Renderers report `editorPreviews` support
  in their capabilities; frame evidence records how many child actors were shown. Older plugins
  reject the field, so the renderer reports `unsupported_capability` before opening a session.
- f69d878: Let the native camera panel reopen a saved set for its selected subject. `makeCameraSetupHost`
  accepts optional `open` and `sets` callbacks; with both, each setup poll negotiates `reopen` and
  lists the host's saved sets (`CameraSetupSavedSet`, built with `cameraSetupSavedSet`), and the host
  opens a set when the panel asks. The camera-authoring/v1 setup contract gains optional `reopen`,
  `sets`, `canOpen`, `open`, `selection.actorGuid` and the `setup_open` request. The bridge only adds
  reply fields for hosts that sent `reopen: true`, so older hosts and older plugins are unaffected.

### Patch Changes

- 78b1b48: Keep a saved `renderer.editorPreviews` when a Review capture run picks another renderer, such as
  the high-resolution screenshot. `reviewCaptureRenderPolicy` previously replaced the whole renderer,
  so spawn-volume previews that the saved policy showed disappeared from that run's images. A
  per-run renderer that sets `editorPreviews` itself still wins.
- Updated dependencies [a3b58fd]
- Updated dependencies [f69d878]
- Updated dependencies [b8c7623]
- Updated dependencies [679d972]
- Updated dependencies [e5c5811]
- Updated dependencies [3d4c6b1]
    - @ue-shed/protocol@0.9.0
    - @ue-shed/unreal-connection@0.9.0
    - @ue-shed/world@0.9.0
    - @ue-shed/observability@0.9.0

## 0.8.0

### Minor Changes

- 1a60713: Add scoped camera arrangement editing, reviewed layouts and recipe import/export, a replaceable native
  Unreal menu, and atomic batch View approval. Persist effective actor hide/protect lists and produce
  Pure, Authored, or paired Review output through the shared renderer. Apply the same visibility policy
  to map-tile capture and live previews. Initial exclusions support loaded opaque non-Nanite static meshes;
  unsupported geometry and unresolved references fail explicitly. Capture requires no authoring UI.
- 23d243a: Add actor-scoped camera arrangement drafts, revision-aware durable commands and approval recovery,
  stable camera ownership in Review Set 1.4, and a replaceable Unreal RC authoring bridge. Provide
  independently optional native camera authoring bridge and reference menu plugins; saved cameras still
  capture with Core+World+Cameras only.
- 2104cb1: Add scoped editor world preparation with unloaded actor planning, actor context regions, bounded renewable leases, Data Layer ownership and explicit readiness evidence. Share native preparation with camera rendering and expose headless prepared capture and CLI recovery operations.

    Start lease renewal windows after synchronous loading, reserve cleanup capacity separately from active ownership, and preserve caller defects and interruption when restoration fails. Expose single-poll readiness as `checkReady`.

    Restore camera viewport state during UE 5.8 map teardown when the engine has already cleared the pilot lock, while preserving normal ownership checks.

- 12b93d1: Edit whole camera sets as transient Unreal camera actors with multi-selection, pilot switching,
  automatic draft synchronization, native duplication/deletion and Undo/Redo. Keep whole-set review
  in a separate on-demand See Previews panel. Enable the exact UE Shed Remote Control APIs required
  by UE 5.8 without changing project configuration or allowing arbitrary remote calls.

    Allow first-camera creation without a preselected Review Set, using the public createMapReviewSet
    workflow to persist a fresh destination. Distinguish editable camera sets from published Review Sets,
    surface create/open failures, and avoid unnecessary Unreal calls when opening saved collections.

    Redesign native camera authoring around actor selection and visible preset cards before creation,
    compact Select/Pilot rows, collapsed advanced settings, automatic-save status and a separate review
    footer. Add the public Effect setup host and bounded native setup queue so connected hosts can persist
    and attach a complete preset directly from Unreal without opening a Workbench page. Keep creation
    failures visible, avoid replay after lost acknowledgements, and skip hidden Workbench live rendering
    for native-created sets.

    Use a resizable camera-list/inspector split, two-column framing fields, compact action rows and native
    dock-style tabs. Enable numeric scrubbing with bounded live updates and retention of the final value
    through host acknowledgement; cancel unsent adjustments if their editing scope or session changes.

### Patch Changes

- b476292: Expose a consumer-neutral camera workspace request/result contract for hosts composing actor-scoped authoring through the existing camera ports.
- 42efd74: Expose camera panel contracts for studio hosts and preserve disjoint actor-set approvals in shared Review Sets.
- aa83787: Recover abandoned local camera writer locks without stealing live ownership. Add explicit,
  revision-checked recovery of saved versus pending native edits through public APIs, CLI and
  Workbench, including preserved snapshots after host loss. Prove process-crash recovery, packed
  consumer adoption and optional native-menu integration; record 1/6/37-camera scale evidence.
- aa83787: Allow an explicit per-run renderer in the public Review capture API. Default Workbench capture
  to Unreal's high-resolution viewport screenshot backend, with a saved-profile renderer option,
  matching capture-plan policy, and no silent renderer fallback or saved-profile mutation.
- aa83787: Bound native exposure input and scrubbing to the supported EV100 range, add a restore-default
  automatic exposure action, synchronize the field with saved settings, and apply the same fixed
  exposure overrides to native authoring cameras and snapshot previews.
- aa83787: Use smaller native camera drag ranges with exact typed values and explicit units. Disable
  fitted framing and aim controls when the scope includes manually positioned cameras, keep FOV
  available, and expose Restore fitted position next to the disabled controls.

    Scale height, aim, dolly, and world-Z dragging to the subject's size so large scenes get useful
    movement while small props retain precision, including when an existing offset is large.

    Replace fitted controls with live world position, rotation, and FOV for manually positioned
    cameras. Read native observations while draft saves are pending, and clarify the publication
    action as Save views to Review Set with an explanation of its capture-ready snapshot behavior.

    Keep fitted controls available in mixed manual/fitted scopes and switch checkbox selection to
    Selected cameras, so manually positioning one camera cannot block editing the others.

- aa83787: Expose the effective render policy in capture plans and show the renderer, exposure mode, and
  settling frames before capture. Distinguish editable camera drafts from saved-view collections
  and capture history in Workbench navigation.
- b0d2955: Add opt-in editor background ticking for connected live camera streams without changing editor preferences. Release the override on pause, clear, loss of world authority, disconnect, or stalled delivery. Correct round-robin iteration and prioritize the focused camera. Hosts must publish/install matching protocol, cameras, and native plugin versions.
- aa83787: Build only the requested plugin modules against source-engine installations, preserving existing
  engine binaries and metadata. Stage freshly built plugin modules with the unchanged engine build
  identity. Retain stdout and stderr build diagnostics in Workbench launch failures.
- 2104cb1: Serialize camera approvals against their destination before committing recovery intent, honor explicitly reviewed native recovery after later host edits, and reuse equivalent capture profiles. Renew camera render leases after synchronous opening preparation.

    Allow the World preparation API through UE 5.8 Remote Control permissions. Expose the editor project root so Workbench can reject map synchronization and switching against a different project. Correlate camera workspace previews with their provisioned camera identity and preserve keyboard focus across virtualized outliner updates.

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
    - @ue-shed/world@0.8.0
    - @ue-shed/unreal-connection@0.8.0
    - @ue-shed/observability@0.8.0

## 0.7.1

### Patch Changes

- Support native Unreal 5.8 plugin builds alongside 5.7 by adapting JSON field access and widening portable source compatibility.
- @ue-shed/observability@0.7.1
    - @ue-shed/protocol@0.7.1
    - @ue-shed/unreal-connection@0.7.1

## 0.7.0

### Minor Changes

- 1c03e0f: Add scoped and one-shot editor-world camera rendering with explicit viewport and SceneCapture
  policies, preparation, native ownership, restoration, progress and artifact evidence. Adopt the
  shared lifecycle in Review previews/final captures and all existing map modes. Fixed Review cameras
  no longer depend on live subject resolution. Requires the matching UEShedCore/UEShedCameras bundle
  advertising cameras.render-session.v1; existing Review documents retain their legacy policy.

### Patch Changes

- 1c03e0f: Capture fixed Review Views from their saved camera pose when the actor is unavailable, retaining provenance and explicit unassessed visibility without retrying actor-relative or indeterminate captures.
- Updated dependencies [1c03e0f]
    - @ue-shed/protocol@0.7.0
    - @ue-shed/unreal-connection@0.7.0
    - @ue-shed/observability@0.7.0

## 0.6.0

### Minor Changes

- 2f1137a: Make Lit editor-camera tiles the default Map Capture backend, with shared exposure, disabled
  vignette, plugin-owned scene freezing, and asynchronous capture with cancellation cleanup. Add
  optional manual exposure and retain explicit legacy backends. New plans use 16-pixel gutters and
  disable fog. The default requires an unlocked rendering editor viewport and the updated camera plugin.
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
- Updated dependencies [ff117a0]
    - @ue-shed/protocol@0.6.0
    - @ue-shed/unreal-connection@0.6.0
    - @ue-shed/observability@0.6.0

## 0.5.1

### Patch Changes

- 8085e3e: Persist durable Unreal actor GUIDs in Review Views and capture requests, resolve subjects by GUID in
  the Cameras plugin, and initialize revision sessions from the saved camera pose.

    Bind compiled plugin variants to their npm packages and wire contracts, and verify per-module and
    per-native-file provenance during cold-cache installation.

- @ue-shed/observability@0.5.1
    - @ue-shed/protocol@0.5.1
    - @ue-shed/unreal-connection@0.5.1

## 0.5.0

### Patch Changes

- @ue-shed/observability@0.5.0
    - @ue-shed/protocol@0.5.0
    - @ue-shed/unreal-connection@0.5.0

## 0.4.0

### Patch Changes

- @ue-shed/observability@0.4.0
    - @ue-shed/protocol@0.4.0
    - @ue-shed/unreal-connection@0.4.0

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
