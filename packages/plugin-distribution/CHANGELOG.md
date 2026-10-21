# @ue-shed/plugin-distribution

## 0.20.0

### Patch Changes

- @ue-shed/engine@0.20.0

## 0.19.0

### Patch Changes

- Updated dependencies [9112cd0]
    - @ue-shed/engine@0.19.0

## 0.18.0

### Minor Changes

- 75d8605: Support exact UE4Editor compiled variants, UE4 AutomationTool discovery and minimal Game Text
  release asset names. Add a separate 4.27 Game Text source preset with runtime-only Core, shared
  engine adapters and sequential engine verification scripts. Extend the full UE5 suite and its
  existing presets to Unreal 5.6 through 5.8.2, including camera support.

### Patch Changes

- 760610f: Failures no longer read as success or as something they are not:
    - **Plugin store:**
        - A lease that cannot be read, or is still being written, keeps its release from being pruned. Only a lease that stays undecodable for 30 seconds is treated as abandoned.
        - A cache lock that cannot be read is treated as held.
    - **Resuming a review authoring session:** the Review Set is reported missing only when its file is gone. A Review Set that cannot be read or does not decode fails with its own reason and recovery, so a recoverable session is not discarded.

- @ue-shed/engine@0.18.0

## 0.17.1

### Patch Changes

- f014cb9: The `editor-host` plugin bundle now includes `UEShedGameText`, so hosts that install it can fix text
  keys in DataAssets, Blueprint defaults, widgets, graph pins and String Tables through Unreal. Its
  manifest records the `ue-shed-game-text-actions` 1.0 contract. The npm packages are republished for
  suite alignment only; none has a code change.

    0.17.1 also corrects the 0.17.0 migration guide and changelogs, which still described the removed
    TypeScript builder export and `searchWorker` option, and fixes their migration-guide links.

- @ue-shed/engine@0.17.1

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

- Updated dependencies [ba669e3]
- Updated dependencies [a8adf03]
- Updated dependencies [9ce62ee]
- Updated dependencies [a33fffb]
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

- 53bb23f: Compiled plugin archives accept paths longer than 100 bytes. The ustar writer split them at a slash
  before the 101st byte from the end, which always left a name over 100 bytes, so packaging any
  plugin with a long source path (such as the camera-authoring panel) failed with "Archive path is
  too long". It now splits at the first slash that fits, measured in bytes.

    Engine discovery also finds engines the Epic Games Launcher installed outside Program Files, by
    reading the Launcher's `LauncherInstalled.dat`.

- Updated dependencies [53bb23f]
    - @ue-shed/engine@0.9.2

## 0.9.1

### Patch Changes

- @ue-shed/engine@0.9.1

## 0.9.0

### Patch Changes

- @ue-shed/engine@0.9.0

## 0.8.0

### Patch Changes

- 1a60713: Add scoped camera arrangement editing, reviewed layouts and recipe import/export, a replaceable native
  Unreal menu, and atomic batch View approval. Persist effective actor hide/protect lists and produce
  Pure, Authored, or paired Review output through the shared renderer. Apply the same visibility policy
  to map-tile capture and live previews. Initial exclusions support loaded opaque non-Nanite static meshes;
  unsupported geometry and unresolved references fail explicitly. Capture requires no authoring UI.
- 23d243a: Add actor-scoped camera arrangement drafts, revision-aware durable commands and approval recovery,
  stable camera ownership in Review Set 1.4, and a replaceable Unreal RC authoring bridge. Provide
  independently optional native camera authoring bridge and reference menu plugins; saved cameras still
  capture with Core+Cameras only.
- b0d2955: Add opt-in editor background ticking for connected live camera streams without changing editor preferences. Release the override on pause, clear, loss of world authority, disconnect, or stalled delivery. Correct round-robin iteration and prioritize the focused camera. Hosts must publish/install matching protocol, cameras, and native plugin versions.
- Updated dependencies [aa83787]
- Updated dependencies [8c0d895]
- Updated dependencies [33d9c5f]
- Updated dependencies [aa83787]
- Updated dependencies [2104cb1]
- Updated dependencies [12b93d1]
    - @ue-shed/engine@0.8.0

## 0.7.1

### Patch Changes

- Support native Unreal 5.8 plugin builds alongside 5.7 by adapting JSON field access and widening portable source compatibility.
- @ue-shed/engine@0.7.1

## 0.7.0

### Patch Changes

- @ue-shed/engine@0.7.0

## 0.6.0

### Patch Changes

- Align this package with the synchronized UE Shed `0.6.0` suite release. There is no direct
  behavioral change.
- @ue-shed/engine@0.6.0

## 0.5.1

### Patch Changes

- 8085e3e: Persist durable Unreal actor GUIDs in Review Views and capture requests, resolve subjects by GUID in
  the Cameras plugin, and initialize revision sessions from the saved camera pose.

    Bind compiled plugin variants to their npm packages and wire contracts, and verify per-module and
    per-native-file provenance during cold-cache installation.

- @ue-shed/engine@0.5.1

## 0.5.0

### Minor Changes

- fba6229: Add exact compiled Unreal Editor plugin variants, immutable variant-aware caching and leases,
  compatibility selection, and a separately invoked supervised bundle builder.

### Patch Changes

- @ue-shed/engine@0.5.0

## 0.4.0

### Minor Changes

- Add the public headless service for installing, verifying, resolving, leasing, and pruning
  immutable UE Shed Unreal plugin distributions.
