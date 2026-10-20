# @ue-shed/uasset

## 0.19.0

### Minor Changes

- 207cc44: The native Game Text index answers more questions directly, so hosts stop exporting the corpus to
  derive facts. A `source` filter clause selects up to 50 exact source texts (case, whitespace and
  lone surrogates count; a unit with conflicting sources matches any of them), resolved once per
  request to dictionary IDs. `finding` clauses accept every stored review signal, adding
  `conflicting`, `evidence_only` and `compiled_copy_differs`. `group: "source"` groups lines by exact
  source text, and `minGroupSize` lists only groups of at least that many lines, so `finding is
duplicate_source` with `group: "source"` and `minGroupSize: 2` lists the texts under several keys in
  one query. Group keys and `openGroup` now hold up to 32,767 UTF-16 code units. Opening a reader
  indexes line and unit IDs (`id_index_prepare`), so focus, cursors, `lines` selections and line
  details no longer scan every ID: a 5,000-line selection over 200,000 lines takes 24 ms instead of
  1.4 s. Bulk reads (corpus, exports, localization dumps) of a model opened through
  `GameTextIndexQuery` run in a second native process, so a dump no longer holds searches and focus
  behind it; `openNativeTextQuery` opts in with `bulkEngine`. Native search, the columnar and
  in-memory references, and the differential fuzz agree on every new request.

    The index is now queried like a library index. `aggregate` groups every matching row by one to four
    dimensions (culture, the culture-mark state, fact, unknown reason, review lens, review status and
    review flag, and translation key, source, namespace, audience, origin, problem, finding, asset and
    gathered) and returns each group's lines, whitespace source words and `lineBreakWords`, Unreal's
    word count of the gathered text, from a Rust port of the `linebreak` package that matched it on
    over a million test strings. `selectLocalizationLines(request, fields)` reads only the named line
    fields, adding `marks`, `problems`, `signals` and `places`; `readCorpusHeader()` reads coverage and
    diagnostics without units; `readUnits(ids)` reads named units; and `corpusFingerprint()` hashes the
    corpus in Rust to the value `createLocalizationBaseline` records. Models carry a `revision` that
    changes when the model does. The progress report and baseline (`indexedLocalizationProgressReport`,
    `indexedLocalizationBaseline`), the changed-file gate (`indexedLocalizationGateTarget`), the lines
    spreadsheet, the gather key pairing and investigations use these reads, so the Workbench and the
    CLI no longer export the corpus or the join to answer them. The whole-input functions remain.

    `makeGameTextWorkspaceLocalization` now takes the current model's `revision` as its first argument
    instead of the corpus read: pass `() => Effect.succeed(model.revision)` where you passed the lazy
    corpus.

    The localization quality worker sends its spans' and stages' timings back with its findings, and the
    host adds them to its `GameTextIndex.qualityWorker.scan` span, so a host's trace shows where a
    worker scan spends its time.

    Localization quality scans and progress reports over large targets are faster, with the same
    findings and reports. Measured on a generated target of 200,000 lines in 14 cultures with archives
    and PO files: a quality scan takes 55 s instead of 104 s. Hydrating its lines takes 15 s instead of
    36 s: a shared-string reader keeps strings it decoded by ID (a line's key, source and translations
    recur in the manifest and every archive and PO file), and reading manifest, archive and PO entries
    decodes only the columns of their format. Checking takes 25 s instead of 50 s, and preparing
    2 s instead of 5 s: duplicate-source places come from the occurrence location columns instead of
    whole occurrences, and column lookups, shipped translations, rule IDs and format modifiers no
    longer rebuild keys or validate values the index already typed. `indexedLocalizationProgressReport`
    read the manifest once and every archive twice from the index on each call, 44 s of JavaScript per
    call on that target. It now reads them once per evidence object, while the native reads run, keeps
    only the totals it needs, and further pages, the CSV and baseline comparisons (per baseline) reuse
    them: 16 s for the first report, then about a millisecond. Spans
    `GameText.localizationReport.manifest`, `.words`, `.archive` and `.assemble` show its phases.

    Index refresh progress names each step it reports. `localization_publish`, `package_text` and
    `package_publish` replace the `joining` events reported while publishing localization text,
    preparing the package text layer and publishing it, and `joining` now means only the join of source
    text with translations. `package_text` counts packages prepared of the packages in the inventory,
    so a cold refresh shows a count for the 37 s it spent preparing 15,445 packages instead of none.

    A progress report no longer holds the host's event loop. On an index model each read of an
    evidence file decoded every entry synchronously and checked it against its schema again, about
    0.8 s per archive of a 132,000-line target; the report now reads the manifest and archives page by
    page, yielding between pages, and the importer's validation is not repeated. Its longest stall on
    a generated 132,000-line target went from 1.3 s to 0.13 s and the report from 3.7 s to 2.0 s.
    `readCorpusReportHeader()` returns what a report shows of the corpus header (coverage, every
    diagnostic and package count, and the first 200 diagnostics and incomplete packages), computed in
    Rust. The whole header of a project of 166,699 packages is 67 MB and took 7 s, 3 s of it decoding
    JSON on the host; the report header takes 2.3 s in the native process the first time and 94 ms
    after, as the native reader now reads package lists once and decodes package paths in dictionary
    order. The cold package text import records its packages, shards, workers, worker busy time,
    slowest shard and publish time on its span.

    `TextCorpusReportHeader` and `textCorpusReportHeader` are exported for hosts that implement the
    query contract. Aggregates no longer allocate per row: keys are fixed arrays and culture marks
    refill their slots, so the progress report's five aggregates over a real 14-culture target take
    2.5 s instead of 4.4 s (0.7 s instead of 2.1 s after the first one counts its words).

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
