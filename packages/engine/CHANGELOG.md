# @ue-shed/engine

## 0.19.0

### Patch Changes

- 9112cd0: Engine discovery also reads the Launcher's `HKLM\SOFTWARE\EpicGames\Unreal Engine` keys, so it finds
  Launcher engines when `LauncherInstalled.dat` does not list them. The newly exported
  `installedEngineRoots` lists the candidate engine folders (Launcher install list, those registry
  keys and `Program Files\Epic Games`) for hosts that choose an engine by version, and
  `registeredBuildRoot` resolves a custom engine association. `makeEngineInstallationDiscoveryLayer`
  builds the discovery layer with a supplied registry query, so tests see only the engines they
  create.
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

- a8adf03: **Breaking:** tagged errors in `@ue-shed/unreal-connection`, `@ue-shed/unreal-assets` and `@ue-shed/cameras` share one shape: `message`, `recovery`, `retrySafe` and a typed `nextStep` (`"fix_input" | "retry" | "reconcile" | "escalate"`) beside their existing context fields.
    - `@ue-shed/protocol` exports `ErrorGuidanceFields` and `ErrorNextStep` for that shape.
    - `RemoteControlClientError`, `UnrealConnectionError`, `UnrealCapabilityError`, `AssetReaderError`, `InvestigationError`, the six `ProjectIndex*` errors and the camera, capture, map-tile and review errors now carry `recovery` and `nextStep`. Errors that had no `retrySafe` gain it.
    - `nextStep: "retry"` appears only when `retrySafe` is true. Mutations whose outcome is unknown after a transport failure report `reconcile`.
    - Low-level `RemoteControlClient.request` defaults to non-idempotent. Set `idempotent: true` only for reads or operations with a proven replay guarantee. A lost response, timeout or server failure can occur after applying a mutation; it is never proof that replay is safe.
    - Renderer reads preserve typed connection guidance, and malformed capability/preflight responses require escalation instead of transient retries.
    - `EditorConnectionError` also adopts the shared guidance fields. Editor readiness preserves upstream recovery instructions and polls only transient failures with `nextStep: "retry"`; permanent refusals and malformed responses fail immediately even when repeating the read is safe.
    - Malformed outer HTTP JSON follows the same recovery rules as malformed Remote Control envelopes: reconcile uncertain mutations and escalate read protocol failures.

    Migration: read `nextStep` instead of parsing `message` or branching on `kind`/`code` to decide what to do next. Code that constructs these errors itself (test doubles, custom reader or Remote Control layers) must pass `recovery`, `nextStep` and, where new, `retrySafe`.

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

- a33fffb: Fix text keys in assets through Unreal (ADR 0011). The new, separately enabled `UEShedGameText` editor plugin changes, regenerates and adopts text keys and retypes source in DataAsset properties, Blueprint class defaults, SCS component templates and widget trees, using the editor's own id rules. It then compiles each owning Blueprint, reads every place back and saves only when asked, over Remote Control or `-run=UEShedGameText`. Requests validate every target before editing, with dry runs, typed `key_conflict`, `stale_expected` and rollback errors carrying `recovery`, `retrySafe` and `nextStep`.
    - `@ue-shed/protocol`: the `ue-shed-game-text-actions` 1.0 request and result schemas (`contracts/game-text/v1`) and `gameTextObjectPath` in the capability manifest.
    - `@ue-shed/engine`: Remote Control allow-lists `UEShedGameTextLibrary` when the plugin is enabled.
    - `@ue-shed/game-text`: `runGameTextActions`, `gameTextActionsRequest`, `gameTextActionForOccurrence(id, occurrence, edit, packageFile)` and `verifyGameTextActions` (compare a re-read with the editor's result). Keep the scanned package file with each place so a copied package never targets its original through a saved object path.
    - Compilation and rollback suppress Save on Compile. Partial-save receipts retain applied edits and generated keys, separately report package persistence, and require reconciliation rather than mutation replay. Lost mutation replies are also unsafe to retry.

    Additive; no migration needed. DataTable cells keep using Authoring Apply 1.2, and graph pins are not action places yet.

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
- e96a922: Launch UE4 projects. The project launcher and supervised editor sessions now use `UE4Editor`
  binaries and `UE4Editor.modules` manifests for 4.x engines instead of always expecting
  `UnrealEditor`, so 4.27 launches no longer fail with `editor_missing` or report the Remote Control
  check as unverifiable. `unrealEditorExecutable`, `validateUnrealProjectBuildId`, and
  `validateUnrealRemoteControlBuild` take an optional `EngineVersion`; omitting it keeps UE5 naming.
  On macOS, `unrealEditorExecutable` now returns the binary inside the editor's app bundle
  (`UE4Editor.app/Contents/MacOS/UE4Editor` or `UnrealEditor.app/Contents/MacOS/UnrealEditor`)
  instead of a bare path that Unreal installations don't have.
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

### Minor Changes

- a545cd5: Keep a local Unreal editor responsive while a UE Shed host is in the foreground. The Core v1
  foreground responsiveness contract (`EditorForegroundLeaseRequest`, `EditorForegroundLeaseResult`,
  `EditorForegroundStateRequest`, `EditorForegroundStateResult`) and the manifest's
  `foregroundResponsivenessObjectPath` describe UE Shed Core's Windows-only
  `editor.foreground-responsiveness.v1` lease. `EditorForegroundResponsiveness.hold` holds a lease as a
  scoped resource: it refuses a non-loopback endpoint before sending anything, renews at a third of
  the TTL, re-acquires after a lost lease or an editor restart, degrades quietly to Unreal's normal
  policy, and releases when the scope closes. `isLoopbackEndpoint` is the shared local-only rule.

### Patch Changes

- Updated dependencies [1f01e74]
- Updated dependencies [a545cd5]
- Updated dependencies [580442c]
- Updated dependencies [67a611c]
    - @ue-shed/protocol@0.11.0
    - @ue-shed/unreal-connection@0.11.0

## 0.10.0

### Minor Changes

- f66ac19: Plan and run Unreal localization recipes with owned process trees, bounded progress, cancellation,
  private failure logs and audited write receipts. Support UE 4.27 commandlet executable naming and
  headless CLI operation planning, including import-then-compile sync.

### Patch Changes

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

- Updated dependencies [8e83f1a]
- Updated dependencies [5fd5bc7]
    - @ue-shed/protocol@0.10.0
    - @ue-shed/unreal-connection@0.10.0

## 0.9.3

### Patch Changes

- 0aa99d8: Expose a structured engine_plugins_stale launch failure when Remote Control dependencies have
  outdated module identities on a buildable Windows source engine. Missing binaries and installed
  engines retain plugin_unavailable, allowing hosts to offer a targeted rebuild only when appropriate.
- @ue-shed/protocol@0.9.3
    - @ue-shed/unreal-connection@0.9.3

## 0.9.2

### Patch Changes

- 53bb23f: Compiled plugin archives accept paths longer than 100 bytes. The ustar writer split them at a slash
  before the 101st byte from the end, which always left a name over 100 bytes, so packaging any
  plugin with a long source path (such as the camera-authoring panel) failed with "Archive path is
  too long". It now splits at the first slash that fits, measured in bytes.

    Engine discovery also finds engines the Epic Games Launcher installed outside Program Files, by
    reading the Launcher's `LauncherInstalled.dat`.

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

- 8c0d895: Add verified editor-window activation through UE Shed Core and the engine library, with a Windows foreground permission handoff scoped to the connected process. Restore minimized windows and report actual activation, OS refusal, unavailable windows, and unsupported platforms.
- 33d9c5f: Add capability-negotiated asynchronous editor map opens with operation identities, bounded retained
  results and read-only completion polling. Lost acknowledgements never replay the map-open command;
  long loads remain pending and expired waits report an indeterminate outcome. Expose current editor
  map state separately, retaining compatibility with older synchronous companions.

    Workbench confirms cross-map Review Set opens, offers saved-review-only browsing, reports editor/map
    differences, and lets users explicitly follow the editor or switch it to their chosen map. Clarify
    that browsing saved camera sets only reveals drafts; selecting a draft opens it for editing.

### Patch Changes

- aa83787: Reject mismatched project and engine module build IDs before spawning Unreal Editor, with recovery
  guidance for custom engine builds whose major/minor versions match but whose binaries differ.
- aa83787: Validate Remote Control and its required engine-plugin dependencies before launching a live
  editor connection. Report missing DLLs, missing module manifests and mismatched build identities
  with recovery guidance before Unreal opens its missing-modules dialog. Plain editor launches
  do not require Remote Control.
- 2104cb1: Serialize camera approvals against their destination before committing recovery intent, honor explicitly reviewed native recovery after later host edits, and reuse equivalent capture profiles. Renew camera render leases after synchronous opening preparation.

    Allow the World preparation API through UE 5.8 Remote Control permissions. Expose the editor project root so Workbench can reject map synchronization and switching against a different project. Correlate camera workspace previews with their provisioned camera identity and preserve keyboard focus across virtualized outliner updates.

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

## 0.7.1

Align this package with the synchronized UE Shed 0.7.1 suite and exact internal dependency pins. There is no direct behavioral change.

### Patch Changes

- @ue-shed/protocol@0.7.1
    - @ue-shed/unreal-connection@0.7.1

## 0.7.0

### Patch Changes

- Updated dependencies [1c03e0f]
    - @ue-shed/protocol@0.7.0
    - @ue-shed/unreal-connection@0.7.0

## 0.6.0

### Patch Changes

- Align this package with the synchronized UE Shed `0.6.0` suite release. There is no direct
  behavioral change.
- Updated dependencies [9bd7735]
- Updated dependencies [ff117a0]
- Updated dependencies [2f1137a]
- Updated dependencies [2760900]
- Updated dependencies
- Updated dependencies [ff117a0]
    - @ue-shed/protocol@0.6.0
    - @ue-shed/unreal-connection@0.6.0

## 0.5.1

### Patch Changes

- Align this package with the synchronized UE Shed `0.5.1` patch release. There is no direct
  behavioral change.

- @ue-shed/protocol@0.5.1
    - @ue-shed/unreal-connection@0.5.1

## 0.5.0

### Patch Changes

- @ue-shed/protocol@0.5.0
    - @ue-shed/unreal-connection@0.5.0

## 0.4.0

### Patch Changes

- be0fa20: Add portable headless Niagara preview capture, validation, and atomic publication.
- @ue-shed/protocol@0.4.0
    - @ue-shed/unreal-connection@0.4.0

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
