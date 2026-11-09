# @ue-shed/unreal-assets

## 0.29.0

### Patch Changes

- 8766a46: The package parser checks an outer chain's depth before following it, so a malformed package
  fails with a parse error instead of exhausting the stack. A Blueprint diff no longer reports
  false component additions or removals when a construction-script node could not be read. The
  source-text wrapper scan no longer caches a set from a scan that could not list every folder.

    Game Text imports a culture's compiled resource when its archive disappears during a refresh.
    A finding accepted on a culture backed only by a `.locres` stays accepted. Such findings now
    load in the CLI quality report and the workspace.

    A supervised editor session accepts readiness only from the editor it launched. A persistent
    reader request's write is bounded by its deadline and cancellation.

    A visibility-policy change advances the View revision. Map history refuses a project tree that
    a failed revision left mixed. It counts the baseline budget over distinct files, and gives each
    concurrent revision-cache write its own staging file. Playback frames after a partial snapshot
    read as partial. Actor observation leaves live, keeping the last sample, when Unreal's writer
    closes without a reset. The previous session's writer closing late does not end the new session.

    In the Unreal plugins:
    - A camera readback poll can no longer copy an earlier capture into a slot reused for a later
      one.
    - A scenario run that holds live-input isolation past a real-time limit ends as
      `ownership_timeout`, including while PIE is paused.
    - Final renders rescan editor-preview children before each frame.
    - The camera arrangement panel stays read-only until it matches the applied revision, and keeps
      a typed value while it waits.
    - The Game Text commandlet publishes its result through a temporary file and a rename.

    Map history requires p4client-ts 0.15.0.

- 4e0936f: Preserve unresolved authoring sessions and cleanup receipts, keep approved camera sessions
  unchanged by later previews or world changes, and replace native reader workers that exit idle.
  Game Text now retains pending translation writes when copying file lists and preserves ID-repair
  ownership and receipts when the focused text is refreshed.

    Camera setup hosts must now call `poll(bridge, projectName, { projectRoot, endpoint })`.
    The required stable context argument scopes saved-set listings and acknowledgement outcomes to
    one project and editor, including when bridge adapters are recreated between polls.

    Keep Game Text rule saves, scan publication, localization selection, review batches and retries
    owned by their originating operation and context. Preserve recoverable native query failures,
    clear abandoned scan progress, and serialize duplicate thumbnail generation.
    Workbench now serializes editor target changes, refreshes command status without stale polls,
    retains current history jobs during cancellation, shares pending launches, and safely retires
    camera sessions and preview bindings across failures and world changes.

    Keep carried ID-repair translations attached to the target submitted with Apply. Retain refreshes
    of the selected project while another project is opening, preserve newer rules selections when
    an older save completes, scope scan progress to the logical scan, and clear recovered rules-file
    errors without dismissing newer unrelated failures.

    Refusing an oversized scan request now preserves progress and ownership of a scan already running.

    Keep observation paused during pending restarts and retain failed camera-detach cleanup for retry.
    Discarded provisioning no longer falls back to rendering a stale session. Setup acknowledgements
    survive project/editor round trips, and pagination preserves newer finding-detail errors.

- Updated dependencies [8766a46]
    - @ue-shed/protocol@0.29.0

## 0.28.0

### Patch Changes

- Updated dependencies [618560b]
    - @ue-shed/protocol@0.28.0

## 0.27.1

### Patch Changes

- 95906cd: Game Text reads that hydrate rows spend less time in the native engine, with identical answers:
    - A localization line export with `fields` builds only the fields it names. Identity and source
      for every line of a 583,507-line target took 21.4 s and now take 3.4 s; a line's whole preview,
      with every culture's mark, was built and discarded for each line.
    - A rows-only page (`searchRows`, no counts, facets or groups) walks the display order only until
      its page is full, instead of listing every matching row first. Small source pages take about
      half the time; target pages about two thirds.
    - Batch rows serialize their nested values (cultures, manifest entries, places) into one buffer,
      about 7 times faster. Reading 1,000 chosen lines with every field went from 671 ms to 466 ms.
    - A line preview reads the manifest's file metadata once per reader instead of parsing it again
      for each manifest location.

    A localization page may hold up to the query's 100,000-row page bound. `LocalizationQueryPage`
    rejected more than 50 lines, so a larger `pageSize` failed to decode.

- Updated dependencies [95906cd]
    - @ue-shed/protocol@0.27.1

## 0.27.0

### Minor Changes

- 84915c0: Expose parameterless service operations as reusable Effect/Stream properties. Callers execute
  `yield* ids.generate` rather than `yield* ids.generate()`; parameterful operations remain functions.
  Implementations retain per-execution work, original service and scope requirements, fresh IDs and
  named tracing. Native schemas and wire representations are unchanged. Hosts must migrate their supplied service
  implementations and local checked-dispatcher adapters when adopting the coordinated suite release.
  See `docs/engineering/effect-operation-properties.md` for migration guidance and the consumer audit.

    Game Text progress hooks and corpus comparison layers preserve their supplied error types rather
    than widening them to `unknown`. Private viewer read/search ports use the same generic error
    parameterization. Recoverable file/JSON/schema boundaries retain their original tagged failures
    and nested causes; trusted construction failures remain defects.

    Export a tagged `GameTextWorkspaceHostFailure` constructor in place of the former untagged host
    failure interface. Host adapters supply the original failure as `cause` with the existing recovery
    guidance. Reject non-finite TypeScript measurement/cache metadata and localization memory budgets,
    while retaining finite fractional values and existing host policy. Wait for cancelled plugin archive
    IO to settle before releasing staging resources, including cancellation through the owning fiber.

- 81fe6ab: A Game Text rescan of an existing index now updates it in place however many package shards
  changed: it reads and converts only the changed packages, and the native writer keeps every
  unchanged record. The reader stages the changed packages straight into shard snapshots, as a
  first scan does, so their records never sit in the JavaScript heap; a source without staging
  spools them to files as they arrive. A change that touched more than 8 of the 256 shards used to decode every changed
  shard in JavaScript and re-encode each record. All changed shards still publish atomically. Only a
  first scan, or an index in an older package format or audience policy, reads and writes the
  changed shards again.

    Progress reports reads apart from reuse. `package_read` ("Reading changed packages") replaces
    `packages` and counts the packages read of those to read, with `unchanged` giving the packages kept
    from the index without reading them. `package_update` ("Updating package text") covers the
    in-place update; `package_publish` stays for a shard set written again.

    uasset-io 1.22 adds `compare_packages`, which compares a refresh's changed shards with the index
    in the native writer, so unchanged entries no longer cross into JavaScript. `publish_packages`
    accepts `rowsFile`, the rows as a file of little-endian 32-bit integers, and an input without
    `previousKey` for a shard the index doesn't hold yet. The native writer interns each string
    domain once across a request, so a change to every shard fits the dictionary's 256 segments.

### Patch Changes

- b9e73b1: Game Text answers what on disk differs from its index, read-only, so a host can show "N saved
  packages changed since the last scan" without its own snapshot of the tree or a Project Index
  refresh:
    - `GameTextIndexSteps.diskChanges` and the workspace's `diskChanges` take a project root, an
      optional localization `target`, optional project-relative `paths` (at most 4,096) and a page
      (`after`, `limit` up to 1,000). Without `paths`, the reader walks `Content` as the Project Index
      does and compares every package's bundle signature with the indexed one; with `paths`, it checks
      only those, and a sidecar checks its package. With `target`, the target's manifest, archives,
      POs and review file are compared by size and modification time. The answer is `not_indexed`, or
      `ready` with counts (`packages` and `localization`, each `added`, `changed`, `removed`) and a page
      of items in path order with the next page's cursor. Nothing is written.
    - `watchDiskChanges` (on the steps and, as a host-only method, on the workspace) returns a `Stream`
      of `{ status: "not_indexed" }` or `{ status: "ready", changed, files, counts, checking }`: one full
      check, then `Content` and the target's folders are watched with `fs.watch` through the new
      `DiskWatcher` service (`DiskWatcherNodeLive`). Bursts settle for 300 ms by default (`settle`);
      named files are rechecked by path, and folder events, watcher errors and published scans run a
      full walk.
    - The engine contract adds the `disk_changes` builder request (`DiskChangesRequest`,
      `DiskChangesAnswer`, `DiskChangeItem`, `DiskChangeCounts`, `DiskChangeKind`) and
      `JoinedReviewFile`; the uasset-io request and event schemas add the action and its outcome
      (`diskChanges`), sent with contract minor 16.
    - A localization target's join records its review file's path, size and modification time
      (`reviewFile`), keyed like file provenances, so a target with a review file gets a new
      generation once. `LocalizationReviewSnapshot` has the file's `provenance` when it exists.

- Updated dependencies [73c7081]
- Updated dependencies [79a96ef]
- Updated dependencies [b9e73b1]
- Updated dependencies [d104ec9]
- Updated dependencies [61ae5df]
- Updated dependencies [c773bcd]
- Updated dependencies [acaa3ee]
- Updated dependencies [81fe6ab]
- Updated dependencies [fe2f488]
    - @ue-shed/protocol@0.27.0

## 0.26.0

### Patch Changes

- @ue-shed/protocol@0.26.0

## 0.25.0

### Patch Changes

- @ue-shed/protocol@0.25.0

## 0.24.0

### Minor Changes

- 177d71e: Compare two saved revisions of a Blueprint without Unreal: `compareBlueprintRevisions` returns a
  page of the nodes, wires, variables, components and class defaults a change added, removed or
  changed, paired by saved identity so moved and renumbered nodes are counted rather than listed.
  It needs the native reader's uasset-io v1.21 `compare_blueprints` request, and says what it did
  not compare, such as a widget's layout.

### Patch Changes

- Updated dependencies [177d71e]
- Updated dependencies
    - @ue-shed/protocol@0.24.0

## 0.23.0

### Minor Changes

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

### Patch Changes

- Updated dependencies [430728c]
    - @ue-shed/protocol@0.23.0

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

- 5f6f15f: `workspace.related` reads a unit's or a target line's related members in one engine request
  (the `related` action): the units under its key, the units or lines with exactly its text, and
  with a target its key's conflicting units and its key change's paired line, each with its
  places and translations. The ID repair panel reads it instead of a text search and one focus per
  match.

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
    - @ue-shed/protocol@0.22.0

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
- 1d22faa: Saved-asset limits and pure helpers are public, so hosts no longer copy them.
    - `@ue-shed/unreal-assets` exports `DEFAULT_TIMEOUT_MS`, `DEFAULT_CATALOG_TIMEOUT_MS` and
      `SAVED_REVIEW_MAX_CHANGES`. `./investigation-files` exports `INVESTIGATION_PRESET_MAX_BYTES` and
      `INVESTIGATION_EXPORT_MAX_BYTES`.
    - `searchBlueprint` accepts `maximumHits`; the default stays `MAX_BLUEPRINT_SEARCH_HITS`.
    - `@ue-shed/map-history/diff` is a browser-safe entry for `diffSavedWorldSnapshots`,
      `actorIdentityOf`, `actorIdentityKey` and `savedWorldTransformsEqual`.
    - `@ue-shed/project-custodian` exports `resolvePolicyDocument`, `PolicyResolution` and
      `ProjectTargetDefinition`, so a host can validate a policy before writing it.
    - `@ue-shed/uasset-inspection-wasm` declares the `DEFAULT_LIMITS` it already exported at runtime.

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

- 4a25d69: Project Index status no longer starts a process for each check. The `uasset` protocol session now
  answers `project_index_status`, and the process-backed `ProjectIndex` reads status through its
  existing reader session, falling back to a one-off process for an older reader.
- Updated dependencies [19c9412]
- Updated dependencies [05f4e1a]
    - @ue-shed/protocol@0.21.0

## 0.20.0

### Patch Changes

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
- Updated dependencies [68737a3]
    - @ue-shed/protocol@0.20.0

## 0.19.0

### Patch Changes

- @ue-shed/protocol@0.19.0

## 0.18.0

### Patch Changes

- Updated dependencies [b267701]
- Updated dependencies [fc109a5]
    - @ue-shed/protocol@0.18.0

## 0.17.1

### Patch Changes

- @ue-shed/protocol@0.17.1

## 0.17.0

### Minor Changes

- 49cf8f0: `gameTextIndexSourceNodeLayer` now splits a read into reader requests that each fit the native reader's 4 MiB request frame, so a host can hand it every selected package of a large project without batching the paths itself. Each batch is signature-verified before and after its own read and emits its own `text_summary`.

    `@ue-shed/unreal-assets` exports the frame limit as `MAX_PROTOCOL_REQUEST_BYTES`, the default per-request path budget as `MAX_PROTOCOL_PATH_BYTES`, and `batchProtocolPaths(paths, maximumPathBytes?)`, which splits package paths into ordered batches that fit one request.

    The oversized-request `contract` error now says `split package paths with batchProtocolPaths`.

    Migration: hosts that batched paths before calling the Game Text index source can pass the whole selection instead. Hosts that call `extractProjectTextPackages` directly with many paths can use `batchProtocolPaths` instead of their own limit.

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

## 0.16.2

### Patch Changes

- @ue-shed/protocol@0.16.2

## 0.16.1

### Patch Changes

- @ue-shed/protocol@0.16.1

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

### Patch Changes

- 6608e6a: Report a native reader that closes its input pipe early (EOF/EPIPE) as a typed process failure
  instead of an unhandled stream error that crashes the host, and reject one-shot protocol requests
  over the native reader's 4 MiB frame limit before spawning the worker.
- Updated dependencies [dbb471e]
- Updated dependencies [7d925d7]
    - @ue-shed/protocol@0.16.0

## 0.15.0

### Patch Changes

- @ue-shed/protocol@0.15.0

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
- Updated dependencies [8f9bcf1]
- Updated dependencies [d8eca33]
    - @ue-shed/protocol@0.14.0

## 0.13.0

### Patch Changes

- @ue-shed/protocol@0.13.0

## 0.12.0

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

- Updated dependencies [d90ae25]
    - @ue-shed/protocol@0.12.0

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

### Patch Changes

- 982743f: Raise localization evidence and saved-reader limits tenfold, apply entry limits per file, and preserve read failure causes and recovery guidance in Game Text and the CLI.
- 9b08c67: Aggregate saved-text gaps by package without losing reader reasons, retain at most three samples,
  and count all undecoded properties. Add optional `coverageGapCounts` to corpus diagnostics while
  keeping corpus schema version 1. Bound report diagnostics and incomplete package lists to 200,
  with full totals and omitted counts in status, progress, quality and investigation output.

    Expose a browser-safe text coverage gap schema from Unreal Assets for corpus consumers.

- Updated dependencies [1f01e74]
- Updated dependencies [a545cd5]
- Updated dependencies [580442c]
- Updated dependencies [67a611c]
    - @ue-shed/protocol@0.11.0

## 0.10.0

No direct behavioral change. Align with the UE Shed 0.10.0 suite and exact internal dependency pins.

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

### Minor Changes

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

### Patch Changes

- Updated dependencies [a3b58fd]
- Updated dependencies [f69d878]
- Updated dependencies [b8c7623]
- Updated dependencies [679d972]
- Updated dependencies [e5c5811]
- Updated dependencies [3d4c6b1]
    - @ue-shed/protocol@0.9.0

## 0.8.0

### Minor Changes

- 64ca9bf: Inspect rich curve keys, Skeleton reference poses and bone indices, Sequencer float/double channels,
  bounded InstancedStruct values, and package/object metadata in UE 5.7 saved packages. Share the
  source-derived native layouts across native and WASM readers and preserve unsupported inner payloads.
- 64ca9bf: Use source-derived Unreal class and serialization models for supported saved assets. Share bounded
  native layout decoding between StringTables and enums, expose StringTable metadata in native and
  WASM inspection, and preserve saved string-table text identities.

### Patch Changes

- 64ca9bf: Reduce native parser allocation costs by borrowing struct names, formatting diagnostic paths only
  on failure, and reading sized arrays without cloning generated layouts. Reduce owned inspection
  memory for assets without Skeleton poses while preserving inspection JSON and analyzer behavior.
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

- ff117a0: Add generation-bound Project Index counts through
  `countProjectIndex({ projectId, expectedGeneration, filters })`. Supply 1–16 `ProjectIndexFilter`
  values for maps, exact classes, class prefixes, class-name suffixes, or serialized names. Each
  value-based filter requires 1–64 non-empty values; empty filter lists are rejected. Overlapping
  matches count each package once. The production binary Catalog reads checked snapshot postings
  without transferring candidate headers, and the public helper validates result identity and generation.
- Inspect saved Blueprint graphs without launching Unreal through `readSavedBlueprint`, native IO,
  and the WASM inspection API. Return graph/node identities, saved positions, typed pins and defaults,
  canonical links, tagged node properties, and explicit coverage diagnostics. Inspection is read-only
  and limited to supported uncooked saved revisions; it does not compile or execute Blueprints.

    Improve Project Index discovery, header batching, refresh, and query transport. Bound native
    protocol-worker shutdown and preserve typed reader failures for recovery.

- ff117a0: Add versioned Game Text investigation presets and complete filtered JSON/CSV exports, retaining
  text identities, all occurrences, quality rules, coverage, and project provenance. Query models
  can export full matching results independently of paginated UI results.

    Expose browser-safe investigation metadata and CSV helpers, plus a separate Node file adapter
    with bounded preset reads and atomic output writes. Workbench and the CLI use these APIs for
    saved investigations and replay against an explicitly selected project.

### Patch Changes

- efb6898: Preserve native failure codes on `AssetReaderError` so clients can provide typed recovery for unsupported and unavailable readers, and expose Blueprint class evidence for Project Index candidate queries.
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

### Minor Changes

- bf27d37: Version the saved-world projection to v2 with finite effective location, quaternion rotation, scale,
  and direct root-component attachment evidence. Map History schema v2 records the new actor shape and
  distinguishes attachment, effective-transform, and transform-resolution changes.

### Patch Changes

- Updated dependencies [bf27d37]
    - @ue-shed/protocol@0.3.0

## 0.2.0

### Patch Changes

- 51c0e1b: Align the unchanged public packages with the synchronized UE Shed `0.2.0` suite release.
- Updated dependencies [51c0e1b]
    - @ue-shed/protocol@0.2.0

## 0.1.0

### Patch Changes

- 9c2cdce: Publish the stable 0.1 package set, including the headless Game Text and World Log Map History
  integration packages.
- Updated dependencies [9c2cdce]
    - @ue-shed/protocol@0.1.0
