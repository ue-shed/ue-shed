# @ue-shed/uasset

## 0.25.0

### Patch Changes

- 34a3295: The WASM runtime adds `runtime.openPackage(path, bytes)`, a handle that parses a package once and
  serves `inspect`, `extractText`, `extractTextures`, `extractAuthoringTable`, `extractLevelSequences`,
  `extractBlueprints` and `extractAnimations` from it with the same results as the per-call methods;
  `free()` releases it. Inspecting through one handle is 13–33% faster.

    The native reader decodes property streams faster and with about 40% less peak heap, and native text
    extraction decodes only properties that can hold text. Text, places and text-capable gaps are
    unchanged; coverage gaps that cannot hold text are no longer reported, and some exports that failed to
    decode now decode. Game Text cold builds are about 40% faster: the reader allocates with mimalloc,
    reuses its compression contexts, and parses localization manifests and archives in one pass with
    byte-identical columns and diagnostics.

## 0.24.0

No direct behavioral change: released to keep the suite aligned. It launches the 0.24.0 reader,
which adds Blueprint comparison (see `@ue-shed/uasset-win32-x64`).

## 0.23.0

## 0.22.0

## 0.21.0

### Minor Changes

- 5ece9e8: Game Text caches are smaller. Integer and string-ID columns in `UESHT004` snapshots can use two new
  section codecs: zstd over the values' bytes grouped by significance, or over the differences of a
  non-decreasing column. The native writer picks per column by compressing a sample, and encodes a
  layer's sections in parallel; TypeScript readers decode both. Because older readers cannot, the
  cache namespace moves to `game-text-v2` and existing caches rebuild once. On a local UE 5.7
  project (~11k packages) the Game Text cache shrinks from 19.4 MB to 8.3 MB.
- bde914e: The Project Index Catalog is compressed. Snapshots move to `catalogs-v6` (`UESHC004`): the sections
  readers decode whole are zstd frames, and posting lists and header records are independent 64 KiB
  blocks, so queries still decode only what they read. A local UE 5.7 project's snapshot (about
  11,000 packages) shrinks from 9.7 MB to 1.9 MB. Existing `catalogs-v5` caches are ignored and the
  next refresh rebuilds the index.
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
- ca41635: Read large saved Blueprints and Niagara packages faster with identical output. A Blueprint's
  graph membership is decoded once per owning export instead of once per graph and node (a 32 MB
  Blueprint went from 4.6 s to 0.35 s), fixed-size numeric array elements no longer allocate an
  error breadcrumb each, and text projection skips numeric leaves.
- b77e2e3: A saved Game Text index can be reopened without rescanning.
    - `GameTextIndexSteps.openCommitted({ projectRoot, targetName? })` opens an already committed view
      and returns `None` when there is none to use, without reading packages or rebuilding.
    - The workspace's `configuredRefresh(false)` uses it to show a saved index at once. Its completed
      result then carries `cached: true` (optional on `TextCorpusQueryRunResult`). The cached view can be
      browsed and searched, but quality rules, operation targets and investigation exports wait until a
      refresh has checked it against the current Project Index. A refresh replaces it.
    - The native engine reports the ID index's load and build seconds separately in `stage_seconds`
      (`id_index_raw_*`, `id_index_line_*` and `id_index_unit_lines_*`).

- 4a25d69: Project Index status no longer starts a process for each check. The `uasset` protocol session now
  answers `project_index_status`, and the process-backed `ProjectIndex` reads status through its
  existing reader session, falling back to a one-off process for an older reader.

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

- 68737a3: Report a package moved or copied outside Unreal at its file's location. Its summary keeps the
  package name it was saved under, so the Game Text corpus and index stored object paths in the old
  folder, and opening a moved DataTable in Unreal failed with "Unreal's Asset Registry has no …".
  uasset-io 1.17 package text records carry the summary's `packageName`; when it differs from the
  name the file's location gives, the package's own object, class and Blueprint class paths move to
  the file's package, as Unreal resolves them, and the record keeps `packageName` as evidence. Paths
  into other packages stay as saved. Package text shards move to `package-text-v8`, so existing
  indexes read their packages again.

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

## 0.18.0

### Patch Changes

- 81fa128: Read saved Blueprint graph pin text on UE 4.27 and UE 5.6–5.8, retaining Unreal identities and
  addressable pin locations. Report skipped or rejected graph pin streams as partial coverage even
  when the package gather table omits their text. Match native subobject paths during saved repair
  verification. Re-extract cached package text on the next refresh so existing scans gain pin text.
  Join compiled Blueprint literals to matching saved pin identities within each package, preserving
  both occurrences and keeping different sources or unread pins separate.

## 0.17.1

## 0.17.0

### Minor Changes

- 70dec0a: Add an opt-in native Game Text index builder through the existing scoped uasset-io protocol
  session. The builder writes the existing shared dictionary and column format, supports narrowly
  eligible incremental joins, and preserves the current JavaScript query interface. TypeScript remained the default builder until the native engine entry in this release. Give decoded shared-string arenas their own buffers so cache
  accounting tracks their actual capacity.

### Patch Changes

- d61f66a: Read the text literals compiled into Blueprint functions. The reader now walks every saved `UFunction`'s script bytecode (UE 4.27 to 5.8) and reports each distinct `EX_TextConst` as a `ScriptBytecode[N]` place, with UE 5.8's renumbered literal types and translator notes, so Print Text and other graph literals that Unreal gathers are no longer silently missing; a script the walk cannot follow is a decode error. Function parameters of delegate and field-path types are now read too. Game Text classifies compiled literals as player text (`script_bytecode`).
- a8c7c4d: Read graph pins whose default text is a String Table reference (FText history 11). The Blueprint graph reader decoded every other pin text but reported these as an unsupported history, so a Blueprint with such a pin was read only in part. It now reads them as tagged text properties are read: table ID and key, with no saved source. The Game Text identity fixture's new slice 2 (Plan 058 A4) found the gap. That slice adds String Tables, compiled literals of each saved kind, Blueprint inheritance, a level actor and a World Partition external actor, checked against Unreal 5.7's gather.
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

## 0.13.0

## 0.12.0

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

## 0.10.0

No direct behavioral change. Align with the UE Shed 0.10.0 suite and exact internal dependency pins.

## 0.9.3

No direct behavioral change. Align with the UE Shed 0.9.3 suite and exact internal dependency pins.

## 0.9.2

## 0.9.1

## 0.9.0

Align this package with the synchronized UE Shed 0.9.0 suite and exact internal dependency pins. There is no direct behavioral change.

## 0.8.0

## 0.7.1

Align this package with the synchronized UE Shed 0.7.1 suite and exact internal dependency pins. There is no direct behavioral change.

## 0.7.0

### Minor Changes

- Align this unchanged package with the synchronized UE Shed `0.7.0` release. There is no direct behavioral change.

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

## 0.5.1

### Patch Changes

- Align this unchanged package with the synchronized UE Shed `0.5.1` patch release. There is no
  direct behavioral change.

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

- bf27d37: Advance `uasset saved-world` output to the version 2 wire contract with finite effective
  location, quaternion rotation, scale, direct root-component attachment evidence, and explicit
  transform-resolution failures.

## 0.2.0

### Patch Changes

- 51c0e1b: Align the unchanged public packages with the synchronized UE Shed `0.2.0` suite release.

## 0.1.0

### Patch Changes

- 9c2cdce: Publish the stable 0.1 package set, including the headless Game Text and World Log Map History
  integration packages.
