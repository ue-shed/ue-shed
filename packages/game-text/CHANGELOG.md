# @ue-shed/game-text

## 0.24.0

### Minor Changes

- f6f6bd1: Game Text reads a target's C++ and config text (`@ue-shed/code`) and compares two points natively: `comparePoints` lists the lines a change adds, removes, rekeys or edits, and `localizationGateComparison` judges the change against the target's localization as the change found it, so only what the change introduces counts. Package editor text a target does not gather, by Unreal's gather table or else the audience policy, is left out of both points as the index leaves it out of scope, unless the base's manifest names it in that file. A text that only moved to another object of its package, keeping its key, text and property, is unchanged: a Blueprint's generated functions renumber on compile. The gate result gains an optional `change` describing what a changelist check read. `readGameTextChangePoints` reads a submitted changelist, a shelf, a range of submitted changelists or listed working-copy files through revisions the host supplies, and the workspace's new `compareChange` method serves it to hosts that pass `changeRevisions`. Map History reads revisions at a changelist, across a range (`readRangeRevisions`, listing a long range's files in batches a Windows command line holds), at the depot's head or the workspace's; `perforceChangeRevisions` hands those reads to Game Text; it uses a workspace the host names as named; it classifies Perforce failures by cause and refuses a changelist whose status is not the one asked for.
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

### Patch Changes

- 9a896fc: The workspace's `compareChange` gives no verdict over a change with a package or code file it could not read, as `loc gate` does: it answers `failed` with `unreadable_package` and the files, rather than a verdict that never saw them. Both share `unreadableChangePaths`. A change's points read `.hxx` sources, as the index's join policy does. Map History prints a change's revisions 16 at a time, each batch written before the next, rather than holding a side's files in memory, and keeps each Perforce server's revisions in their own cache folder, so two servers with the same depot path and revision never share bytes. Every revision file names its server's key, workspace copies included, and Game Text names a base localization revision by it.

    The engine's change comparison finds a package text's translations under its namespace without the package marker, as Unreal gathers it, so editing a translated line in an asset is reported. A text edited while its Blueprint function renumbered is judged as an edit of its key's text rather than passing as a move. A code file whose String Table text needs another file (a table registered elsewhere on 4.27) or a CSV that did not import reads as partial, and a file importing a CSV (in UTF-8 or UTF-16) is scanned again rather than reused, since the CSV is read from the project as it is now; its record is named by what the scan found, so an earlier point keeps its own. Code records cached before carry an older version and are read again. Code text scanning imports large String Table CSVs in linear time, reads no engine CSV without an engine root, leaves Unreal Header Tool output out of a revision's files as the full scan does on 5.x, and does not keep an engine wrapper prepass that could not read a header.

- Updated dependencies [177d71e]
- Updated dependencies
    - @ue-shed/protocol@0.24.0
    - @ue-shed/unreal-assets@0.24.0
    - @ue-shed/localization@0.24.0
    - @ue-shed/unreal-connection@0.24.0

## 0.23.0

### Minor Changes

- 87d6e83: Breaking: remove the deprecated root `@ue-shed/game-text` and `@ue-shed/game-text/browser`
  aggregates and the package's `main` and `types` fallbacks. Use browser-safe `/schema` for contracts,
  `/rules` for rule documents, `/checks` for checks and filter helpers, and `/labels` for presentation.
  Node hosts use `/corpus` for queries and reports, `/index` for scanning and native index composition,
  and `/workspace` for selected-project workflows and operations.

    Replace `WorkbenchOperationRequest`, `WorkbenchOperationFailure`, `WorkbenchOperationPlan`,
    `WorkbenchOperationPlanResult`, `WorkbenchOperationReceipt`, `WorkbenchOperationResult`,
    `WorkbenchOperationProgress`, `WorkbenchOperationState`, `WorkbenchOperationId`,
    `WorkbenchOperationTarget`, `WorkbenchOperationFilesRequest` and `WorkbenchOperationFilesResult`
    with the corresponding `GameTextOperation*` names from `/schema`. Replace `ScanTextCorpusOptions`
    with `TextCorpusScanOptions`, `TextCorpusServiceShape` with `TextCorpusServiceApi`, and
    `TextCorpusServiceTestShape` with `TextCorpusServiceTestApi`, all from `/index`.

    Replace `TextReviewLens` with `TextFilter` clauses from `/schema`:
    `finding` names rule IDs and `fact` names review signals. Replace `TextFinding`,
    `TextCountedFindings`, `textFindings`, `textCountedFindings` and row `countedFindings` with the
    row's `findings` rule IDs (`TextRowFindings` from `/checks`). Omit
    `GameTextIndexStepsOptions.qualityWorker`; quality runs in the native engine.

    Replace `gameTextCsv` with the opened query's `NativeTextQuery.writeCorpusCsv`, and
    `localizationLinesCsv` with `NativeTextQuery.writeLocalizationLinesCsv`. Replace
    `prepareLocalizationFile` with native index imports through `GameTextIndexSteps.importTarget`
    from `/index`. Saved investigation presets with a `lens` still open with the same selection: `investigationRequest` reads the lens as its filter clause.

- ed1feff: `GameTextWorkspaceContract`, from `@ue-shed/game-text/schema`, is the browser-safe contract of the Game Text workspace: for each `GameTextWorkspaceApi` method a host serves, its params and success schemas, and for `progressChanges` the schema of each event. It names no channels, so a host maps each method to its own IPC, WebSocket or MCP transport, decodes the params and calls the method with them. Methods that only run inside the host (operation admission, `localizationBeforeGather` and `configuredScan`) are left out and listed in its doc comment. The workspace no longer compiles if a method and its entry disagree.

    Breaking: every method the contract describes takes at most one argument. `configuredRefresh(refresh?)` is now `configuredRefresh({ refresh? })`, `createStarterRules(loadExisting)` is now `createStarterRules({ loadExisting })`, and `investigationExport(query, format)` is now `investigationExport({ query, format })`.

- ed1feff: Breaking: `GameTextWorkspaceProgress` is now an Effect Schema, exported from `@ue-shed/game-text/schema`, and carries raw phase codes instead of English text. Its `phase` is a `GameTextWorkspacePhase`: `idle`, `scanning`, `project_enumerating` or `project_scanning` while the host's project scan runs, or the running Game Text index phase (`localization`, `packages`, `source_quality` and so on). `stage` and `detail` are gone; word the phase with the new `GAME_TEXT_WORKSPACE_PHASE_LABELS`, or an index phase with `GAME_TEXT_INDEX_PHASE_LABELS`, both from `@ue-shed/game-text/labels`, which keep the wording `detail` had. During a quality scan, progress also carries `findings`, the findings so far.

    Breaking: the host's `project.progress()` now returns a `GameTextWorkspaceProjectProgress` (`phase`, `completed`, `total`); any other fields a host's progress carries are ignored rather than passed through.

    `GameTextIndexPhase` names the index's phase codes, from `./schema` and `./index`. The index's quality reads now name their first argument `ruleDocument` throughout, and their docs agree on how progress is counted: in rules evaluated, with the findings on the last event.

### Patch Changes

- 7a756bb: The asset reader now splits a package path list too large for one 4 MiB request itself. Scans,
  text and texture projections and staged package-text reads send the list in consecutive batches,
  one reader process at a time, so a project with tens of thousands of candidate paths no longer
  fails. A scan returns one merged result. A projection streams the batches in order and closes with
  one merged summary. Before batching, paths the reader would read twice (repeats, and paths
  beneath another requested directory) are dropped, and a package a later batch reports again is
  skipped, so each package appears once. Batches are cut against the measured size of the rest of
  the request, filters included. Progress counts keep growing across batches, and `maximumAssets`
  bounds the unique packages of the whole operation, checked after each batch. A batched header
  scan keeps one cache per batch at `${cachePath}.batch-${i}`, so an unchanged scan hits its cache
  on every batch. Cancelling stops the running batch and starts no more, and a failed batch fails
  the whole operation. Staged reads are cut only where the staging group changes. A path list that
  fits one request still runs exactly as before. Each operation's span records its batch count as
  `ue_shed.reader.batches`.

    Breaking: `AssetReaderError` has a new kind, `request_too_large`, with `nextStep: "fix_input"`.
    It replaces the `contract` error that an oversized request used to raise, and its message no
    longer names `batchProtocolPaths`. After batching, the error only comes from a single path or
    option that is too large on its own. A staged read whose staging group cannot fit one request
    also fails this way.

    Breaking: when no executable is configured, `assetReaderLayer` and `AssetReaderLive` now run the
    `uasset.exe` from the installed `@ue-shed/uasset-win32-x64` package before trying `uasset` on PATH.
    `getAssetReaderSource()` reports this as the new value `"package"`. `UE_SHED_UASSET_EXECUTABLE`
    still takes precedence for `AssetReaderLive`.

    Projection streams now report their protocol telemetry (the protocol observer's
    `worker_completed` event, boundary bytes and reader metrics) after their worker finishes. Before
    this change it was recorded when the stream was created, so it held zero counts.

    The Game Text index source passes its whole selection to the reader in one call. It now checks
    every package's bundle signature once before and once after the whole read, rather than around
    each batch.

- a91f56c: Quality evaluations on an opened Game Text index report progress again: a source rules preview shows "Checking source text" and a localization Quality request shows "Checking localization quality", counting the rules as they run. When a check finishes, fails or is cancelled, progress returns to idle.
- 354c9e9: A Scan that finds the project's text unchanged keeps the open Game Text index with its source and localization quality, instead of checking everything again. A rules document equal to the published one (a host's copy, or the same file reloaded) reuses the quality already computed for it.
- 430728c: Add the lightweight `@ue-shed/protocol/errors` subpath with the same error schemas as the root export. This entry point is additive. Reuse the shared guidance schemas across libraries and hosts; plugin distribution retains its independent fields with compile-time equality checks.

    Breaking: World preparation errors accept only the documented client and editor failure codes. Each code carries its own recovery guidance. Unknown producer codes fail contract decoding.

    Breaking: Niagara preview failures now require `nextStep` so hosts retain the next recovery action.

    Preserve Niagara session recovery, retry safety and next steps through preview error adaptation. Classify CLI plugin installation failures as input fixes, safe transient retries or escalation. Keep localization guidance host-neutral and add command hints in CLI output.

- Updated dependencies [7a756bb]
- Updated dependencies [742a808]
- Updated dependencies [430728c]
    - @ue-shed/unreal-assets@0.23.0
    - @ue-shed/localization@0.23.0
    - @ue-shed/protocol@0.23.0
    - @ue-shed/unreal-connection@0.23.0

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

- 1b811c4: Game Text searches run on cached row sets in the native engine, and a line's translator notes
  include its manifest entries' notes. `LocalizationFocusRequest` takes the list's `culture` or
  `cultures`, and `LocalizationFocus` returns the line's `problems` in that scope.
  `TextCorpusSearchRequest` gains `openGroups` and `firstRows`, and the workspace and native query
  gain `searchRows`, which returns a `TextCorpusRowsPage` (rows, or each open group's first rows)
  without computing counts, facets or groups. Read further pages and open groups with it.
- 5f6f15f: `workspace.related` reads a unit's or a target line's related members in one engine request
  (the `related` action): the units under its key, the units or lines with exactly its text, and
  with a target its key's conflicting units and its key change's paired line, each with its
  places and translations. The ID repair panel reads it instead of a text search and one focus per
  match.
- 91c03c9: Source and localization rules take an optional `label`, which their findings carry in place of the
  rule ID. `ruleLabelsOf(document)` names every rule a file lists by the rule ID its findings record.
  The rule editor has a Label field; Quality's rules overview and Browse's findings show the label. A
  line's findings now sit in the banner at the top of its page.
- A Game Text workspace host can set the policy and checkout behaviour a host such as Electroswag
  needs. `starterRules` is the rules file **Create rules file** writes. `prepareWrites` is called
  with every PO file a translation edit will replace, and with the review file a review change
  writes, before the first write, so a host can check them all out; a refusal writes nothing and
  fails with `file_unwritable` and the host's message. The operations host's `appName` names the
  host in recovery text. Polling an operation's state reads the last published scan through the
  new `operationStateTarget` and never starts a localization discovery. Scan progress reports
  `step` of `steps`.

### Patch Changes

- 704c68b: Correct Game Text's native source, String Table, compiled-copy, collapsed-PO and deleted-package
  facts. Missing String Table entries now report `string_table_entry_missing`. Retire the unused
  inline localization actions; maintained callers continue through the export and detail APIs.
- Updated dependencies [1f38a2e]
- Updated dependencies [f682dbc]
- Updated dependencies [1d62dd0]
- Updated dependencies [150caea]
- Updated dependencies [05c1ba5]
- Updated dependencies [704c68b]
- Updated dependencies [5f6f15f]
- Updated dependencies [07fd9e8]
    - @ue-shed/protocol@0.22.0
    - @ue-shed/unreal-assets@0.22.0
    - @ue-shed/localization@0.22.0
    - @ue-shed/unreal-connection@0.22.0

## 0.21.0

### Minor Changes

- 5ece9e8: Game Text caches are smaller. Integer and string-ID columns in `UESHT004` snapshots can use two new
  section codecs: zstd over the values' bytes grouped by significance, or over the differences of a
  non-decreasing column. The native writer picks per column by compressing a sample, and encodes a
  layer's sections in parallel; TypeScript readers decode both. Because older readers cannot, the
  cache namespace moves to `game-text-v2` and existing caches rebuild once. On a local UE 5.7
  project (~11k packages) the Game Text cache shrinks from 19.4 MB to 8.3 MB.
- 139aa75: Game Text classifies problems from one table. `TEXT_PROBLEM_RULES` says which localization states,
  facts, unknown reasons and review signals raise each problem; `textProblems` reads it and the
  native engine compiles a table generated from it, so filters, groups, aggregates and counts agree
  with the labels. A parity test runs both over the same lines, with and without finding clauses.
    - New problem `unchecked` ("Couldn't check"), after the findings and before up to date: a culture
      in scope whose state the evidence cannot prove. Up to date now means every culture in scope was
      confirmed. `TextProblemCounts` gains `unchecked`.
    - "Not found in the project" counts as `changed_since_gather` rather than up to date.
    - Findings follow the request: by default `shared`, `duplicate_source` and `unresolved` make a
      finding, not `long`. A `finding is` clause or lens that names a signal counts it as a finding for
      every problem in that request. Search rows (units and localization lines) carry `problems` and
      `countedFindings`, what put the row in its problems; `countedFindings()` and
      `textCountedFindings()` give the same in TypeScript.
    - The localization gate still reports changed text from the `changed_since_gather` state, so not
      found lines stay `removed`.

- 139aa75: One saved unit per key Unreal translates. Units key resolved text by the namespace without its
  package marker (`unreal:<gathered namespace>:<key>`), as gathered text does; String Table entries
  and references keep theirs. Text saved under one key in several packages is one unit with all its
  places, and its `shared` signal no longer shows on a unit with one place. Occurrences keep the full
  saved namespace. Unit IDs of such text change, so joined caches rebuild once (`joined-native-v3`);
  saved selections by unit ID of multi-package keys need their new ID.
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
- ad955ec: Localization runs and Game Text carry-over are usable from a host's own code.
    - `makeLocalizationOperationsLayer({ auditLimits })` sets the bounds of the before/after write
      audit of a commandlet run. The defaults, `defaultLocalizationAuditLimits` (100,000 entries,
      512 MiB per file, 2 GiB in total), are unchanged; raise them for projects whose audited files are
      larger. `LocalizationOperationsLive` keeps the defaults.
    - `makeLocalizationOperationsTestLayer` provides a complete operations implementation for tests.
    - `localizationCarryChanges(before, after)` from `@ue-shed/game-text/corpus` turns the keys a gather
      changed into change-set entries for the new keys, as `ue-shed loc run --carry` does.
    - `GameTextIdRepairsApi` from `@ue-shed/game-text/workspace` names the ID repair workflow type.

- b77e2e3: A saved Game Text index can be reopened without rescanning.
    - `GameTextIndexSteps.openCommitted({ projectRoot, targetName? })` opens an already committed view
      and returns `None` when there is none to use, without reading packages or rebuilding.
    - The workspace's `configuredRefresh(false)` uses it to show a saved index at once. Its completed
      result then carries `cached: true` (optional on `TextCorpusQueryRunResult`). The cached view can be
      browsed and searched, but quality rules, operation targets and investigation exports wait until a
      refresh has checked it against the current Project Index. A refresh replaces it.
    - The native engine reports the ID index's load and build seconds separately in `stage_seconds`
      (`id_index_raw_*`, `id_index_line_*` and `id_index_unit_lines_*`).

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

### Patch Changes

- 8a614e0: Build cold Game Text indexes faster with the same results. The native writer encodes a cold
  batch's new layers concurrently, the full join orders units and lines with precomputed collation
  keys and builds place keys in parallel, and joins report `join_*` stage seconds. Cold package
  imports for the native writer skip preparing sorted string runs it never reads, and start fewer
  workers, sized to the packages read, while the reader is still extracting.
- 3d34810: Native Game Text build sessions reuse writer processes. `nativeIndexBuilderLayer` keeps up to four
  `uasset` writer processes, each exiting after 30 seconds unused, so a rescan's back-to-back
  sessions no longer start a process each. A process serves another session only after its `end`
  succeeded, which releases the native writer lease and its file lock; a failed command, a failed
  `end` or an interruption discards it.
- Updated dependencies [9d91e8e]
- Updated dependencies [19c9412]
- Updated dependencies [ad955ec]
- Updated dependencies [1d22faa]
- Updated dependencies [4a25d69]
- Updated dependencies [05f4e1a]
    - @ue-shed/unreal-connection@0.21.0
    - @ue-shed/protocol@0.21.0
    - @ue-shed/unreal-assets@0.21.0
    - @ue-shed/localization@0.21.0

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
- Updated dependencies [09972f9]
- Updated dependencies [f7e366f]
- Updated dependencies [bc3e398]
- Updated dependencies [68737a3]
    - @ue-shed/protocol@0.20.0
    - @ue-shed/unreal-connection@0.20.0
    - @ue-shed/unreal-assets@0.20.0
    - @ue-shed/localization@0.20.0

## 0.19.0

### Minor Changes

- 207cc44: Extend native Game Text queries with exact source filters, every stored review signal,
  source groups and minimum group sizes. Preserve exact UTF-16 values across filtered reads.
- Add aggregates over matching rows, projected localization fields, named-unit reads, corpus
  headers, bounded report headers and a cached corpus fingerprint.
- Move progress reports, baselines, changed-file gates, CSV exports and investigations onto index
  reads. Existing whole-input functions remain available.
- Index line and unit IDs and use a separate bulk reader to keep interactive searches responsive.
  Release failed bulk acquisitions immediately while retaining the interactive fallback.
- Improve localization quality scans and evidence reads; expose stage and worker timings.
- Hosts implementing the query contract must provide the new read methods. Pass a model revision
  callback as the first argument to `makeGameTextWorkspaceLocalization`.
- Export `TextCorpusReportHeader` and `textCorpusReportHeader` for host implementations.

### Patch Changes

- 64d95f3: Add a `translation_key` search filter clause that selects text by the gathered namespace and key
  Unreal translates it by: saved FText without its package marker, String Table entries with their
  table namespace. Values are `JSON.stringify([namespace, key])`, as the newly exported
  `gatheredIdentityKey` writes them. With a target it matches that line; without one, every saved
  unit gathered under the key, so Blueprint copies saved under different package markers no longer
  need a client-side scan of `conflicting_source` lines. Native search, the TypeScript reference and
  counts, facets and groups agree on it.
- @ue-shed/localization@0.19.0
    - @ue-shed/protocol@0.19.0
    - @ue-shed/unreal-assets@0.19.0
    - @ue-shed/unreal-connection@0.19.0

## 0.18.0

### Patch Changes

- fc109a5: Route simple DataTable ID repairs through native Game Text when Authoring is absent. Use native
  Game Text for cell-key regeneration even when Authoring is present, since Authoring's cell commands
  cannot generate new keys. Admit the narrow key-repair capability independently of full localization
  authoring. String-table migration
  project checks use Core's projectRoot fact or an explicit host callback without editor-world
  control. Preserve receipts, expected-value checks, session binding and saved-file verification.
- 81fa128: Read saved Blueprint graph pin text on UE 4.27 and UE 5.6–5.8, retaining Unreal identities and
  addressable pin locations. Report skipped or rejected graph pin streams as partial coverage even
  when the package gather table omits their text. Match native subobject paths during saved repair
  verification. Re-extract cached package text on the next refresh so existing scans gain pin text.
  Join compiled Blueprint literals to matching saved pin identities within each package, preserving
  both occurrences and keeping different sources or unread pins separate.
- Updated dependencies [b267701]
- Updated dependencies [fc109a5]
    - @ue-shed/protocol@0.18.0
    - @ue-shed/unreal-connection@0.18.0
    - @ue-shed/localization@0.18.0
    - @ue-shed/unreal-assets@0.18.0

## 0.17.1

### Patch Changes

- @ue-shed/localization@0.17.1
    - @ue-shed/protocol@0.17.1
    - @ue-shed/unreal-assets@0.17.1
    - @ue-shed/unreal-connection@0.17.1

## 0.17.0

### Minor Changes

- e460f41: **Breaking:** `@ue-shed/game-text` has focused entry points with named exports only, and its storage internals are private.
    - New entry points: `@ue-shed/game-text/schema`, `/rules`, `/checks`, `/labels` and `/corpus` (browser-safe), and `/index` (Node: `TextCorpus`, index steps and layers, retained index, rules-file IO, errors, progress, native builder and text actions).
    - The root `@ue-shed/game-text` and `@ue-shed/game-text/browser` still re-export every public name, by name, and are deprecated. They will be removed in a later release.
    - No longer exported: the compact snapshot codec (`snapshot-format`), `SnapshotStore` and its layer, `SharedIndex` and `sharedIndexNodeLayer`, the joined-target readers (`openJoinedTarget`, `hydrateJoinedTarget`, `inspectJoinedTarget`, `refreshJoinedTarget`), the package-text record, column, layer, candidate and cold-pool helpers, `decodeLocalizationSnapshot`, `defaultLocalizationImportLimits` and `localizationShippedTranslation`. `SnapshotStoreError` and `SnapshotFormatError` are still exported from `/index` because public index signatures name them.
    - Game Text no longer re-exports other packages' types: import `InvestigationFileResult` and `InvestigationFormat` from `@ue-shed/unreal-assets/investigation`, and `LocalizationReviewFlag` from `@ue-shed/localization/browser`.

    Migration: replace `@ue-shed/game-text` and `@ue-shed/game-text/browser` imports with the entry point that exports each name; the package README lists what each entry point holds. Hosts that used the private storage modules directly should go through `/index` (`gameTextIndexStepsLayer`, `gameTextIndexRefreshLayer` and the retained index) instead; open an issue if a needed capability is missing there.

    The focused entry points retain the newer v3 rules, scoped/custom checks, domain parsers, unified progress, native builder and text-action APIs. Pure package text diffs are exported from `/corpus`; pass the owning reader record's file path to `/index`'s `gameTextActionForOccurrence`.

- 7a2c80e: Ship the Game Text workspace as a library: `@ue-shed/game-text/workspace` exports `makeGameTextWorkspace(host)`. It is the scanning, search, quality-rules, localization, edit, review, report and investigation orchestration that Workbench used to keep to itself. A host supplies:
    - its selected project (`project`), which the workspace reads and never changes;
    - file hooks (`files`), so every rules file, report, line export and investigation file goes through the host's writable-file hook;
    - `rulesRelativePath`, the rules location;
    - `recoveryCopy`, which receives a rules file's previous bytes before it is overwritten;
    - `localizationFiles`, the file access for PO and review writes;
    - the `reviewer` and `changeAuthor` policies.

    `makeGameTextOperations(host)` runs Unreal's localization steps (plan, run, cancel, changed files) for the same workspace, with hooks for the explicit engine root and progress notification.

    A scan now belongs to the workspace's scope, so it keeps running when the request that started it is interrupted, and a later request for the same project generation joins it. Workbench now runs on this entry point.

    The `WorkbenchOperation*` schemas and types are renamed `GameTextOperation*`. The old names remain as deprecated aliases in `/schema` and the deprecated root and `/browser` aggregates.

    Migration: hosts that copied Workbench's Game Text services can replace them with `makeGameTextWorkspace`, and should switch `WorkbenchOperation*` imports to `GameTextOperation*`. The workspace exposes the latest presentation state through `progress()`; pipeline operations use `GameTextIndexProgressReporter`. Starter writes honor host-exclusive creation, and recovery reads/copies fail closed before replacing attached rules.

- 49cf8f0: `gameTextIndexSourceNodeLayer` now splits a read into reader requests that each fit the native reader's 4 MiB request frame, so a host can hand it every selected package of a large project without batching the paths itself. Each batch is signature-verified before and after its own read and emits its own `text_summary`.

    `@ue-shed/unreal-assets` exports the frame limit as `MAX_PROTOCOL_REQUEST_BYTES`, the default per-request path budget as `MAX_PROTOCOL_PATH_BYTES`, and `batchProtocolPaths(paths, maximumPathBytes?)`, which splits package paths into ordered batches that fit one request.

    The oversized-request `contract` error now says `split package paths with batchProtocolPaths`.

    Migration: hosts that batched paths before calling the Game Text index source can pass the whole selection instead. Hosts that call `extractProjectTextPackages` directly with many paths can use `batchProtocolPaths` instead of their own limit.

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

- f8af84c: **Breaking:** Game Text's exported result decoders are unary domain parsers. They fail with the new `GameTextResponseError` (`code: "invalid_response"`, `message`, `recovery`, `retrySafe`, and the schema issue as `cause`) instead of Schema's parse error:

    | Removed                             | Use                                |
    | ----------------------------------- | ---------------------------------- |
    | `decodeTextCorpusRunResult`         | `parseTextCorpusRunResult`         |
    | `decodeTextCorpusQueryRunResult`    | `parseTextCorpusQueryRunResult`    |
    | `decodeTextCorpusSearchResult`      | `parseTextCorpusSearchResult`      |
    | `decodeTextCorpusFocusResult`       | `parseTextCorpusFocusResult`       |
    | `decodeTextQualityQueryRunResult`   | `parseTextQualityQueryRunResult`   |
    | `decodeTextQualityRuleUpdateResult` | `parseTextQualityRuleUpdateResult` |
    | `decodeTextQualitySearchResult`     | `parseTextQualitySearchResult`     |
    | `decodeTextQualityFocusResult`      | `parseTextQualityFocusResult`      |
    | `decodeTextQualityReport`           | `parseTextQualityReport`           |

    `TextCorpusScanOptions` limits (`concurrency`, `maximumAssets`) are the branded `TextCorpusScanLimit`. The brand carries the positive-integer check, so `TextCorpusService.scan` and `scanFromProjectIndex` no longer decode their typed options a second time. `parseTextCorpusScanOptions` checks options from an untrusted source once, and fails with `TextCorpusScanError` code `invalid_options`, not the old mislabelled `scan_limit_exceeded`.

    Migration:
    - Rename `decode*` to `parse*` from the table. Handle `GameTextResponseError` where you handled a `SchemaError`.
    - Build scan limits with `TextCorpusScanLimit.make(n)`, or parse untrusted options with `parseTextCorpusScanOptions(...)` before calling `scan`.

- a26dd7a: **Breaking:** Game Text reports progress one way. `GameTextIndexProgressReporter`, which index refreshes already used, is now the only mechanism, and `GameTextIndexProgress` gains the phases `corpus`, `localization_quality` and `source_quality` and an optional `findings` count.
    - `localizationQuality` and `sourceQuality` no longer take an `onProgress` callback. `LocalizationQualityProgress`, `SourceQualityProgress` and `IndexedSourceQualityOptions` are removed, and `IndexedLocalizationQualityOptions` is now the check options alone.
    - `TextCorpusService` no longer has `progress()`, which polled one shared state, so concurrent scans overwrote each other's progress. Scans now report `corpus` events instead.
    - `localizationQuality` and `sourceQuality` are required on `GameTextIndexRefreshResult`, and both take the rule document first: `localizationQuality(ruleDocument?, options?)` and `sourceQuality(ruleDocument)`. `indexedLocalizationQuality` takes `(joined, corpus, evidence, rows, ruleDocument?, options?)`; `indexedSourceQuality` takes `(joined, corpus, ruleDocument)`.

    Migration:
    - Replace `result.localizationQuality(options, document)` with `result.localizationQuality(document, options)`, and `result.localizationQuality({ review })` with `result.localizationQuality(undefined, { review })`.
    - Drop the `!` on `localizationQuality` and `sourceQuality`, and remove any fallback to the in-memory checks. An adapter that builds its own index result implements both, for example with `localizationQuality(checkLocalizationTarget(...), join)` and `textQualityQuery(evaluateGameTextSourceQuality(corpus, document))`.
    - Replace `{ onProgress }` and `TextCorpusService.progress()` polling with `effect.pipe(Effect.provideService(GameTextIndexProgressReporter, (progress) => ...))`. Read `completed`, `total` and `findings` instead of `checkedLines`, `totalLines`, `checkedTextUnits` and `totalTextUnits`.

- 00a0a16: Add version 3 of the Game Text rule file. A v3 file sets each built-in check's policy under `checks`, keyed by check ID: `enabled`, `severity`, `scope` (roles, cultures, object path prefixes) and `params` (the catalogue's parameters, every field defaulted), over a `preset` of `default` or `none`. Version 3 rejects unknown keys, so a misspelt check or parameter is an `invalid_structure` error, and a v3 file may hold check settings alone. Checks now read their thresholds, word lists and severity from the resolved settings: `resolveLocalizationChecks(document)` returns them, and `migrateGameTextRuleDocument(document)` rewrites a v1 or v2 file as v3 with the same behaviour. The tag and argument lists become parameters of the checks that read them (`optionalTags` on `rich_text_tags` and `rich_text_tags_added`; `optionalArguments` on those two and on `format_arguments`, `format_argument_renamed` and `rich_text_tag_case`), and `segmentSeparator` becomes `segment_separator`'s `separator`. V1 and v2 files keep loading with the same findings. Reports' `ruleDocumentVersion` can now be 3. Scope is decoded and validated (unknown roles are `unknown_role_id`) but is not applied to findings yet: that comes with scoped checks.

    **Breaking.** `quality-rules-v2.ts` is renamed `game-text-rules.ts`. Package-root imports are unchanged; deep imports must follow the rename. `GameTextRuleDocument` gains a third member, `TextQualityRuleDocumentV3`, and `LocalizationLineCheckContext` replaces `segmentSeparator`, `optionalTags` and `optionalArguments` with `checks` and `lists`. `localizationTranslationVariants` takes the `inconsistent_translation` parameters as an optional third argument. The rule-file error recovery text now names version 3.

    Migration: code that switches on `document.schemaVersion === 2` to read `localizationRules` should test `schemaVersion !== 1`, because v3 has them too. Code that reads `segmentSeparator`, `optionalTags`, `optionalArguments` or `disabledLocalizationChecks` from a document should read `resolveLocalizationChecks(document)[id]` instead, which covers every version. To upgrade a stored v1 or v2 file, write `migrateGameTextRuleDocument(document)`.

- 815c185: Describe every built-in localization check in one catalogue. `localizationCheckCatalogue` gives each check its basis (`unreal` when the finding states what Unreal does with the text, `heuristic` when it is a judgment), label, default severity, parameter schema with defaults and a condition text generated from those parameters; `localizationCheckDefaults` lists the default parameters. The thresholds and word lists of `length_outlier`, `placeholder_translation`, `placeholder_text` and `inconsistent_translation` are now catalogue parameters instead of private constants, and the package README's check table is generated from the catalogue. `localizationRuleId(id)` and `parseLocalizationRuleId(ruleId)` convert between a check and its `localization.<id>` rule ID. Findings, their severities and IDs are unchanged, except that a placeholder phrase must now start at a word boundary (`xlorem ipsum` is no longer a match).

    **Breaking.** `checkSeverity` and `workspaceQualityLabels` are removed. Migration: read `localizationCheckCatalogue[id].severity` instead of `checkSeverity[id]`, and `workspaceQualityLabel(filter)` (or `localizationCheckCatalogue[id].label`) instead of `workspaceQualityLabels[filter]`; the `character_budget` and `terminology` rule kinds are in `projectRuleKinds`. Replace hand-written check descriptions with `localizationCheckCatalogue[id].defaultCondition`, and string handling of `localization.<id>` rule IDs with `parseLocalizationRuleId`.

- 13ed5b7: Publish changed package records through the native index without decoding unchanged shard
  records in JavaScript. Reuse localization dictionary blocks, coordinate target preparation
  under one writer session, persist incremental summary counters, and share scoped readers
  of the same validated revision. Package replacement requires uasset-io protocol 1.16.
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

- 3d77427: Compare the text of two copies of one package. `diffPackageText(before, after)` takes two package text records (for example the depot's head revision and the local file) and reports added, removed, re-keyed and edited text place by place, matching places by their position inside the package rather than the package's saved name, and says when either copy was read only in part. Additive; no migration needed.
- 7829db3: Apply each built-in check's rule-file scope. A v3 check's `scope` (`cultures`, `roles`, `pathPrefixes`) now limits where its findings are reported, in reports and in indexed scans alike. It is applied after the check finds something, so a line's saved places are read only for scoped findings. A finding without a saved place is outside any role or path scope. `localizationCheckInScope` exposes the same test. When one check's finding takes the place of another's, the first check now takes it only when it runs and is in scope for the line and culture, so an out-of-scope or disabled check never hides an in-scope one. The three cases are a placeholder translation instead of its `length_outlier`, missing tags instead of `rich_text_tags_added`, and a `format_argument_renamed` pair instead of a dropped and an added `format_arguments` name.

    **Breaking (findings).** Unscoped files only change when a check is disabled. With `format_argument_renamed` disabled, `format_arguments` now reports the dropped and the added argument instead of nothing. With `rich_text_tags` disabled, `rich_text_tags_added` reports added tags even when tags are also missing. `LocalizationLineCheckContext` gains `roles`. Migration: a host that disabled `format_argument_renamed` or `rich_text_tags` to silence those findings should also disable `format_arguments` or `rich_text_tags_added`.

- 49021d4: Store each localization finding's severity. Indexed quality scans now keep a severity column beside each finding's packed facts, and groups carry their severity. Workspace ordering (`severityAt`), `severityCounts` and summaries read the severity a finding was reported with, so a rule file's per-check `severity` shows in indexed workspace pages exactly as in reports. Before, pages re-derived severity from the check's default. Version-2 and version-3 `localizationRules` accept an optional `severity` (`normal` when absent), which their findings carry.

    **Breaking.** `LocalizationFindingList` requires `severity(position)` and `LocalizationFindingGroup` requires `severity`. Migration: a host that implements its own finding list should return each finding's `severity` (`finding.severity` for localization and policy findings), and give each group the severity its findings share.

- c0535da: Let a rule file define its own localization checks. Version-3 rule files take up to 512 `customChecks`, reported beside the built-in checks with the same evidence, review marks and workspace model:
    - `pattern`: a regular expression the text matches, or does not match
    - `length`: a minimum or maximum, in visible or code-point characters
    - `forbidden_term`: terms matched as the terminology rules match them

    Each check runs on the source or on each translation and has its own label, severity, recovery text and scope (cultures, roles, object path prefixes). Findings are the new `LocalizationCustomFinding` (`kind: "custom"`). Reports list the checks in `customChecks` and count them in `rules`.

    The workspace filter list is no longer closed:
    - `WorkspaceQualityFilter` accepts `custom.<id>` (`customQualityFilter`) beside `BuiltInQualityFilter`.
    - Pages list the file's checks in `customFilters` and count them under `counts["custom.<id>"]`.
    - `workspaceQualityLabel(filter, labels)` names them, and the Workbench quality view shows them as filters.

    Indexed scans store each finding's rule in its own column and pack the filter into 19 bits, which lifts the 8,192-rule and 64-filter limits of the packed facts.

    **Breaking.**
    - `WorkspaceQualityFilter` is now a union, so it has no `.literals`; use `BuiltInQualityFilter.literals`.
    - `LocalizationQualityReport.findings` and the workspace `Finding` union gain `LocalizationCustomFinding`.
    - `WorkspaceQualityPage` requires `customFilters`.
    - `LocalizationCheckScope` and `localizationCheckInScope` moved to `localization-check-scope.ts`, so deep imports must follow. Package-root exports are unchanged.
    - Code that switches exhaustively on finding `kind` must handle `"custom"`.

    Migration: replace `WorkspaceQualityFilter.literals` with `BuiltInQualityFilter.literals`, and add the page's `customFilters` where filters are listed. Handle `kind: "custom"` where findings are rendered: `label`, `actual.text` and `actual.matches` describe the finding.

### Patch Changes

- d61f66a: Read the text literals compiled into Blueprint functions. The reader now walks every saved `UFunction`'s script bytecode (UE 4.27 to 5.8) and reports each distinct `EX_TextConst` as a `ScriptBytecode[N]` place, with UE 5.8's renumbered literal types and translator notes, so Print Text and other graph literals that Unreal gathers are no longer silently missing; a script the walk cannot follow is a decode error. Function parameters of delegate and field-path types are now read too. Game Text classifies compiled literals as player text (`script_bytecode`).
- 7770afc: Game Text scans read an external actor or object package only when its saved header says it holds gatherable text, as Unreal's gatherer does. Before, every external package and its world were read. On a large World Partition project this cuts a scan from 429,625 packages (16.4 GB) to 9,056 (4.7 GB). Projects without external packages select the same packages as before.
- 8508a74: Index steps and the refresh layer take `qualityWorker: true`, which runs localization quality scans in a worker per opened model instead of on the host's thread. The returned `LocalizationQuality` behaves the same: facts and groups are local, and `items`, `find`, `lineOfUnit` and `sourceKeyOfUnit` read the worker's scan synchronously. Progress callbacks and interruption work as before. If the worker cannot start or fails, the scan runs on the host. The option is off by default; the Workbench turns it on. New exported type: `GameTextIndexStepsOptions`.
- 29547d4: With `searchWorker: true`, `openTarget` no longer prepares the query on the host's thread. The search worker prepares it once, and the model's synchronous `query` methods borrow the worker's query: each call blocks until the worker answers. Before, the host prepared the same query a second time while blocking its event loop (about 1.15 s on a large project). If the worker has died, the next synchronous call prepares the query on the host instead, so an open model keeps working. Hosts without a search worker are unchanged. Superseded later in this release: the search worker and `searchWorker` option are removed. Join place-label lookups now read strings in batches of 1,024 instead of 8,192, so one batch no longer holds the host's event loop for long. No API changes.
- 4ddae8e: Views of one opened index share its decoded columns and its synchronous reader. Before, the query, the corpus, the localization evidence and each quality scan each kept their own column cache and their own patch and chunk caches. Synchronous string lookups no longer rebuild the segment start list on every lookup, and a lookup in the same 64-string block as the one before reuses that block directly. Quality scans and line reads go through these lookups for every line. No API changes.
- a99f233: The package text refresh, the full join and the localization quality scan report their stages as span attributes (`package-text.stage_ms.*`, `join.stage_ms.*`, `game_text.quality.stage_ms.*`). Each one is the wall time of one stage of that step in milliseconds, so a host's tracer can show where a build or a scan spends its time. No API changes.
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

- dbdb40f: Reuse bounded native search aggregates within each immutable reader and select cursor pages from
  ordered row IDs without copying every match. Keep namespace groups and filters consistent with
  unresolved saved text whose localization key is empty.
- 751afa2: Index native Game Text occurrence, source-value and String Table dependencies separately. Stable
  text edits locate affected groups and duplicate-source dependencies through native reverse indexes;
  reference and identity changes retain their structural rebuild path. Retained-base undo reuses the
  immutable base without rebuilding it. Dependency transactions are tied to the published revision
  and dictionary generation, and interrupted updates roll back or reconstruct the disposable graph.
  Package byte-size changes retain their updated evidence without forcing a membership rebuild.
- 75a12e4: Accelerate uncached native Game Text searches over unique folded sources and localization counts.
  Prepare the persisted source arena before the query reader is ready, with explicit stage timing,
  while preserving substring, Unicode, translation search and incremental snapshot behavior.
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
    - @ue-shed/localization@0.17.0
    - @ue-shed/unreal-connection@0.17.0

## 0.16.2

### Patch Changes

- 2c8f29b: Index builds no longer block the host's event loop for seconds. On a cold scan of a large project the
  longest block fell from about 13 s to about half a second, so a server host keeps answering progress
  and other requests. Index steps run on a scheduler that yields once the event loop has gone 16 ms
  without a turn, and the long synchronous passes (duplicate places, query columns, query places, locale
  sorts, package selection and the inventory sort) yield between bounded slices. Opening the finished
  query model is unchanged and can still block for up to about a second.
- @ue-shed/localization@0.16.2
    - @ue-shed/unreal-assets@0.16.2

## 0.16.1

### Patch Changes

- 865af31: Quality workspace findings name the first place they affect (`location`) and how many places they affect (`locations`), so hosts can show a place instead of the key.
- f58a14a: Reduce full joined-index build time by sharing duplicate-source analysis, counting only shared-source candidates, and hashing canonical place columns with exact collision checks.
- ab5973d: Keep incremental duplicate-source updates fast with numeric occurrence sources and source-group
  invalidation while preserving same-place exclusions and unresolved identity handling.
- f403603: Quality workspace pages no longer build every source finding up front.
- a156e06: Require duplicate-source counterparts to have a different identity and a different place, so re-keyed text does not pair with its own old manifest or saved key.
- 5915876: Measure long-text review signals and source counts on the longest individual source variant.
- f8e067f: Match literal terminology on Unicode letter, mark and number boundaries in source and translation rules, avoiding matches inside words (including beside combining marks) while preserving case handling, phrases and punctuation.
- 636f5db: Exclude text without a resolved key from both sides of duplicate-source review signals.
- @ue-shed/localization@0.16.1
    - @ue-shed/unreal-assets@0.16.1

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

- 4feb679: Rate Game Text checks by severity and add translation shape, source and consistency checks.
    - Every localization finding has a `severity` (`blocking`, `normal` or `low`) from
      `checkSeverity`, outside its ID. Workspace pages list blocking findings first and count findings
      by severity in `severityCounts`; summaries, focus and CSV exports carry it. Blocking:
      `outdated_translation`. Low: `duplicate_source`, `missing_translator_notes`,
      `number_only_text`, `rich_text_tag_case`, `rich_text_tags_added`, `source_line_endings_changed`,
      `source_whitespace` and `culture_invariant_text`.
    - New translation checks: `format_argument_renamed` (split from `format_arguments`, which now
      reports only dropped and added arguments; the one-rename fix moves with it), `rich_text_tags`,
      `rich_text_tags_added`, `rich_text_tag_case`, `line_breaks` (split from `whitespace`, which now
      compares edges only), `segment_separator`, `length_outlier`, `placeholder_translation`,
      `outdated_translation`, `source_line_endings_changed` and `inconsistent_translation`. Shape
      checks, `format_arguments` and `argument_modifiers` included, skip empty translations, which
      `empty_translation` reports.
    - New source checks that need no rule file, in `SourceCheckId`: `culture_invariant_text`,
      `placeholder_text`, `source_whitespace`, `source_markup`, `number_only_text` and
      `string_table_key_collision`. `BuiltInCheckId` names every built-in for `checks`,
      `disabledChecks`, `disabledLocalizationChecks` and `loc check --check`.
    - Rule files (v1 and v2) take optional `segmentSeparator`, `optionalTags` and `optionalArguments`.
    - `culture_invariant_text` reports only player text outside debug content and text render
      components, in a property that holds at least as much localizable text in the project.
    - A quality workspace that lists source findings too shows a placeholder once: it leaves out a
      `placeholder_text` finding a source terminology finding already covers. The check records
      which placeholders the rule file's terminology leaves (`unreportedMatches`), so the workspace
      decides from the scan's facts without rechecking findings.
    - Indexed scans build a line's units only for its findings, read translator notes and String
      Table entries from occurrence columns, and halve slow pages, so a key saved in thousands of
      places no longer stalls the scan for seconds.
    - `duplicate_source` reports once per shared text and leaves out text without letters.
    - Keys with conflicting saved texts list them in `sourceVariants` on findings, summaries and focus
      instead of the joined text, and are not compared or grouped by it.
    - `checkLocalizationTarget` also checks a line whose saved text is blank when its manifest has the
      source, as a partly read package can leave it, so its empty archive entries are reported.

- cca640f: Evaluate source quality rules over the Game Text index.

    An opened index model's `sourceQuality(ruleDocument, options?)`, also exported as
    `indexedSourceQuality(joined, corpus, ruleDocument, options?)`, returns the `TextQualityQuery`
    that `textQualityQuery(evaluateGameTextSourceQuality(corpus, ruleDocument))` gives, with the same
    summary, pages, cursors, focus, export and finding IDs. It reads roles, character budgets and
    terminology page by page from index columns, never builds the corpus's units, keeps each finding
    as a few numbers and rebuilds only the findings a page, focus or export returns. The scan yields
    between pages and can be interrupted; `onProgress` receives `SourceQualityProgress`
    (`{ checkedTextUnits, totalTextUnits, findings }`) once before the scan and after each page.
    `evaluateGameTextSourceQuality` and `textQualityQuery` keep their contracts for hosts without an
    index. `textQualityQueryOf(report, list)` builds the query over any finding list.

    Roles match a place by its own location. A folded Blueprint place's copies never match by their
    compiled paths (`X_C`, `Default__X_C`, `SKEL_X_C`); write roles against the authored path.

### Patch Changes

- d3430c8: Report progress from the indexed localization quality scan.

    An opened index model's `localizationQuality` options take `onProgress`, called with
    `LocalizationQualityProgress` (`{ checkedLines, totalLines, findings }`) once before the scan and
    after each 256-line page, so hosts can show how far a long scan has got. Results are unchanged.

- Updated dependencies [dbb471e]
- Updated dependencies [7d925d7]
- Updated dependencies [6608e6a]
    - @ue-shed/unreal-assets@0.16.0
    - @ue-shed/localization@0.16.0

## 0.15.0

### Minor Changes

- 8620750: Report source-level localization findings once per line instead of once per culture. The default
  Quality list changes.
    - `missing_translator_notes` and `duplicate_source` describe the source line, so each now reports
      once per line. The finding belongs to the target's native culture, or the line's first culture in
      the target by code when it has no native one. The all-cultures list counts each line once;
      selecting the native culture shows them; selecting another culture does not. Counts, rule
      summaries, search, export and focus follow, on both `checkLocalizationTarget` and the indexed
      `localizationQuality` scan. The default check set is unchanged; hosts choose checks with
      `checks`, `disabledChecks` or a rule document's `disabledLocalizationChecks`.
    - Saved state still loads: presets that select either filter keep it, and review files keep their
      accepted findings. An acceptance of either check recorded under a non-native culture no longer
      matches a finding and has no effect.

### Patch Changes

- d88c4e7: Keep Unreal's full object paths on Game Text occurrences from UE 4.27 packages. UE 4.27 usually saves
  `None` as a package's name, so the reader names that package's objects relative to it
  (`DT_InventoryItems` rather than `/Game/Data/DT_InventoryItems.DT_InventoryItems`). Role matchers on
  `object_path` and same-package `class_path` values then matched nothing, so source and localization
  rules found nothing on 4.27 projects, and String Table references and key changes could not find
  their entries.
    - The corpus and the index now complete package-relative object paths, class paths and coverage
      gap paths from the package file under `Content/`, which Unreal mounts at `/Game`. Paths that are
      already complete are unchanged.
    - The package text cache format is now `package-text-v3`. Existing caches read their packages again
      on the next refresh instead of reusing stored package-relative paths.
    - Text units without a localization key are identified by object path, so their IDs change on 4.27
      projects.

- 402fa50: Building a full Game Text join no longer fails with `Segment was not requested` when the join's
  source strings were already published in the shared index. The joined source cache now loads the
  string segments it reads instead of relying on the caller to have loaded them first.
- @ue-shed/localization@0.15.0
    - @ue-shed/unreal-assets@0.15.0

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
- 10babde: Check localization quality over the index instead of rebuilding the whole target as objects.
    - An opened index now offers `localizationQuality(options, ruleDocument)`. It checks lines in
      bounded pages and keeps findings as columns. Pages, focus and proposals re-check only the rows
      they show.
    - `localizationQualityWorkspaceOf(source, quality)` builds the same workspace over either form;
      `localizationQuality(report, join)` is the in-memory form for adapters without an index.
      `localizationQualityWorkspace(source, report, join)` is unchanged.
    - `checkLocalizationLine` and the per-line policy and accepted-finding helpers expose the checks
      `checkLocalizationTarget` runs, one line at a time.
    - Localization finding IDs are now a fast hash of the finding's line, culture, rule and values.
      They stay stable across rescans of unchanged text; IDs from older versions do not resolve.

### Patch Changes

- 68d49c5: Read localization lines in bulk without re-decoding evidence for every entry.
  `localizationLines` used to hydrate one line per page. Each manifest, archive and PO entry
  re-decoded its file's metadata and zstd string blocks. On a 238k-line, 10-culture target that took
  over 40 minutes before it ran out of memory.
    - Bulk reads now hydrate rows in storage order, in pages of adjacent rows (bridging small gaps), and
      return them in the requested order.
    - Multi-line pages decode each evidence file's rows in sorted runs once per page.
    - Shared string lookups decode in ID order, so each block is decompressed once per lookup.

    Single-line browsing is unchanged.

- c075169: Hydrate localization lines and scan localization quality about twice as fast, in shorter pauses.
    - A page of lines reads its columns, evidence entries and strings once, then builds its lines
      without per-entry Effect or schema work.
    - Evidence entries read from the index are no longer schema-decoded one by one. The importer
      validates Unreal's files when it writes the index, and checksums guard the index's bytes.
    - The quality scan checks 256 lines per page and yields after each, and while it prepares line
      order. On a generated 583,507-line, 10-culture target the longest pause fell from 4–5 s to
      0.5–0.7 s, and the scan from about 205 s to 115 s.

- d8eca33: Upgrade Effect and its integrations to stable 4.0.4. Update renamed schema and configuration APIs,
  JSON Schema validation, synchronous cache queries, retained resource cleanup, and Remote Control
  response handling while preserving authoritative wire contracts and existing workflow behavior.
  Published libraries now require the application to provide `effect@^4.0.0` as a peer dependency,
  and `@ue-shed/observability` also requires `@effect/opentelemetry@^4.0.0`. Install these in the
  application (or reuse compatible existing versions) so UE Shed shares the application's Effect
  runtime. Workspace development and tests remain pinned to Effect 4.0.4 through the catalog.
- Updated dependencies [8f9bcf1]
- Updated dependencies [d8eca33]
    - @ue-shed/unreal-assets@0.14.0
    - @ue-shed/localization@0.14.0

## 0.13.0

### Minor Changes

- d3228d0: Tell missing localization files apart from unreadable ones. A manifest, archive or PO file the
  working copy does not have now reads "Not in this working copy: <path>" with a Gather or Export
  recovery, while files that exist but fail to read keep "could not be read" with their error code.
  Ready `LocalizationTargetResult` values gain optional `fileProblems` and `localizationFolder`;
  `WorkspaceReportPage` gains optional `gatherFilesMissing`, `gatherFileProblems` and
  `localizationFolder`. New exports: `LocalizationFileProblem`, `localizationFileProblems`,
  `explainLocalizationFile`, `localizationEvidenceFolder` and `localizationTargetFiles`.
  `localizationManifestFailure` accepts the manifest's relative path. The generic missing-evidence
  labels no longer claim a read failure.

### Patch Changes

- @ue-shed/localization@0.13.0
    - @ue-shed/unreal-assets@0.13.0

## 0.12.0

### Minor Changes

- 183dd2a: Expose optional, operation-scoped progress for saved package inventory, package extraction,
  localization file preparation, index construction and opening the joined index.

    Share package extraction and strings across a project's source and localization target indexes,
    retain independent joined target views, and reuse signature inventories within a committed
    Project Index generation.

    Expose project opening and refresh, localization import, target construction, and query opening
    as independently composable `GameTextIndexSteps`. Keep the existing refresh service as a
    compatibility wrapper, provide a retainer for host-owned compositions, and replace encoded
    target storage keys with explicit project views.

    Reject superseded localization observations, including failed inputs repaired by another target,
    without replacing the repaired joined view or retiring already pinned readers.

- 2c00f8b: Export localization quality findings with the selected target, culture, and check filter. Reports
  retain scan coverage, apply the target's review file, and presets replay the same selection
  through the CLI. A preset's `workspaceFilter` is accepted only in quality mode with a localization
  target. Completed quality results may report whether a rules file is attached (`ruleFile`) without
  exposing its path. Localization quality presets and exports use schema version 2, so older readers
  reject them instead of silently dropping `workspaceFilter`. Existing version-1 corpus and source
  quality investigations remain readable and retain their format when replayed.

### Patch Changes

- d99dcf6: Share scoped query workers across overlapping immutable index readers. Workbench prepares one
  target-first model for source and localization browsing, validates inputs before reusing it, and
  retains unchanged workers across rescans. Keep result rows and loaded pages stable with Solid 2 keys.
  Expose an optional opaque query identity on validated target handles and their opened models so
  hosts can reuse a model without constructing storage identifiers. Correct Game Text's Node range
  to `^22.15.0 || >=23.8.0`, matching the built-in Zstd APIs required by its Node entry point.
  Replace failed query workers on unchanged refreshes while preserving healthy sharing and existing
  reader pins; retiring a failed worker cannot evict its replacement.

    Reduce saved-text extraction working memory with bounded ordered native delivery and concurrent
    path validation. Keep package signature checks before and after reads while running them with
    bounded concurrency. Warm bounded query pages instead of every column, reduce source-arena
    retention, and accelerate Unicode search rejection, quality evaluation and raw-unit focus.

    Start cold localization parsing with input-size memory reservations rather than a blocking
    largest-file probe. Prepare bounded string-sort runs in workers, batch large cold package reads,
    convert larger staged layers in workers, and retain only two decoded identifiers while sorting
    joined query IDs. Small package sets and small layer mappings keep their existing preparation path.

    Persist a bounded optional source-query projection so reopened readers can reuse verified source
    bytes, ASCII flags and trigram membership. Preserve pinned readers and update the projection across
    source overlays. Match review records by numeric identity and sort joined identifiers in bounded
    locale runs with a stable merge.

- Updated dependencies [d99dcf6]
    - @ue-shed/unreal-assets@0.12.0
    - @ue-shed/localization@0.12.0

## 0.11.0

### Minor Changes

- 500a950: Check the text in a change's files before it is submitted. `localizationGateTarget` judges every
  line whose text lives in a list of changed files: a key change that would lose translations, one
  key with two texts, and translated text that changed fail by default; untranslated changes, text
  not gathered yet, text without a reliable key, removed text and changed source files warn.
  `localizationGateFailures` applies a project's `failOn` and `warnOn`, and `LocalizationGateResult`
  is the verdict across targets. The CLI exposes it as `ue-shed loc gate`.
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

- f38f36f: Add an injectable GameTextIndexBuilder capability and a TypeScript fallback layer for localization import, saved package text, dictionary maintenance and joined target publication. The shared refresh service uses the selected builder and retains published reader generations while inputs and review state refresh under one writer lease.

    Add a columnar implementation of the existing TextCorpusQuery API, including search, facets, filters, pages, focus and exports. Its private joined query projections rebuild derived caches under a new joined key. CLI and Workbench adopt it in this release with lossless WTF-8 string storage.

- 580442c: Serve CLI and Workbench Game Text queries from a shared column index through one refresh service
  and an injectable builder capability. Preserve existing pages, filters, facets, focus and reports;
  refresh changed packages and localization files, and invalidate affected layers after writes.
  Retain bounded reader generations and remove the large-heap setup requirement from the docs.
- 2f4a3aa: Store every Game Text index layer on one shared, append-only string store per project and
  target, with compaction once unused strings pass a threshold. Layers hold compact ID columns.
- 621f9f3: Add a compact Game Text snapshot format and a Node snapshot store. Sections are checksummed,
  compressed and loaded only when first used, and publishing is atomic under one writer lock.
  CLI and Workbench use the store through the shared refresh service in this release.
- 656ecf5: Import Unreal manifest, archive and PO files into Game Text snapshots by streaming, keyed by
  content hash, with a file-stat check that skips unchanged files without opening them. The PO
  parser exposes block decoding for streaming callers and takes a faster path for unescaped fields.
- fc996e5: Saved investigations can name a localization target. `GameTextInvestigationQuery` gains an
  optional `localization` selection, and `exportGameTextInvestigation` takes the target's query, so
  problem and translation filters export the lines the list shows; a preset that names a target
  whose files are not supplied fails with guidance instead of throwing. Key changes pair by text
  alone only when no other line on either side has that text, and baseline comparison follows the
  same rule.
- 82be00c: Filter Game Text by where text comes from. Search requests accept `where` with origin kinds
  (String Table, DataTable, asset, C++, other gathered source) and a path prefix, applied to saved
  units and gathered-only localization lines alike. Search counts add `origins`, which excludes the
  origin filter itself. `where.files` keeps the text a changed-file list touches, and the page's
  `fileScope` summarizes the list. `text-origin.ts` exports the pure classifiers and file helpers.

    Pair localization keys that changed with the key Unreal still lists: by the same saved place, the
    same text in the same asset, or text unique in the project, strictly one to one. Lines carry
    `keyChange`, selections accept `keyChanged`, and pages count new keys.

    Baselines record each line's manifest path, and baseline comparison reports `keyChanged` pairs
    instead of counting them as added and removed. `localizationKeyChangesAcross` pairs keys across
    a gather.

    Export one spreadsheet with every language: `localizationLinesCsv` writes a row per line with a
    translation and state column per culture, native first, missing translations as empty cells, in
    code-unit order. `textCorpusQuery` adds an unpaged `localizationLines(request)`.

- b6f65d6: Classify every line by problem and filter with clauses. `TextProblem` lists problems worst first
  (key changed, same key with different text, not gathered, changed since gather, translation work,
  finding, up to date), and search pages add `problems`, counted without the request's problem
  clauses. Requests accept `filter`, a list of `{ field, op: "is" | "is_not", values }` clauses over
  problem, finding, translation state, origin, folder, editing and translator notes; the existing
  request fields keep their meaning. Localization selections accept `cultures`, a culture set that
  scopes states, counts and translation work. `text-problems.ts` exports the pure classification and
  matching.

    Group and facet the matching lines. Requests accept `group` (problem, folder, asset, origin or
    namespace), `openGroup` and `facets`; pages add `groups`, worst first and bounded at 200 with a
    count of the rest, and `facets` with folders a level at a time, assets, origins and per-culture
    work. Clauses add `asset` and `namespace`. `text-groups.ts` exports the pure grouping, and
    `textFileLabel` spells a file the way the project does.

    Investigation presets accept optional `filter` and `group`; presets saved before them still open.

    Search requests accept `lines`, up to 5,000 localization line ids, to act on a selection.
    `localizationLinesCsv` accepts `cultures` and then keeps the native culture plus those columns;
    `pickedLocalizationCultures` reads the picked cultures from a localization selection.

    Joining a large localization target is much faster: a 50,000-line, 14-culture target joined in
    about 30 seconds and now joins in about 1.5 seconds, and per-culture counts take one pass.

- 9b08c67: Aggregate saved-text gaps by package without losing reader reasons, retain at most three samples,
  and count all undecoded properties. Add optional `coverageGapCounts` to corpus diagnostics while
  keeping corpus schema version 1. Bound report diagnostics and incomplete package lists to 200,
  with full totals and omitted counts in status, progress, quality and investigation output.

    Expose a browser-safe text coverage gap schema from Unreal Assets for corpus consumers.

### Patch Changes

- 982743f: Raise localization evidence and saved-reader limits tenfold, apply entry limits per file, and preserve read failure causes and recovery guidance in Game Text and the CLI.
- 8de142d: Add scoped worker-backed compact-index search for desktop and trusted Node hosts. Cancel replaced
  scans without evicting completed results, and reuse prepared WTF-8 source bytes for case-insensitive
  search. Preserve translations in schema-validated text-unit previews.

    Treat failed current localization inputs as unavailable instead of reusing historical layers.
    Preserve empty-source units in raw corpus hydration. Separate retained-model publication from
    reader retirement and keep outstanding query users pinned through replacement.
    Reject superseded desktop refreshes after localization cleanup and serialize model publication.

- bf14f9d: Add a persistent localization merge join over shared package and localization ID columns,
  including review state, key changes, problems and facets. Stable package source and PO edits
  refresh affected identities through a bounded overlay; other edits rebuild the join.
- 580442c: Preserve lone UTF-16 surrogates in every Game Text index string domain using canonical WTF-8. Disposable snapshot format v4 rebuilds older caches and rejects malformed or non-canonical byte sequences. Search, findings and joined query projections retain the original code units.
- f38f36f: Derive compact localization findings and facets from each gathered slice's searchable source and
  contexts. Split saved identities no longer leak long-text or conflicting-source findings, origin,
  editing capability, notes, files or folders into another line. Empty slices contribute no query
  facets. Older joined caches rebuild automatically; the public query contract is unchanged.
- d664bc2: Refresh stable package source edits incrementally when localization source conflicts are created,
  changed or resolved. Preserve full-rebuild states and query projections with bounded source-list
  patches over one retained base snapshot.

    Reuse immutable query columns and encoded source bytes across incremental refreshes while keeping
    patched values and older readers isolated. Rebuild the source search arena when reuse bounds are
    exceeded or the dictionary generation or full base changes.

- 580442c: Share typed localization failure recovery between the event reader and streamed index importer.
  Malformed manifests, archives and PO files retain the existing recovery guidance through indexed
  CLI and Workbench workflows, with file and position details from the streaming reader.
- 580442c: Match UE 5.7 and 5.8 localization loaders by rejecting escaped unpaired UTF-16 surrogates in manifests and archives. Both the event parser and streaming index importer report the file, character offset, and typed malformed-manifest or malformed-archive failure. Saved package strings remain lossless WTF-8.
- fb4a3ed: Add the package-text layer to the shared string store, with occurrence ID columns, per-package
  coverage and gap samples, signature-keyed refresh, parallel cold preparation, and a reusable corpus
  oracle adapter. Preserve unchanged packages and publish affected shards together atomically.
- af462fb: Preserve the native reader's sorted package-path order when folding conflicting localization sources from the compact index, including layer-hydrated corpora. Rebuild older joined layers automatically.
- 580442c: Expose bounded, generation-checked Project Index inventory pages with opaque package and sidecar signatures and saved header gather eligibility. Game Text refreshes use this committed inventory; Workbench reuses its project refresh instead of enumerating disk again.
- 02b5128: Match saved text carrying Unreal package namespaces to gathered localization identities, so
  translations, key changes, review fingerprints and gates use the same namespace and key as Unreal.
  Preserve full saved namespaces for asset inspection and detect shared identities and source
  conflicts across packages without false duplicate-source findings.
- a844652: Focus localization lines on their own saved occurrences, preserving corpus unit IDs and plain
  corpus focus while keeping detail sources, locations and review signals aligned with previews.
- Updated dependencies [982743f]
- Updated dependencies [1f01e74]
- Updated dependencies [6218a5c]
- Updated dependencies [580442c]
- Updated dependencies [580442c]
- Updated dependencies [580442c]
- Updated dependencies [23c8d9c]
- Updated dependencies [02b5128]
- Updated dependencies [67a611c]
- Updated dependencies [656ecf5]
- Updated dependencies [9b08c67]
    - @ue-shed/localization@0.11.0
    - @ue-shed/unreal-assets@0.11.0

## 0.10.0

### Minor Changes

- 8d812df: Add pure Unreal localization quality checks, provenance-bearing version-1 change-set proposals,
  and `ue-shed loc check` with optional exclusive proposal JSON creation.
- 980ad73: Add compatible v2 culture budgets and glossaries, archive progress reports, and versioned manifest
  source baselines. Expose `loc report` with exclusive baseline creation and preserve v1 source rules.
- bbe2501: Join saved text with read-only Unreal localization evidence by namespace and key. Add coverage-qualified
  per-culture states, bounded localization query pages, translation search, state and word counts, and
  file evidence reports. Preserve String Table translator comments alongside developer notes.
- 64976b1: Track localization review state in a project-owned review file per target. Records keep reviewed,
  proofread, approved and machine translated flags against a fingerprint of the source and the
  translation that ships next, so later edits read as changed since review. Game Text adds review
  lenses, accepted check findings and reviewed and proofread report shares.
- 271dcd1: Write reviewed translation change sets into PO files. Changes are revalidated against fresh
  evidence: the source must match the manifest, and the replaced translation must match what ships
  next. Only the edited `msgstr` values change, through an atomic, hash-guarded replace. Game Text
  adds browser-safe edit request and result schemas for hosts that stage edits.

### Patch Changes

- Updated dependencies [8d812df]
- Updated dependencies [f66ac19]
- Updated dependencies [bdbcaec]
- Updated dependencies [64976b1]
- Updated dependencies [271dcd1]
    - @ue-shed/localization@0.10.0
    - @ue-shed/unreal-assets@0.10.0

## 0.9.3

No direct behavioral change. Align with the UE Shed 0.9.3 suite and exact internal dependency pins.

### Patch Changes

- @ue-shed/unreal-assets@0.9.3

## 0.9.2

### Patch Changes

- @ue-shed/unreal-assets@0.9.2

## 0.9.1

### Patch Changes

- @ue-shed/unreal-assets@0.9.1

## 0.9.0

### Minor Changes

- 3d4c6b1: Keep saved FText translator notes. Keyed text and StringTable entries saved by UE 5.8 expose
  `dev_notes` in `readSavedAsset` inspection output and compact text extraction, and Game Text
  exposes them on each `TextOccurrence.devNotes`, separate from the source string and localization
  identity. Older packages and empty notes produce `""`. `readSavedTable` text cells are unchanged.

### Patch Changes

- Updated dependencies [b8c7623]
- Updated dependencies [679d972]
- Updated dependencies [e5c5811]
- Updated dependencies [3d4c6b1]
    - @ue-shed/unreal-assets@0.9.0

## 0.8.0

### Patch Changes

- 64ca9bf: Inspect rich curve keys, Skeleton reference poses and bone indices, Sequencer float/double channels,
  bounded InstancedStruct values, and package/object metadata in UE 5.7 saved packages. Share the
  source-derived native layouts across native and WASM readers and preserve unsupported inner payloads.
- 64ca9bf: Use source-derived Unreal class and serialization models for supported saved assets. Share bounded
  native layout decoding between StringTables and enums, expose StringTable metadata in native and
  WASM inspection, and preserve saved string-table text identities.
- Updated dependencies [64ca9bf]
- Updated dependencies [64ca9bf]
- Updated dependencies [64ca9bf]
    - @ue-shed/unreal-assets@0.8.0

## 0.7.1

Align this package with the synchronized UE Shed 0.7.1 suite and exact internal dependency pins. There is no direct behavioral change.

### Patch Changes

- @ue-shed/unreal-assets@0.7.1

## 0.7.0

### Patch Changes

- @ue-shed/unreal-assets@0.7.0

## 0.6.0

### Minor Changes

- ff117a0: Add versioned Game Text investigation presets and complete filtered JSON/CSV exports, retaining
  text identities, all occurrences, quality rules, coverage, and project provenance. Query models
  can export full matching results independently of paginated UI results.

    Expose browser-safe investigation metadata and CSV helpers, plus a separate Node file adapter
    with bounded preset reads and atomic output writes. Workbench and the CLI use these APIs for
    saved investigations and replay against an explicitly selected project.

### Patch Changes

- Updated dependencies [ff117a0]
- Updated dependencies [efb6898]
- Updated dependencies
- Updated dependencies [ff117a0]
    - @ue-shed/unreal-assets@0.6.0

## 0.5.1

### Patch Changes

- Align this package with the synchronized UE Shed `0.5.1` patch release. There is no direct
  behavioral change.

- @ue-shed/unreal-assets@0.5.1

## 0.5.0

### Patch Changes

- @ue-shed/unreal-assets@0.5.0

## 0.4.0

### Patch Changes

- @ue-shed/unreal-assets@0.4.0

## 0.3.0

### Patch Changes

- Updated dependencies [bf27d37]
    - @ue-shed/unreal-assets@0.3.0

## 0.2.0

### Patch Changes

- 51c0e1b: Align the unchanged public packages with the synchronized UE Shed `0.2.0` suite release.
- Updated dependencies [51c0e1b]
    - @ue-shed/unreal-assets@0.2.0

## 0.1.0

### Patch Changes

- 9c2cdce: Publish the stable 0.1 package set, including the headless Game Text and World Log Map History
  integration packages.
- Updated dependencies [9c2cdce]
    - @ue-shed/unreal-assets@0.1.0
