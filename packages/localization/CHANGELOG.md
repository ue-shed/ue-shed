# @ue-shed/localization

## 0.24.0

### Patch Changes

- Updated dependencies [177d71e]
- Updated dependencies
    - @ue-shed/protocol@0.24.0
    - @ue-shed/config-explorer@0.24.0
    - @ue-shed/engine@0.24.0
    - @ue-shed/unreal-connection@0.24.0

## 0.23.0

### Minor Changes

- 742a808: The write audit around a localization commandlet run no longer reads the whole project. It records
  every file's size and modification time, hashes the plan's own files, and after the run hashes only
  files that are new or whose size or modification time changed. A write outside the plan is still
  reported. On a 35,000-file, 15.7 GB project the audit used to fail with `limit_exceeded` after 10
  seconds, so no gather or compile could run; its first snapshot now takes 2.6 seconds.
  `LocalizationAuditLimits.maxFileBytes` and `maxTotalBytes` now bound only hashed bytes, and the
  default `maxEntries` is 1,000,000. A change found by size or modification time alone carries
  `beforeUnread: true`, because the file's earlier content was not hashed.

### Patch Changes

- 430728c: Add the lightweight `@ue-shed/protocol/errors` subpath with the same error schemas as the root export. This entry point is additive. Reuse the shared guidance schemas across libraries and hosts; plugin distribution retains its independent fields with compile-time equality checks.

    Breaking: World preparation errors accept only the documented client and editor failure codes. Each code carries its own recovery guidance. Unknown producer codes fail contract decoding.

    Breaking: Niagara preview failures now require `nextStep` so hosts retain the next recovery action.

    Preserve Niagara session recovery, retry safety and next steps through preview error adaptation. Classify CLI plugin installation failures as input fixes, safe transient retries or escalation. Keep localization guidance host-neutral and add command hints in CLI output.

- Updated dependencies [d2a3165]
- Updated dependencies [33249ad]
- Updated dependencies [742a808]
- Updated dependencies [430728c]
    - @ue-shed/engine@0.23.0
    - @ue-shed/config-explorer@0.23.0
    - @ue-shed/protocol@0.23.0
    - @ue-shed/unreal-connection@0.23.0

## 0.22.0

### Minor Changes

- 07fd9e8: `applyLocalizationChangeSet` takes an optional `prepareWrites` hook. It is called with every PO
  file the write will replace, from the freshly read evidence, before the first one is written, so
  a host can check them all out; a failure writes nothing.

### Patch Changes

- Updated dependencies [1f38a2e]
- Updated dependencies [f682dbc]
- Updated dependencies [1d62dd0]
- Updated dependencies [150caea]
- Updated dependencies [05c1ba5]
- Updated dependencies [704c68b]
- Updated dependencies [5f6f15f]
    - @ue-shed/protocol@0.22.0
    - @ue-shed/config-explorer@0.22.0
    - @ue-shed/engine@0.22.0
    - @ue-shed/unreal-connection@0.22.0

## 0.21.0

### Minor Changes

- ad955ec: Localization runs and Game Text carry-over are usable from a host's own code.
    - `makeLocalizationOperationsLayer({ auditLimits })` sets the bounds of the before/after write
      audit of a commandlet run. The defaults, `defaultLocalizationAuditLimits` (100,000 entries,
      512 MiB per file, 2 GiB in total), are unchanged; raise them for projects whose audited files are
      larger. `LocalizationOperationsLive` keeps the defaults.
    - `makeLocalizationOperationsTestLayer` provides a complete operations implementation for tests.
    - `localizationCarryChanges(before, after)` from `@ue-shed/game-text/corpus` turns the keys a gather
      changed into change-set entries for the new keys, as `ue-shed loc run --carry` does.
    - `GameTextIdRepairsApi` from `@ue-shed/game-text/workspace` names the ID repair workflow type.

### Patch Changes

- Updated dependencies [9d91e8e]
- Updated dependencies [19c9412]
- Updated dependencies [05f4e1a]
    - @ue-shed/unreal-connection@0.21.0
    - @ue-shed/engine@0.21.0
    - @ue-shed/protocol@0.21.0
    - @ue-shed/config-explorer@0.21.0

## 0.20.0

### Patch Changes

- Updated dependencies [09972f9]
- Updated dependencies [f7e366f]
- Updated dependencies [bc3e398]
- Updated dependencies [68737a3]
    - @ue-shed/protocol@0.20.0
    - @ue-shed/unreal-connection@0.20.0
    - @ue-shed/config-explorer@0.20.0
    - @ue-shed/engine@0.20.0

## 0.19.0

### Patch Changes

- Updated dependencies [9112cd0]
    - @ue-shed/engine@0.19.0
    - @ue-shed/config-explorer@0.19.0
    - @ue-shed/protocol@0.19.0
    - @ue-shed/unreal-connection@0.19.0

## 0.18.0

### Minor Changes

- fc109a5: Route simple DataTable ID repairs through native Game Text when Authoring is absent. Use native
  Game Text for cell-key regeneration even when Authoring is present, since Authoring's cell commands
  cannot generate new keys. Admit the narrow key-repair capability independently of full localization
  authoring. String-table migration
  project checks use Core's projectRoot fact or an explicit host callback without editor-world
  control. Preserve receipts, expected-value checks, session binding and saved-file verification.

### Patch Changes

- Updated dependencies [b267701]
- Updated dependencies [fc109a5]
    - @ue-shed/protocol@0.18.0
    - @ue-shed/unreal-connection@0.18.0
    - @ue-shed/config-explorer@0.18.0
    - @ue-shed/engine@0.18.0

## 0.17.1

### Patch Changes

- @ue-shed/config-explorer@0.17.1
    - @ue-shed/engine@0.17.1
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

- d8e2f99: Errors are translated on purpose instead of being caught wholesale or matched with `instanceof`.
    - **Breaking (`@ue-shed/host`):** authoring session failures no longer expose an internal error tag as their public `code`. The codes are `session_live_failed`, `session_storage_failed`, `session_transition_refused`, `draft_intent_rejected`, `invalid_session_id`, `session_corrupt`, `session_not_found`, `editor_capability_missing` and `editor_connection_failed`; `authoring_session_failure` remains the default. Every session pipe names the failures it translates, so a new failure type is a compile error instead of a silently caught one. Live and connection failures now report their real `retrySafe`.
    - Tagged errors are matched by tag (`Schema.is` guards such as `isSnapshotStoreError`, `isLocalizationError` and `isProjectIndexError`, `Effect.catchTag`, or `Predicate.isTagged`), never with `instanceof`, so checks keep working across package copies and after a schema round trip.
    - The shared Game Text index decides whether to retry a racing open from the `missing` code instead of searching the message for `ENOENT`.

    Migration: hosts that branched on authoring session codes such as `AuthoringSessionStorageError` should switch to the new codes. Code that matched UE Shed errors with `instanceof` should match on `_tag` or use the exported guards.

- 0e2a894: Add durable, host-neutral Game Text ID repair proposals and verified receipts. The Showcase
  can split conflicting sources, choose shared text, and merge duplicate keys through optional
  Unreal property and DataTable editing capabilities, with explicit preview, approval and recovery.

    Expose reusable localization text actions for nested table cells, graph text pins, String Table
    entries/references and explicit localizable conversion. Add capability-negotiated native operations
    and durable String Table key migration with a persisted redirect, migrated references and an
    optional, explicitly selected deletion action with saved-file verification. Migration retains the
    old entry by default and can complete without deletion.

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
    - @ue-shed/config-explorer@0.17.0
    - @ue-shed/unreal-connection@0.17.0

## 0.16.2

### Patch Changes

- @ue-shed/config-explorer@0.16.2
    - @ue-shed/engine@0.16.2

## 0.16.1

### Patch Changes

- @ue-shed/config-explorer@0.16.1
    - @ue-shed/engine@0.16.1

## 0.16.0

### Patch Changes

- @ue-shed/engine@0.16.0
    - @ue-shed/config-explorer@0.16.0

## 0.15.0

### Patch Changes

- @ue-shed/config-explorer@0.15.0
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
    - @ue-shed/config-explorer@0.14.0
    - @ue-shed/engine@0.14.0

## 0.13.0

### Patch Changes

- @ue-shed/config-explorer@0.13.0
    - @ue-shed/engine@0.13.0

## 0.12.0

### Patch Changes

- @ue-shed/engine@0.12.0
    - @ue-shed/config-explorer@0.12.0

## 0.11.0

### Minor Changes

- 6218a5c: Change-set review treats an absent and an empty previous translation as the same: both mean no
  translation ships. A translation carried to a changed key before Unreal's gather stays current
  after the gather gives that key an empty translation.

    Add the `prepare` operation: Unreal's gather, then its PO export, in one GatherText process.

- 580442c: Share typed localization failure recovery between the event reader and streamed index importer.
  Malformed manifests, archives and PO files retain the existing recovery guidance through indexed
  CLI and Workbench workflows, with file and position details from the streaming reader.

### Patch Changes

- 982743f: Raise localization evidence and saved-reader limits tenfold, apply entry limits per file, and preserve read failure causes and recovery guidance in Game Text and the CLI.
- 580442c: Match UE 5.7 and 5.8 localization loaders by rejecting escaped unpaired UTF-16 surrogates in manifests and archives. Both the event parser and streaming index importer report the file, character offset, and typed malformed-manifest or malformed-archive failure. Saved package strings remain lossless WTF-8.
- 23c8d9c: Speed up localization file parsing and retain compact PO evidence for large targets. Byte-exact PO parsing and serialization remain available; applying translations rereads and checks the file before writing.

    Target PO evidence now exposes decoded entries in `value.entries`. Use `projectPOEvidence` to convert a full parsed document when constructing evidence; `parsePO` and `serializePO` keep their existing types and results.

- 02b5128: Match saved text carrying Unreal package namespaces to gathered localization identities, so
  translations, key changes, review fingerprints and gates use the same namespace and key as Unreal.
  Preserve full saved namespaces for asset inspection and detect shared identities and source
  conflicts across packages without false duplicate-source findings.
- 656ecf5: Import Unreal manifest, archive and PO files into Game Text snapshots by streaming, keyed by
  content hash, with a file-stat check that skips unchanged files without opening them. The PO
  parser exposes block decoding for streaming callers and takes a faster path for unescaped fields.
- Updated dependencies [a545cd5]
    - @ue-shed/engine@0.11.0
    - @ue-shed/config-explorer@0.11.0

## 0.10.0

### Minor Changes

- 8d812df: Add pure Unreal localization quality checks, provenance-bearing version-1 change-set proposals,
  and `ue-shed loc check` with optional exclusive proposal JSON creation.
- f66ac19: Plan and run Unreal localization recipes with owned process trees, bounded progress, cancellation,
  private failure logs and audited write receipts. Support UE 4.27 commandlet executable naming and
  headless CLI operation planning, including import-then-compile sync.
- bdbcaec: Add read-only Unreal localization target discovery, bounded saved-file evidence, pure format
  decoders, and byte-preserving PO serialization for Unreal 4.27, 5.7 and 5.8 layouts.
- 64976b1: Track localization review state in a project-owned review file per target. Records keep reviewed,
  proofread, approved and machine translated flags against a fingerprint of the source and the
  translation that ships next, so later edits read as changed since review. Game Text adds review
  lenses, accepted check findings and reviewed and proofread report shares.
- 271dcd1: Write reviewed translation change sets into PO files. Changes are revalidated against fresh
  evidence: the source must match the manifest, and the replaced translation must match what ships
  next. Only the edited `msgstr` values change, through an atomic, hash-guarded replace. Game Text
  adds browser-safe edit request and result schemas for hosts that stage edits.

### Patch Changes

- Updated dependencies [f66ac19]
- Updated dependencies [5fd5bc7]
    - @ue-shed/engine@0.10.0
    - @ue-shed/config-explorer@0.10.0
