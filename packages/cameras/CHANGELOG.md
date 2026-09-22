# @ue-shed/cameras

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
