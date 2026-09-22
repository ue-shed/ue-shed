# @ue-shed/engine

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
