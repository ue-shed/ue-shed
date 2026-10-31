# @ue-shed/protocol

## 0.25.0

## 0.24.0

### Minor Changes

- 177d71e: Compare two saved revisions of a Blueprint without Unreal: `compareBlueprintRevisions` returns a
  page of the nodes, wires, variables, components and class defaults a change added, removed or
  changed, paired by saved identity so moved and renumbered nodes are counted rather than listed.
  It needs the native reader's uasset-io v1.21 `compare_blueprints` request, and says what it did
  not compare, such as a widget's layout.
- Compare two revisions of a localization file (`.po`, `.archive` or `.manifest`) without a scan. The
  workspace's new `chooseLocalizationFile` asks the person for each side through the host's file
  chooser, and `compareLocalizationFiles` compares only files chosen that way. The engine pairs
  entries by identity, then by occurrence, finds rekeyed texts, and sorts each change by what it means
  for the translations: a new key that lost its translation, changed wording, a case, punctuation or
  spacing change only, removed, added, a changed translation, a new key that kept its translation, or
  notes and references only. Filtering by group, text or asset and paging run in the engine, and each
  group lists its top assets. The schemas are in `/schema`; the index steps and query gain
  `compareTextFiles`. On a large UE 4.27 project's 67–78 MB files the first page takes 1.2–1.8 s and a
  later page or filter 1–2 ms.

## 0.23.0

### Patch Changes

- 430728c: Add the lightweight `@ue-shed/protocol/errors` subpath with the same error schemas as the root export. This entry point is additive. Reuse the shared guidance schemas across libraries and hosts; plugin distribution retains its independent fields with compile-time equality checks.

    Breaking: World preparation errors accept only the documented client and editor failure codes. Each code carries its own recovery guidance. Unknown producer codes fail contract decoding.

    Breaking: Niagara preview failures now require `nextStep` so hosts retain the next recovery action.

    Preserve Niagara session recovery, retry safety and next steps through preview error adaptation. Classify CLI plugin installation failures as input fixes, safe transient retries or escalation. Keep localization guidance host-neutral and add command hints in CLI output.

## 0.22.0

### Minor Changes

- 1f38a2e: Browse's findings are the project's rules. A workspace evaluates the published rules and sets a
  search's, focus's and line detail's `findings` layer; the page's `findings.status` says whether
  they are `none`, `pending` or `ready`. With a target every rule runs, with the target review's
  acceptance; without one, only source rules.
    - `finding` clauses name rule IDs, and the new `fact` field takes the four facts (`unresolved`,
      `conflicting`, `evidence_only`, `compiled_copy_differs`). `facets.findings` lists every rule with
      its rows, `facets.facts` counts each fact, and `group: "finding"` groups by rule.
    - The `finding` problem comes from rules whose `counts` is not `false`; `unresolved` no longer
      raises it. Rows, focus and detail list `findings` and `findingsOmitted`.
    - The corpus export lists each unit's rules, and `gameTextCsv` adds a Findings column.
    - Aggregates: the `finding` dimension is the layer's rules, and `review_signal` the facts.
    - Removed: the search `lens`, the `shared`, `duplicate_source` and `long` signals and counts
      (also the summary's `review.shared`, `review.duplicateSource` and `review.long`),
      `countedFindings()`, `TEXT_FINDING_SIGNALS` and `TextCountedFinding`. A saved investigation's
      lens reads as the clause it now is (`investigationRequest`). `TextFinding`, `TextReviewLens`,
      `textFindings`, `textCountedFindings` and rows' `countedFindings` stay, deprecated.

- f682dbc: A rules file can hold complete rules: entries with `kind: "rule"` written in the engine's rule
  language, with `when`, `actual`, `expectation` and `finding` references to other rules. Their
  findings are custom findings with `check: "rule"`, listed under `custom.<id>` with the rule's
  label. The engine's new `rules_check` request compiles a program and names the rule at fault;
  a workspace and `loc check` report `invalid_expression` and `rule_cycle` as
  `GameTextRuleDocumentError`s with the rule's `ruleId`. `customRulesOf`, `completeRulesOf` and
  `ruleProblemError` are new; `LocalizationCustomFinding` is now a union with the `rule` variant.
  The rule editor lists complete rules and says to edit them in the file.
- 1d62dd0: The Game Text engine runs in its own binary session, `uasset game-text-engine`, instead of the
  uasset-io protocol's `game_text_engine` operation, which is removed. Requests and replies are
  length-prefixed frames carrying request IDs, and requests carry their values inline: the JSON
  text `payload` fields are gone, and the rule document travels as an object.
  `GameTextEngineRequest` and `GameTextEngineOutcome` are removed from `@ue-shed/protocol`; the
  engine's types are `GameTextContract.EngineRequest`, `OpenReply`, `EngineEnd`, `EngineFailure`
  and `EngineProfile`, generated from the engine. `NativeGameTextEngineClient.execute` returns an
  `EngineAnswer` (its parts and profile); `answerJson` reads its reply.

    One engine process serves a host: `nativeIndexQueryLayer` starts it on the first read, and every
    open snapshot's reader lives in it, instead of two processes per snapshot. Requests run
    concurrently in the engine, keystrokes on threads of their own, so a search answers while an
    evaluation or an export runs. Interrupting a read cancels it in the engine rather than letting it
    finish unseen, and a panic in the engine fails only its request.

    Bulk reads stream as column batches instead of files: the corpus, its header, localization lines,
    aggregates and findings pages no longer write temporary files under the cache root, and a large
    findings page no longer spills to one. An `EngineAnswer` carries its `batches`, read through
    `EngineBatch` views over each frame's buffer, and `answerRows` reads one part's rows; the
    relations and their columns are generated as `GameTextContract.Relations`. The engine requests
    lose their `output` paths, `SpilledReply` is removed, and `ReadProfile` drops `responseBytes` and
    `fileFallback`; `EngineProfile` counts `batches`, `batchBytes` and `creditStallMs`.

    The engine reports progress as it works: opening reports its preparation stages and an
    evaluation each rule it runs. `NativeGameTextEngineClient.execute` and `findingsEvaluate` take a
    progress observer, and a quality scan's `localization_quality` and `source_quality` progress
    counts rules rather than lines. The workspace's `progressChanges()` streams its progress and each
    change to it, and a host's project port may supply `progressChanges` so the workspace follows it
    without polling.

    Searches reach the engine as a `query` request instead of `search`: a selection whose `where` is
    in the rule IR's grammar, and the parts the answer needs. `GameTextContract.Query`,
    `QuerySelection`, `QueryParts` and `QueryAnswer` type it; the rule IR gains `anyCulture`,
    `everyCulture`, `anyPlace` and `facet`, which the rule compiler refuses. A query's rows stream as
    `browseUnit` and `browseLine` batches. The `aggregate`, `export` and `localization_export`
    requests take a `selection` beside their own fields instead of the search fields.

    A `line` request reads a selected row's sections (its places, detail, related rows and the whole
    line) and replaces `focus`, `localization_detail`, `related` and `localization_focus_export`;
    `GameTextContract.LineRequest` and `LineAnswer` type it. The 50-row page cap is gone:
    `MAX_TEXT_QUERY_PAGE_SIZE` is 100,000, a page over 500 rows streams as a bulk read, and the CLI's
    `--limit` takes up to that. A unit's places, open groups' first rows and related rows list up to
    `MAX_TEXT_SECTION_ROWS` (500) at once, validated by `TextSectionRows`.

    The engine encodes exports itself. A request's `sink` names a format and a file, written beside
    it and moved into place, or streams the encoded rows as `text` frames that
    `NativeGameTextEngineClient.execute` hands to an `EngineTextSink`, an Effect writer; it answers with a
    `SinkSummary`. `NativeTextQuery.writeLocalizationLinesCsv` writes the all-languages CSV this way,
    so the Workbench export and `ue-shed loc export` no longer read the lines into the host, and
    the Workbench's 64 MiB cap on that file is gone. Engine errors gain the `exists` code.

    `ue-shed loc check` prints its report as the engine writes the findings, so it never holds them;
    the bytes are unchanged. `GameTextIndexRefreshResult.prepareLocalizationCheck` reads everything
    but the findings and returns a `PreparedLocalizationCheck`, whose `write` writes the report;
    `localizationCheck` still returns the report as a value. `findings_query` takes a `findingJson`
    sink without a `limit`, and `NativeFindings.findingsWrite` sends one. If the engine fails after
    the report starts printing, `loc check` writes the failure to stderr and exits with 2.

    `NativeTextQuery.writeCorpusCsv` writes Browse's CSV through a `corpusCsv` sink on the corpus
    export, so an investigation's corpus CSV asks for its file first and no unit reaches the host.
    Both file writers answer with a `SinkFileWritten`. `NativeTextQuery.writeCorpusJson` writes a
    corpus investigation's units into the document around them, a sink `envelope` that
    `corpusInvestigationEnvelope` makes; the corpus investigation JSON is written that way, and
    `corpusWithoutUnits` makes its document from the corpus header. `gameTextCsv` and
    `localizationLinesCsv` are deprecated in favour of those writers. Saving an investigation preset
    no longer reads the investigation's results; a query that can't be a preset fails with its reason.

- 150caea: Quality, source quality and `loc check` read their findings from the engine. It checks a rule
  document once, and each page, focus, export and proposal is a `findings_query`. A review's
  accepted findings are registered once with `findings_accept`. Nothing scans on the host thread,
  so the Quality worker is gone and the `qualityWorker` option has no effect.
    - `localizationQuality` returns `QueriedLocalizationQuality`, a `workspace` of the Quality
      reads. `localizationQualityWorkspaceOf(source, quality)` returns that workspace. The in-memory
      `localizationQuality(report, join)` returns the same shape and still lists a given source
      report's findings.
    - `indexedLocalizationStatusReport(query, evidence, page)` is an Effect that reads the index's
      report header.
    - Removed: `indexedLocalizationQuality`, `indexedSourceQuality`, `LocalizationFindingList`,
      `LocalizationFindingGroup`, `LocalizationQuality` and `LocalizationQualityMetadata`.
      `NativeFindings` loses `findingsLines` and `findingsUnits`, and the engine loses the `rows`,
      `findings_lines` and `findings_units` actions.

- 05c1ba5: Game Text's `duplicate_source`, `inconsistent_translation` and `culture_invariant_text` checks
  run in the native rule engine as v4 rules, with the same findings. `loc check` reads findings and
  lines in pages, so it runs on projects whose corpus or join is too large to hydrate. The rule
  contract gains group and corpus aggregates, `maxOf` and `regexReplace`. Remove the TypeScript group
  helpers that evaluated these checks: `localizationDuplicateSources`,
  `localizationDuplicateCandidate`, `localizationDuplicatePlaces`, `localizationTranslationVariants`,
  `invariantTextPlace`, `reportableInvariantText`, `localizationLocalizableProperties`,
  `localizationPropertiesWhereLocalizable`, `localizationPropertyKey`,
  `localizationCultureInvariantUnits`, `localizationConflictingSource`, `localizationSourceCulture`,
  `localizationRuleContext` and their types.

    Browse's `shared` and `long` review signals are also checks, `SourceCheckId`s with their own
    finding shapes and workspace filters. They are opt-in: the starter file doesn't list them.

    The Game Text rules file restarts at `schemaVersion: 1`, and versions 1–3 no longer load. A file is
    one `rules` list: built-in checks by `kind` with optional `enabled`, `severity`, `scope` and
    `params`, and project rules (source, localization and custom) as before, now in that list. Nothing
    runs that the file doesn't list, and without a file nothing runs; `STARTER_CHECKS` and
    `STARTER_CHECK_RULES` give today's default checks, and `effectiveRuleDocument` returns the
    engine's rule program. Remove
    `migrateGameTextRuleDocument`, `translateRuleDocument`, `TextQualityRuleDocument` and its decoders
    and error, `TextQualityRuleDocumentV2`, `TextQualityRuleDocumentV3`, `LocalizationCheckPreset`
    and `LocalizationCheckSettings`. Reports' `ruleDocumentVersion` is `1`.

- 5f6f15f: `workspace.related` reads a unit's or a target line's related members in one engine request
  (the `related` action): the units under its key, the units or lines with exactly its text, and
  with a target its key's conflicting units and its key change's paired line, each with its
  places and translations. The ID repair panel reads it instead of a text search and one focus per
  match.

### Patch Changes

- 704c68b: Correct Game Text's native source, String Table, compiled-copy, collapsed-PO and deleted-package
  facts. Missing String Table entries now report `string_table_entry_missing`. Retire the unused
  inline localization actions; maintained callers continue through the export and detail APIs.

## 0.21.0

### Minor Changes

- 19c9412: Decode more saved Blueprint, Sequencer and Niagara data. On UE 4.27: editable node pin suffixes,
  soft object path structs, Blueprint class records, property GUID maps, numeric channels, Level
  Sequence binding maps, data table row handles saved without default fields, and Niagara variable
  records. On UE5: graph pins from saved revisions 1000 to 1018 (so `readSavedBlueprint` accepts
  them too), Blueprint class records, DynamicCast nodes, splines, Niagara variable records, field
  paths and newer numeric channel framing.
  Keep every coverage gap while distinguishing text-free data from data that may hide text.
  uasset-io 1.18 adds `textGapCounts` to package text records and `may_contain_text` to gaps;
  older negotiated clients omit these fields. Native and WASM text status use the same evidence.
  Game Text package text shards move to `package-text-v9`, so existing indexes re-extract packages
  once.
- 05f4e1a: Package text can skip the host's event stream. uasset-io 1.19 adds `staging` to
  `extract_text_packages`: the reader writes each package's record line to a group file and streams a
  small `staged_text_package` result instead, in completion order, so one large package no longer
  holds back the rest. `AssetReader.stageProjectTextPackages` and `GameTextIndexSource.stage` expose
  it, and cold Game Text imports use it when the reader supports it: each import worker reads and
  validates its own group, and the main thread never parses package text. The reader creates each
  group file exclusively, so a large read split into several requests stages each request in its own
  directory and every staged event names the file holding its record; `batchStagedProtocolPaths`
  sizes those requests including their group numbers. Projection reads now
  default to up to eight workers (at least four) when a request sets no `limits.concurrency`.

    Staged snapshot files are written uncompressed, unsynced and in batched writes, since the writer
    reads them once in the same session; `writeSnapshotFile` takes `{ durable: false }` for this.
    A native writer publishes staged cold layers from their files (`SharedIndexWriter.publishColdFiles`)
    without the host opening each one.

## 0.20.0

### Minor Changes

- f7e366f: Filter Game Text by asset type. uasset-io 1.17 package text records carry `assetClass`, the class of
  the package's main asset chosen as Unreal's loader does (the export flagged as an asset and named
  after the file, else the first one); an actor saved in its own package reports its world's class.
  The index stores it per package under the same `package-text-v8` format, so caches rebuild once for
  this and the moved-package fix. Search requests take an `asset_type` clause of class paths such as
  `/Script/Engine.DataTable` or `/Script/UMGEditor.WidgetBlueprint`: `is` matches text with any saved
  place of a selected type, `is_not` text with none. `facets: { assetTypes: true }` counts lines per
  type over the request without its own clause, labelled by the new `textAssetTypeLabel` ("Data
  table", "Widget blueprint", "Level"). The native engine, both views, paging totals, counts and
  exports agree with the TypeScript references. The Workbench filter menu lists asset types.

### Patch Changes

- 09972f9: Fix Game Text key and source fixes on DataTable cells whose row struct is a User Defined Struct.
  The saved reader names such a cell by the member's FName (`DisplayName_2_<guid>`), but live rows use
  its authored name (`DisplayName`), so every fix failed with "The live cell no longer holds the
  source and key you reviewed." Authoring snapshot 2.4 field descriptors carry `propertyName`, the
  FName, and the UEShedAuthoring plugin reports it. Table fixes bind the reviewed cell through it and
  send `set_cell` the FName. A column missing from the live row now fails with its own
  `TextIdTableColumnError`, which says when the editor's plugin predates property names.
- 68737a3: Report a package moved or copied outside Unreal at its file's location. Its summary keeps the
  package name it was saved under, so the Game Text corpus and index stored object paths in the old
  folder, and opening a moved DataTable in Unreal failed with "Unreal's Asset Registry has no …".
  uasset-io 1.17 package text records carry the summary's `packageName`; when it differs from the
  name the file's location gives, the package's own object, class and Blueprint class paths move to
  the file's package, as Unreal resolves them, and the record keeps `packageName` as evidence. Paths
  into other packages stay as saved. Package text shards move to `package-text-v8`, so existing
  indexes read their packages again.

## 0.19.0

### Patch Changes

- Extend the native Game Text engine wire actions with aggregates, projected exports, corpus
  headers, report headers and fingerprints.

## 0.18.0

### Minor Changes

- b267701: Add the independently negotiated `editor.asset-open.v1` capability in UEShedCoreEditor and
  `openUnrealAsset({ endpoint, objectPath, bringToFront })` for trusted hosts. The separate
  `unreal-editor-asset-open` 1.0 contract reports accepted opens as `ok`, and missing assets, load
  failures and editor refusals as `unavailable` with recovery guidance. Locate continues to reveal
  Content Browser assets without opening them. Core's existing Remote Control class permission covers
  the new function. Hosts retain action choice and focus policy.
- fc109a5: Route simple DataTable ID repairs through native Game Text when Authoring is absent. Use native
  Game Text for cell-key regeneration even when Authoring is present, since Authoring's cell commands
  cannot generate new keys. Admit the narrow key-repair capability independently of full localization
  authoring. String-table migration
  project checks use Core's projectRoot fact or an explicit host callback without editor-world
  control. Preserve receipts, expected-value checks, session binding and saved-file verification.

## 0.17.1

## 0.17.0

### Minor Changes

- 2bae469: Authoring Apply 1.3 names why a command failed. UEShedAuthoring reported every rejected command as `command_failed` plus prose. Each of its 48 command error sites now sets a stable `cause` beside the message, for example `stale_cell`, `stale_row`, `unknown_row`, `unknown_field`, `row_exists`, `rename_conflict`, `expected_enum`, `unknown_enum_value`, `string_table_entry_missing`, `generated_text_read_only` or `table_outside_plan`.

    `code` stays `command_failed` so existing hosts behave the same. The apply contract minor is now 3, and the plugin bundle advertises `unreal-authoring-apply` 1.3. `AuthoringOperationError` and `contracts/authoring/v1/apply-result.schema.json` accept the optional `cause` (lower snake case, at most 64 characters). Apply 1.2 errors still decode.

- bb9d55e: Authoring Save 1.2 names why a package failed. UEShedAuthoring's Save per-package failures were prose only. They now add `code`: `table_not_found` when the DataTable could not be loaded, or `save_failed` when Unreal could not save the package. The save contract minor is now 2, and the plugin bundle advertises `unreal-authoring-save` 1.2. `AuthoringSaveResult` and `contracts/authoring/v1/save-result.schema.json` accept the optional `code`. Save 1.1 results still decode. Apply's command-level causes (`command_failed`) are unchanged.
- f403f84: Camera status, configure and provisioning failures are now valid, coded JSON. UEShedCameras used to build these responses with `Printf`, so a quote, backslash or control character in a message made the JSON invalid, and authored-preview visibility put prose into the `error` code field.

    The plugin now writes failures with the JSON writer. `error` is always a stable code (visibility failures report `invalid-visibility`), prose moves to a new `message` field, and GetStatus and Configure failures gain `status: "failed"`.
    - `@ue-shed/protocol`: `CameraControlFailure` describes the wire failure. Decoding stays inside the camera adapter so callers receive its domain error.
    - `@ue-shed/cameras`: `getCameraStatus` and `configureCameras` turn a coded failure into a `CameraControlError` that carries `code` (new, optional), instead of reporting it as an invalid response. Provisioning errors include the plugin's `message` beside its code.

    All fields are additive, and responses from older plugins still decode. No migration needed.

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

- 0e2a894: Add durable, host-neutral Game Text ID repair proposals and verified receipts. The Showcase
  can split conflicting sources, choose shared text, and merge duplicate keys through optional
  Unreal property and DataTable editing capabilities, with explicit preview, approval and recovery.

    Expose reusable localization text actions for nested table cells, graph text pins, String Table
    entries/references and explicit localizable conversion. Add capability-negotiated native operations
    and durable String Table key migration with a persisted redirect, migrated references and an
    optional, explicitly selected deletion action with saved-file verification. Migration retains the
    old entry by default and can complete without deletion.

- a33fffb: Fix text keys in assets through Unreal (ADR 0011). The new, separately enabled `UEShedGameText` editor plugin changes, regenerates and adopts text keys and retypes source in DataAsset properties, Blueprint class defaults, SCS component templates and widget trees, using the editor's own id rules. It then compiles each owning Blueprint, reads every place back and saves only when asked, over Remote Control or `-run=UEShedGameText`. Requests validate every target before editing, with dry runs, typed `key_conflict`, `stale_expected` and rollback errors carrying `recovery`, `retrySafe` and `nextStep`.
    - `@ue-shed/protocol`: the `ue-shed-game-text-actions` 1.0 request and result schemas (`contracts/game-text/v1`) and `gameTextObjectPath` in the capability manifest.
    - `@ue-shed/engine`: Remote Control allow-lists `UEShedGameTextLibrary` when the plugin is enabled.
    - `@ue-shed/game-text`: `runGameTextActions`, `gameTextActionsRequest`, `gameTextActionForOccurrence(id, occurrence, edit, packageFile)` and `verifyGameTextActions` (compare a re-read with the editor's result). Keep the scanned package file with each place so a copied package never targets its original through a saved object path.
    - Compilation and rollback suppress Save on Compile. Partial-save receipts retain applied edits and generated keys, separately report package persistence, and require reconciliation rather than mutation replay. Lost mutation replies are also unsafe to retry.

    Additive; no migration needed. DataTable cells keep using Authoring Apply 1.2, and graph pins are not action places yet.

- 13ed5b7: Publish changed package records through the native index without decoding unchanged shard
  records in JavaScript. Reuse localization dictionary blocks, coordinate target preparation
  under one writer session, persist incremental summary counters, and share scoped readers
  of the same validated revision. Package replacement requires uasset-io protocol 1.16.
- 9370ea6: Native error audit, part one (Rust).

    **Decode errors now say where they happened.** A saved-package decode error (`SavedAssetDecodeError` in the uasset-io v1 contract, and `decode_errors` in generic inspection JSON) can carry `field`, the logical field being read (such as `Exports[3].Properties.Name`), and `offset`, the absolute byte offset. `AssetError` exposes both as `field()` and `offset()`.

    **Corrected kind.** A metadata failure caused by an unsupported format or version used to be reported as `unsupported_capability`. It now keeps its own kind.

    **No panics on malformed packages.** The Rust crates enable `clippy::unwrap_used` and `clippy::expect_used`:
    - Every non-test `unwrap`/`expect` in the parser, inspection, source generator, IO and process supervisor crates is now either a typed error or an invariant stated once:
        - checked integer conversions go through `uasset-parser`'s `convert` helpers
        - poisoned locks recover their data
        - a lost projection worker is a retryable `unavailable` failure
        - a missing generated-layout field is `unsupported_capability`
    - The few remaining invariants keep an `#[expect]` with a reason.
    - A new regression test applies 328 deterministic truncations, bit flips and extreme-count overwrites to each fixture package under 400 KiB, then runs the parser, export decoders and projections. A malformed package must give a typed error, never a crash.

    The `uasset-inspection-wasm` crate is outside the Cargo workspace and was not changed.

    Protocol 1.14 negotiates the new decode-error context. New workers omit both fields on earlier
    protocol minors, preserving strict older decoders. Public inspection and full-scan readers request
    minor 14 and accept workers that omit the optional fields. Header scans retain their existing
    minor negotiation. Generic inspection JSON also retains the optional context.

- 70dec0a: Add an opt-in native Game Text index builder through the existing scoped uasset-io protocol
  session. The builder writes the existing shared dictionary and column format, supports narrowly
  eligible incremental joins, and preserves the current JavaScript query interface. TypeScript remained the default builder until the native engine entry in this release. Give decoded shared-string arenas their own buffers so cache
  accounting tracks their actual capacity.
- 2f9469b: Move Game Text indexing and query execution into the Rust engine. Queries, counts, facets,
  groups, focus and exports use scoped native readers; mixed authored-source, String Table and
  localization-file updates publish incremental snapshots while existing readers remain pinned.

    Game Text query methods now return Effects. Full corpus and localization evidence are explicit
    bulk reads, and interactive localization detail is paged in Rust. Remove the public in-memory
    query factories, TypeScript index builder, synchronous indexed projections and search worker.
    The native executable must support protocol 1.15 and game_text_engine_v1; unavailable or
    incompatible native readers produce typed failures without a JavaScript query fallback.

### Patch Changes

- 2747ae8: Add public-export documentation across `@ue-shed/protocol` and `@ue-shed/unreal-connection` (Plan 058 D11). The documented schemas, decoders and services explain wire or Unreal meaning, units and bounds, contract or protocol versions, and decoding failures. Failures are described in prose, not as `@throws`.

    A new lint rule, `anti-slop/require-jsdoc-on-exports`, covers both packages with explicit exceptions. Re-exports are covered at their declaration, and a type or interface named after a documented schema constant shares its documentation. Four files remain outside this lint scope: `protocol/src/index.ts`, `protocol/src/error-guidance.ts`, `unreal-connection/src/index.ts` and `unreal-connection/src/remote-control-client.ts`. D11 remains in progress for those boundaries and the remaining packages.

    No API changes.

## 0.16.2

## 0.16.1

No direct behavioral changes; version advanced for suite alignment.

## 0.16.0

### Minor Changes

- dbb471e: Tell player text from editor text in Game Text.

    Every text occurrence now records its `audience` (`player`, `editor` or `unknown`), why
    (`audienceReason`) and the policy row that decided it (`audienceRule`). Unreal's own evidence comes
    first: uasset-io v1.11 adds `gather_editor_only` to package text record occurrences, the editor-only
    bit Unreal saved for that text in the package's gatherable text table. Otherwise the reviewed,
    studio-agnostic `TEXT_AUDIENCE_POLICY` table decides (reflection tooltips, Blueprint, animation,
    Niagara and material graph nodes, editor modules, tooltips and categories, the UMG palette
    category and Niagara script metadata are editor text; String Table entries, DataTable cells,
    Blueprint enum display names and widget designer trees are player text). Units, search results and
    localization lines roll their visible occurrences up: player if any is, else unknown if any is,
    else editor.

    Search and query requests take an `audience` filter clause, `facets.audiences` and
    `group: "audience"`; Workbench's Filter and Display menus offer them. `gameTextCsv` and
    `localizationLinesCsv` add an Audience column. With a target that does not gather editor-only data
    (`ShouldGatherFromEditorOnlyData`, false by default), editor text that would read "Not gathered
    yet" is "Outside this target" with `outOfScope: "editor_only_data_not_gathered"`, so localization
    checks skip it; lines outside the gather paths carry `outside_gather_paths`.

    The package text index format moves to `package-text-v4` and joins to `joined-v13`, so existing
    caches read their packages once more. The audience policy is part of each shard key, so later
    policy changes re-encode stored shards without reading packages again.

- 7d925d7: Fold compiled Blueprint copies into the text a Blueprint authored.

    Compiling a Blueprint saves its widget tree, animations and defaults again under the generated
    class (`WBP_X_C`, animations as `Name_INST`), its default object (`Default__WBP_X_C`) and sometimes
    a skeleton class (`SKEL_WBP_X_C`). Game Text listed each widget text twice, and a Blueprint edited
    but not compiled read as "Same key, different text".

    uasset-io v1.12 adds `blueprintClasses` to package text records: each Blueprint, the export its saved
    `GeneratedClass` names, that class's `RF_ClassDefaultObject` export, and a saved skeleton class and
    its default object. Game Text folds every copy into the occurrence at its authored site with the
    same property and key, keeping two same-key properties of one object as two places and leaving
    sites saved only under the class (such as construction-script nodes) as their own places. Nothing
    is folded from names alone, so an asset whose own name ends in `_C` is untouched.

    Each place keeps the authored text as its source and lists its copies in `copies` (`objectPath`,
    `kind`: `generated_class`, `instance`, `class_default` or `skeleton`, and `source`). Counts,
    search, facets, exports, localization joins and the index follow the places. A copy with other text
    no longer makes its key conflicting. When a copy the game runs (the generated class or class
    default) holds other text, the unit gets the `compiled_copy_differs` review signal ("Blueprint not
    compiled since edit") and the Workbench line page says what the game shows; a skeleton-only
    difference is listed but raises no signal. A place's audience rolls up over the place and its
    copies, each classified from its own gather-table bit and class, so an editor-only place with a
    runtime compiled copy stays player text.

    The package text index format moves to `package-text-v5` and joins to `joined-v14`, so existing
    caches read their packages once more.

## 0.15.0

## 0.14.0

### Minor Changes

- 8f9bcf1: Saved text coverage now follows the package's own gatherable text table, the list Unreal's asset
  gather reads. A package is partial only when a runtime entry from that table was not decoded;
  undecodable properties that hold no gatherable text (native Niagara structs, for example) remain
  reported as coverage gaps without making the package partial. The table is used only where Unreal's
  gather would use it; Blueprints with bytecode, which are saved without one, keep the previous
  decoder-gap rule. uasset-io v1.10 adds `gatherCoverage` to package text records, Game Text adds
  `coverage.missingGatherableText` and `gatherable_text_not_decoded` diagnostics with the unread
  source text and Unreal site, and user-defined enum display names are now read as text. Entries
  match on namespace, key and source text, so an unread source variant under a decoded key stays
  missing, and authored bracketed namespaces are compared as Unreal saved them. UE 5.8 user-defined
  enums, which save an extra underlying-type byte, now decode instead of failing.

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

### Minor Changes

- d90ae25: Add composable map source planning, lossless RGBA8 cropping, and linear-light parent derivation.
  Callers can choose individual tile captures or larger source blocks per zoom with explicit size
  and decoded-memory limits, while retaining control of rendering, codecs, scheduling and publication.

    Expose optional, capability-checked screenshot warmup frames on the editor-viewport renderer.
    Native screenshot warmup is separate from outer settling; the scoped override restores the original
    engine value and priority after each frame and on interruption. Extended capability discovery is
    explicitly negotiated; the original capability response remains compatible with strict v1 clients.
    Existing capture defaults remain intact.

## 0.11.0

### Minor Changes

- 1f01e74: Add the opt-in uasset-io v1.8 package-text extraction operation and public reader stream.
  Each decoded package carries occurrences, complete gap counts and at most three diagnostic
  samples. Preserve the existing extraction stream and add a corpus adapter for package records.

    Negotiate uasset-io v1.9 package flags and gatherable-text summary count/offset in saved headers and Project Index
    header pages. Rebuild disposable Catalog caches for header profile 2. Candidate helpers use
    Unreal's gather flag, non-empty summary and saved external-package relationships; the fixture
    audit proves that TextProperty adds no candidates and every decoded occurrence is retained.

    Add optional corpus coverage for `not_gatherable` packages and exclusion diagnostics, retained
    in bounded localization status reports and Game Text coverage notes, with an optional excluded
    count in validated query summaries. This release also adopts the signature-keyed shared
    package-text layer in CLI and Workbench.

- a545cd5: Keep a local Unreal editor responsive while a UE Shed host is in the foreground. The Core v1
  foreground responsiveness contract (`EditorForegroundLeaseRequest`, `EditorForegroundLeaseResult`,
  `EditorForegroundStateRequest`, `EditorForegroundStateResult`) and the manifest's
  `foregroundResponsivenessObjectPath` describe UE Shed Core's Windows-only
  `editor.foreground-responsiveness.v1` lease. `EditorForegroundResponsiveness.hold` holds a lease as a
  scoped resource: it refuses a non-loopback endpoint before sending anything, renews at a third of
  the TTL, re-acquires after a lost lease or an editor restart, degrades quietly to Unreal's normal
  policy, and releases when the scope closes. `isLoopbackEndpoint` is the shared local-only rule.
- 580442c: Expose bounded, generation-checked Project Index inventory pages with opaque package and sidecar signatures and saved header gather eligibility. Game Text refreshes use this committed inventory; Workbench reuses its project refresh instead of enumerating disk again.
- 67a611c: Saved-world reads now produce contract 2.1, which only adds optional fields. Each actor reports
  `decode` (`partial` when its export or a subobject failed or kept a property value undecoded), its
  saved `parentComponent`, and `heldBy` when a child-actor component that names it in `ChildActor`
  belongs to another saved actor. The result lists every unreadable package or export in
  `packageErrors`, with its category, detail and whether an actor may have been lost, instead of only
  counting them in a diagnostic. Exports that decoded with undecoded property values are summarized in
  one `skipped_property` entry per package, with `count`, `exports` and the most frequent types; they
  do not make the package partial. `uasset saved-world --skipped-properties export` lists one entry
  per export instead. 2.0 documents still decode; consumers that pin `minor: 0` must accept `1`.

    The reader decodes `FIntPoint`, `FColor`, `FLinearColor`, `FBox2D` and `FMatrix` inside arrays,
    sets and maps, where they are always binary. An unknown struct inside a container decodes as a
    tagged stream only when the container's tag proves it; otherwise only its property is skipped, with
    the reason recorded, rather than failing the export or guessing. Landscape heightmap edge-fixup exports, which hold only native binary, are
    skipped instead of reported as failures.

## 0.10.0

### Minor Changes

- 8e83f1a: Read saved Game Text from Unreal 4.27 through 5.3 packages that use legacy property tags. The native
  reader and WASM inspection decode legacy tags, containers and text histories alongside the 5.4+
  layout. Text coverage gaps add `legacy_container_element_without_type_information`,
  `feature_unavailable_for_engine_version` and `property_decoder_rejected` reasons beside
  `unsupported_text_history`; consumers that switch exhaustively on the reason should handle them.
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

## 0.9.3

No direct behavioral change. Align with the UE Shed 0.9.3 suite and exact internal dependency pins.

## 0.9.2

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

## 0.9.0

### Minor Changes

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
- b8c7623: Add saved Blueprint and Sequencer review through the public reader, CLI, and Workbench:
  typed Level Sequence reads, reference inventory and resolution, and bounded comparisons with
  explicit incomplete evidence. Validate richer Blueprint graphs and regenerated sequences on
  Unreal 5.7 and 5.8. Include native property-bag decoding and saved animation summaries.
- 679d972: Decode boolean container bytes correctly and expose saved bool, integer, byte/enum, and visibility
  channels through Level Sequence schema 5. Preserve omitted defaults, channel flags and enum references;
  extend native/WASM, comparison, and Unreal 5.7/5.8 conformance.
- e5c5811: Expose shared Sequencer settings, scoped camera cuts, binding metadata and saved string/object
  channels through schema 6. Add Blueprint variable declarations, saved CDO overrides and component
  hierarchies/templates through schema 2. Publish bounded contracts and update native/WASM readers,
  reference navigation, comparisons and viewers with independent UE 5.7/5.8 fixture conformance.

    Decode source-checked inherited actor/component native records, including saved construction-script
    member references and conditional scene flags. Expose native evidence separately from tagged
    properties and include it in Blueprint comparisons/navigation and Sequencer reference coverage.

- 3d4c6b1: Keep saved FText translator notes. Keyed text and StringTable entries saved by UE 5.8 expose
  `dev_notes` in `readSavedAsset` inspection output and compact text extraction, and Game Text
  exposes them on each `TextOccurrence.devNotes`, separate from the source string and localization
  identity. Older packages and empty notes produce `""`. `readSavedTable` text cells are unchanged.

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
