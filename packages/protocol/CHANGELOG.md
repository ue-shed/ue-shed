# @ue-shed/protocol

## 0.8.0

### Minor Changes

- 1a60713: Add scoped camera arrangement editing, reviewed layouts and recipe import/export, a replaceable native
  Unreal menu, and atomic batch View approval. Persist effective actor hide/protect lists and produce
  Pure, Authored, or paired Review output through the shared renderer. Apply the same visibility policy
  to map-tile capture and live previews. Initial exclusions support loaded opaque non-Nanite static meshes;
  unsupported geometry and unresolved references fail explicitly. Capture requires no authoring UI.
- 8c0d895: Add verified editor-window activation through UE Shed Core and the engine library, with a Windows foreground permission handoff scoped to the connected process. Restore minimized windows and report actual activation, OS refusal, unavailable windows, and unsupported platforms.
- 64ca9bf: Inspect rich curve keys, Skeleton reference poses and bone indices, Sequencer float/double channels,
  bounded InstancedStruct values, and package/object metadata in UE 5.7 saved packages. Share the
  source-derived native layouts across native and WASM readers and preserve unsupported inner payloads.
- 33d9c5f: Add capability-negotiated asynchronous editor map opens with operation identities, bounded retained
  results and read-only completion polling. Lost acknowledgements never replay the map-open command;
  long loads remain pending and expired waits report an indeterminate outcome. Expose current editor
  map state separately, retaining compatibility with older synchronous companions.

    Workbench confirms cross-map Review Set opens, offers saved-review-only browsing, reports editor/map
    differences, and lets users explicitly follow the editor or switch it to their chosen map. Clarify
    that browsing saved camera sets only reveals drafts; selecting a draft opens it for editing.

- 23d243a: Add actor-scoped camera arrangement drafts, revision-aware durable commands and approval recovery,
  stable camera ownership in Review Set 1.4, and a replaceable Unreal RC authoring bridge. Provide
  independently optional native camera authoring bridge and reference menu plugins; saved cameras still
  capture with Core+World+Cameras only.
- 2104cb1: Add scoped editor world preparation with unloaded actor planning, actor context regions, bounded renewable leases, Data Layer ownership and explicit readiness evidence. Share native preparation with camera rendering and expose headless prepared capture and CLI recovery operations.

    Start lease renewal windows after synchronous loading, reserve cleanup capacity separately from active ownership, and preserve caller defects and interruption when restoration fails. Expose single-poll readiness as `checkReady`.

    Restore camera viewport state during UE 5.8 map teardown when the engine has already cleared the pilot lock, while preserving normal ownership checks.

- 64ca9bf: Use source-derived Unreal class and serialization models for supported saved assets. Share bounded
  native layout decoding between StringTables and enums, expose StringTable metadata in native and
  WASM inspection, and preserve saved string-table text identities.

### Patch Changes

- b0d2955: Add opt-in editor background ticking for connected live camera streams without changing editor preferences. Release the override on pause, clear, loss of world authority, disconnect, or stalled delivery. Correct round-robin iteration and prioritize the focused camera. Hosts must publish/install matching protocol, cameras, and native plugin versions.
- 2104cb1: Serialize camera approvals against their destination before committing recovery intent, honor explicitly reviewed native recovery after later host edits, and reuse equivalent capture profiles. Renew camera render leases after synchronous opening preparation.

    Allow the World preparation API through UE 5.8 Remote Control permissions. Expose the editor project root so Workbench can reject map synchronization and switching against a different project. Correlate camera workspace previews with their provisioned camera identity and preserve keyboard focus across virtualized outliner updates.

## 0.7.1

Align this package with the synchronized UE Shed 0.7.1 suite and exact internal dependency pins. There is no direct behavioral change.

## 0.7.0

### Minor Changes

- 1c03e0f: Add scoped and one-shot editor-world camera rendering with explicit viewport and SceneCapture
  policies, preparation, native ownership, restoration, progress and artifact evidence. Adopt the
  shared lifecycle in Review previews/final captures and all existing map modes. Fixed Review cameras
  no longer depend on live subject resolution. Requires the matching UEShedCore/UEShedCameras bundle
  advertising cameras.render-session.v1; existing Review documents retain their legacy policy.

## 0.6.0

### Minor Changes

- 9bd7735: Add Niagara review profiles, lit scene capture, automatic camera fitting, and matched dark/light backgrounds. Expose activity-window and poster selection helpers, material diagnostics, and a local verified video encoder while retaining saved-camera transparent capture.
- ff117a0: Add generation-bound Project Index counts through
  `countProjectIndex({ projectId, expectedGeneration, filters })`. Supply 1–16 `ProjectIndexFilter`
  values for maps, exact classes, class prefixes, class-name suffixes, or serialized names. Each
  value-based filter requires 1–64 non-empty values; empty filter lists are rejected. Overlapping
  matches count each package once. The production binary Catalog reads checked snapshot postings
  without transferring candidate headers, and the public helper validates result identity and generation.
- 2f1137a: Make Lit editor-camera tiles the default Map Capture backend, with shared exposure, disabled
  vignette, plugin-owned scene freezing, and asynchronous capture with cancellation cleanup. Add
  optional manual exposure and retain explicit legacy backends. New plans use 16-pixel gutters and
  disable fog. The default requires an unlocked rendering editor viewport and the updated camera plugin.
- 2760900: Add capture selection bounds and Lit capture readiness inspection, optional producer identity and plugin versions, actor catalog metadata, and structured Map Capture and Niagara progress. Expose library APIs and CLI workflows while retaining compatibility with producers that omit optional metadata and progress. Updated inspection operations require the advertised Core and Cameras capabilities.
- Inspect saved Blueprint graphs without launching Unreal through `readSavedBlueprint`, native IO,
  and the WASM inspection API. Return graph/node identities, saved positions, typed pins and defaults,
  canonical links, tagged node properties, and explicit coverage diagnostics. Inspection is read-only
  and limited to supported uncooked saved revisions; it does not compile or execute Blueprints.

## 0.5.1

### Patch Changes

- Define Review Capture 1.5 with exact non-nil operation UUIDs, durable Unreal actor GUID
  locators, and bounded optional locator diagnostics shared by TypeScript and Unreal.

## 0.5.0

### Patch Changes

- Align this unchanged package with the synchronized UE Shed `0.5.0` suite release. There is no
  direct behavioral change.

## 0.4.0

### Patch Changes

- Align this unchanged package with the synchronized UE Shed `0.4.0` suite release. There is no
  direct behavioral change.

## 0.3.0

### Minor Changes

- bf27d37: Version the saved-world projection to v2 with finite effective location, quaternion rotation, scale,
  and direct root-component attachment evidence. Map History schema v2 records the new actor shape and
  distinguishes attachment, effective-transform, and transform-resolution changes.

## 0.2.0

### Minor Changes

- 51c0e1b: Publish engine discovery, project launch, editor readiness, PIE, and editor-world control as the
  headless `@ue-shed/engine` library. Publish Config Explorer and Project Custodian with browser-safe
  contracts and Node service layers. Add portable Map Capture plans, editor-world previews,
  orthographic tile-pyramid capture, safe map control, and more precise JSON and provisioning
  contracts.

## 0.1.0

### Patch Changes

- 9c2cdce: Publish the stable 0.1 package set, including the headless Game Text and World Log Map History
  integration packages.
