# Plan 057: A compact, persistent Game Text index

> **Executor instructions**: Follow this plan in order. Before editing, read `AGENTS.md`,
> `docs/README.md`, `docs/products/game-text.md`, ADR 0007, `docs/engineering/binary-project-index.md`,
> Plan 033, and Plans 037 and 056 (archived), and `docs/engineering/testing.md`. Run targeted checks while
> iterating and `pnpm check` before handoff. Honour the STOP conditions.
>
> **Drift check (run before each phase)**:
> `git diff origin/main...HEAD -- packages/game-text packages/localization packages/unreal-assets crates/uasset-io apps/cli apps/workbench extensions/game-text`.

## Status

**Architecture update, 2026-10-18:** The accepted direction is one Rust-native Game Text engine.
Rust owns persisted storage, joins, incremental updates and query execution. TypeScript hosts
compose services, submit asynchronous typed requests and present native results. They do not
reconstruct a columnar query engine or select a JavaScript fallback. Independent in-memory and
columnar implementations remain test oracles and are excluded from published package output.
This decision supersedes the JavaScript reader/query implementation described in the historical
phase notes below. See [the current engine contract](../docs/engineering/native-game-text-index.md).
Production integration and its full performance acceptance are being verified; the old phase
measurements do not establish acceptance for this engine. The restriction on further 10× runs
still applies.

- **State**: Phase 6 implementation and targeted verification are complete: canonical WTF-8
  format v4, cross-language goldens, host migration and direct column previews are implemented.
  The latest 1× changed-input refresh case meets 10 seconds; Workbench startup, facets and an
  uncached text search leave overall performance acceptance incomplete. The owner stopped all further
  10× runs; the attempted CLI cold build failed its 900-second cap. Phase 7's browse layout is wired
  to the index; its generated-scale desktop measurements and tour remain incomplete. Reader v1.8
  and gather rule v1.9 are unchanged. See the latest evidence below; no full-gate pass is claimed.
  Phase 8, moving localization quality checks onto the index, is superseded by
  [Plan 059](059-game-text-query-and-rule-engine.md), which moves rule evaluation and queries into
  one native engine.
- **Priority**: P1
- **Effort**: XL
- **Risk**: HIGH. This replaces how every Game Text and localization host holds its data, and adds
  a derived on-disk index. The in-memory join stays as the test oracle, so states cannot drift.
- **Depends on**: Plan 056 (correct states at real-project scale), Plan 037 (Project Index).
  It makes the Game Text persistence decision that Plan 033 Step 8 left open.
- **Category**: direction
- **Planned at**: `feat/game-text-compact-index`, 2026-10-10

## Context

After Plan 056, `loc status` on a 132,606-key, 10-culture, 166,518-package UE 4.27 project gives
correct states, but every run rebuilds everything as JavaScript objects:

- it reads all 21 localization files (1.4 GB on disk, 58 s);
- it extracts text from every package (the reader streams about 3 GB of JSON);
- it builds 1,028,205 occurrences, a corpus and a join of 583,507 lines, each line with ten
  culture-state objects.

That retains about 3.4 GiB, peaks at 6.6 GB of Node heap plus 4 GB in the reader process, and
takes about 6 minutes even when nothing changed. A project ten times this size cannot run at all:
its manifest alone would be near V8's maximum string length.

Unreal's files are made for people and tools that diff them, not for queries. Measured on the same
project:

|                                                          |                         Size |
| -------------------------------------------------------- | ---------------------------: |
| Manifest, 10 archives and 10 PO files on disk            |                       1.4 GB |
| Unique strings in the manifest and one culture, as UTF-8 |                      29.9 MB |
| Same, compressed (zlib level 1)                          |                      10.5 MB |
| Manifest alone with zstd level 3                         | 7.7 MB (10.5%), decode 74 ms |

A probe then stored the whole joined result the way a program wants it:

- one deduplicated UTF-8 string table (1,573,166 strings, 107 MiB);
- typed-array columns for lines (identity, source, place, origin), per-culture state bytes, per-culture
  translation IDs and unknown-reason bits, and occurrences (package, object, property, line, kind).

| Measurement on the real project     |    Object model today |                       Compact columns |
| ----------------------------------- | --------------------: | ------------------------------------: |
| Retained memory                     |          3.4 GiB heap |   25 MiB heap + 212 MiB array buffers |
| On disk                             |                     — | 212 MiB raw, 47 MiB with zstd level 3 |
| Load                                | ~6 minutes to rebuild |                50 ms to read the file |
| Count every state for every culture |                     — |                                  8 ms |
| Facet counts by folder              |                     — |                                 24 ms |
| Filter by culture state and folder  |                     — |                                  4 ms |
| Search all source text              |                     — |                                 63 ms |
| Search one culture's translations   |                     — |                                 46 ms |
| Materialise a 50-line page          |                     — |                                0.3 ms |

Array buffers live outside V8's heap limit, so the heap stays small however large the project is.
The access pattern needs no general database: one local reader, one target at a time, filters and
counts that a full column scan answers in milliseconds, and writes that only ever replace derived
data. Plan 037's binary catalog already chose a purpose-built snapshot over SQLite and DuckDB for the
same reasons; this plan applies that choice to Game Text.

The outcome: every Game Text and localization host reads one compact, checksummed, atomically
published index per project and target. A run with nothing changed takes seconds. A run after a
change re-reads only the changed packages and localization files. Query memory is set by the page,
not the project. The design is proven on a generated project ten times the measured one.

**Out of scope**, each for its own plan:

- editor-only property filtering, which needs knowledge of which properties Unreal gathers;
- UE 4.27 parser coverage of Blueprint class and function exports;
- `loc gate` treating partly decoded packages as `not_checked`;
- any change to what Unreal's files contain. UE Shed keeps reading them, and keeps writing PO files
  only through the existing change-set apply.

## Design

**Three layers, each refreshed from what feeds it.**

1. **Package text.** Per package: its occurrences (identity, source, object path, property path,
   location kind) and its coverage (status, gap counts by reason). Keyed by the package signature
   the Project Index already computes. Candidates have Unreal's localization-gather flag,
   non-empty summary gather data, or external actor/package relationships. Other packages receive
   `not_gatherable` coverage; exclusion does not prove that they contain no FText.
2. **Localization files.** Per manifest, archive and PO file: its entries as columns of string IDs,
   sorted by identity. Keyed by the file's content hash. Unreal's files are imported with streaming
   parsers, never decoded whole.
3. **The joined target.** Lines, per-culture states, unknown-reason bits, problem bits, facet IDs and
   key changes, built by a merge join over the sorted inputs. Rebuilt when any input's key or the
   review file's hash changes; the first version may rebuild the whole join, if Phase 5 shows that is
   fast enough.

**One snapshot format for all three.**

- One content-addressed string store per project and target; localization, package and joined
  layers contain project-wide u32 IDs. Identical UTF-8 content gets one ID even across domains.
  First-use domains (source, identity, each culture, paths, comments) own independently loaded
  256 KiB blocks. Cross-domain references read their owning blocks without duplicating strings.
- Immutable append-only segments publish with the layers that use them. A layer records its store
  generation and segment count; existing IDs stay valid until a coordinated compaction remaps all
  active layers into a new store generation. Readers retain every opened layer and segment handle.
- **Final dictionary decision: A64**, sorted byte strings front-coded in 64-string blocks,
  zstd over groups up to 256 KiB, and a sparse first-key index. Immutable segment IDs are byte
  sort ranks plus the segment base. Compaction must remap active layers together. Cold targets
  parse with a bounded worker pool, externally sort all strings once in 64 MiB runs, then write
  one segment per domain and the layers. Changed files sort unresolved strings once and probe segments.
  Canonical GUID keys use 16-byte storage, a case mask and a noncanonical tag for exact text recovery.
  Root version 2 and importer version 5 rebuild the disposable prior hash-page cache.
  At most 256 immutable segments accumulate before compaction merges them into one per domain,
  remaps every active layer and publishes one generation; existing readers retain their old handles.
  Refresh reuses native local-block SHA-256 stamps and remappable ID vectors from the prior file
  found by path; only changed blocks hydrate old candidates. Broad edits and older layers match
  rows by identity. Only unresolved sorted strings enter probes, once per relevant segment. Matching domains and newer
  segments go first, with exact cross-domain lookup and byte bounds excluding impossible requests.
  No FST is justified by the measured 8.88 MiB A64 sparse index at 10×; no native dependency is added.
  Bulk reads expand each owned segment into contiguous UTF-8 plus typed offsets; page reads decode
  touched blocks with a bounded 32 MiB decoded-block cache.

    Final saved-section experiment, cells **1× / 10×**; sizes include encoded lookup metadata.
    Modeled append/page probes use compressed payloads in memory, not production file refreshes.

    | Candidate                    |     Dictionary MiB |           Build s | Modeled append s | Folder bounds/count ms |
    | ---------------------------- | -----------------: | ----------------: | ---------------: | ---------------------: |
    | **A64, sorted front coding** | **10.69 / 194.64** | **10.92 / 63.51** | **2.40 / 22.64** |        **0.82 / 0.72** |
    | B, BBHash gamma 1            |     62.42 / 785.42 |      7.30 / 97.99 |     1.22 / 19.92 |       262.66 / 2594.37 |
    | C, historical hash pages     |     80.37 / 976.19 |    15.02 / 238.80 |     2.40 / 43.89 |       271.29 / 4709.96 |

    A64 saves 80.1% against C at 10× and wins 1× size/append/page among front-coded variants.
    A16/A32 use 242.30/212.31 MiB at 10× and append in 21.29/21.40 s; A64 trades 1.35 s against
    A16 for smaller storage. BBHash's 2.889 bits/key becomes 4.728 lookup bytes/key with fingerprints
    and the insertion-ID permutation; absent fingerprints still require exact reads (0.43% candidates).
    The integrated production measurements below supersede the standalone whole-index sizing model.
    Full method, raw sizes,
    scattered pages, memory, limits and remaining work: [measurements](../docs/engineering/game-text-shared-index-measurements.md).

- Keep independent u32 identity IDs rather than manifest-row references: a file's content-keyed cache
  remains independently reusable, including after manifest changes. Zstd level 1 compresses all
  layer columns. Shared IDs use reversible modular deltas with zigzag encoding before compression;
  namespace/key ordering produces small differences and cuts the 1× manifest from 1.34 to 0.34 MiB.
  Shared identities/paths retain the measured levels 6/9 and other strings level 3.
  Use an indexed typed-array bounds-validation loop: identical dependency guards take 167 ms
  rather than 571 ms on the 10× page columns, reducing total column load from 825 to 453 ms.
  Keep physical-domain reader probes separate from semantic searches: borrowed IDs do not add
  bytes to the borrowing domain. Preserve all declared Phase 2 dictionary widths in the forecast;
  compaction of unused synthetic variants cannot establish the 1 GiB acceptance target.
- Refresh compares only the replaced layer's old/new ID columns to accumulate a conservative
  obsolete-byte bound. Once it exceeds both 8 MiB and 25% of store UTF-8 bytes, an exact live-ID
  census decides compaction. This avoids a whole-index scan for tiny edits; rebuilding all layers
  to reclaim one changed string is disproportionate to the measured compaction cost. A forced
  compaction probe measures the full remap and interrupted publication, retaining the old root.
- Columns as little-endian typed arrays, 4-byte aligned, so a reader views them without copying.
- Sparse columns where a dense one wastes space. For example, a PO translation is stored only where it
  differs from the archive's, and unknown reasons are stored per line when every culture shares them.
- Sections checksummed and independently compressed with zstd, or raw when compression does not
  pay. Readers open only the header/directory and load sections by positioned read on first use.
- Writers stream sections into a temporary file. A64 keeps one raw frame and its compressed copy,
  retains compressed frames in external buffers, and writes the segment once after sorting.
  Neither readers nor writers need a contiguous whole-file buffer.
- A small manifest names the current snapshot and the keys of its inputs, published atomically under
  one writer lock, with readers holding the physical file open for their generation. These are
  the binary catalog's
  rules; reuse its conventions, and its Rust code where the index is built natively.
- The cache is disposable derived data, in a versioned namespace beside `catalogs-v4`. A format
  change rebuilds it.

**Queries scan columns.** Hosts keep the hot columns in array buffers and decode strings only for
displayed rows, the line in focus and text search. Cold data (translations for cultures not picked,
paths, comments) is read on demand. The public query API (`TextCorpusQuery`, search pages, counts,
facets, focus) keeps its contract, so the CLI, Workbench and extension do not change shape.

**The in-memory join remains the oracle.** On every fixture and every generated target, the columnar
join must produce exactly the same line states, unknown reasons, problems, key changes and counts.

## Phase 1: Scale harness and baseline

- A generator for a whole synthetic project at a chosen scale:
    - localization files: a manifest, archives and PO files in Unreal's formats (UTF-16 JSON, CRLF PO
      with BOM, `msgctxt`, comments, U+2028);
    - matching saved-text inputs. Packages can be generated as reader events (occurrences, coverage
      gaps) rather than `.uasset` files, provided the layer that consumes them is the one under test.
    - Shapes taken from the measured project: package-namespace markers, keyless text, partial
      packages, editor-only-looking properties, duplicate sources, many cultures.
- Two scales: 1× (about 130,000 keys, 10 cultures, 1 million occurrences) and 10× (about 1.3 million
  keys, 20 cultures, 10 million occurrences).
- A benchmark command records today's pipeline at 1×: wall time, peak heap, peak RSS, array buffers,
  and where it fails. Children have hard caps of 16,384 MiB old space, 20 GB RSS and 20 minutes per
  stage. Today's 10× in-memory pipeline is **not run** for memory safety; the retained 10× files
  are validated with a streaming census instead. Results go to ignored `test-results`.
- An oracle harness that runs today's join on a generated target and compares any other join's
  output with it, line by line.

## Phase 2: Snapshot format

- Encoder and decoder for the string table, columns and sections, with checksums, alignment and
  bounds checks, in one module with no I/O.
- Measure zstd levels on 1× and 10× snapshots, and choose the level and whether to compress per
  section or per file.
- A Node file store: atomic publish, writer lock, reader keep-alive, quarantine of damaged files,
  matching the binary catalog's lifecycle. Decide whether the store is written in TypeScript or
  extends the Rust catalog, and record why.
- Tests: round trip, every bounds and checksum failure, interrupted publishes, two writers.

## Phase 3: Localization files as columns

- Streaming importers for manifest, archive and PO files that write columns directly.
- Keyed by content hash; an unchanged file is never parsed again.
- The existing parsers stay as the format's oracle: for every fixture and generated file, the
  columns decode to the same entries the parser returns.
- Measure import time and peak memory at 1× and 10×.

## Phase 4: Package text as columns

- The reader emits compact per-package text records instead of one JSON event per occurrence, or the
  native side writes the package-text layer itself. This changes the `uasset-io` contract: follow
  ADR 0007's versioning, and keep the existing event stream until no consumer uses it.
- Keyed by package signature; only candidates under Unreal's gather rule are read; a refresh
  re-reads changed packages and updates packages that gain or lose eligibility.
- Measure cold, no-change and one-package refreshes at 1× and 10× using the retained generated
  saved-text stream. Measure old/new native output on committed fixtures. No real-project scan
  occurs in this phase; the owner confirms real-project behavior after Phase 7.

## Phase 5: Columnar join

- A merge join over sorted identities that writes the joined-target layer, including review state,
  key changes and package-namespace stripping.
- It must equal the oracle on every fixture and generated target. Any difference is a STOP.
- Measure join time and memory at 1× and 10×. Decide whether an incremental join is needed.

## Phase 6: Hosts read the index

- The query implementation scans columns behind the existing API: CLI (`loc status`, `report`,
  `check`, `export`, `gate`, `text search`), Workbench main and the extension.
- `loc gate` refreshes only the changed files it is given, then queries.
- Writes (review flags, change-set apply) invalidate the affected layer.
- Remove the in-memory build from hosts. It stays in tests as the oracle.
- Remove the `NODE_OPTIONS` note from the Game Text docs.

## Phase 7: Show it in Game Text

Game Text is the reader: its default list is browse and search, with the analysis computed over the
same index. No separate reader is added.

- Open the 1× generated project in Workbench Game Text and record:
    - time to first list;
    - search-as-you-type latency;
    - culture switch, filter and grouping changes;
    - opening a line's page;
    - Rescan with nothing changed.
- Confirm the 10× generated project opens and stays responsive on Node's default heap.
- Update Showcase Demo 3 with what a project of this size looks like, and record a captioned tour on
  the generated project for `docs/showcase.md` and the site. Never use a studio project; showcase
  content is studio-agnostic.

## Phase 8: Quality checks read the index

Phase 6 moved browse, search, counts and status onto the index; localization quality did not move.
`checkLocalizationTarget` still takes a whole corpus and a whole join, and hosts pass the legacy
projections (`indexedTextCorpus`, `indexedLocalizationJoin`), which rebuild every unit and line as
objects. The Quality checks tab is the pre-index pipeline with a decoding step in front.

Measured on a released 237,921-key, 10-culture project (read-only, Node 24, 24 GiB heap so the
run could finish; the default heap crashes): 13 minutes, a 9.4 GB peak V8 heap, and 9.2 GB still
retained after collection because the workspace caches everything. It returns 3,210,355 findings;
1,921,590 are missing translator notes and 1,249,240 are duplicate sources, each repeated once per
culture. Sampled live heap at the end: 48% validating the finished report (Effect Schema rebuilds
every finding), 30% hydrating all lines, 13% building a summary and hashed ID per finding, 7% the
legacy unit list. CPU: 31% garbage collection, about 21% string decoding; the check rules
themselves do not appear in the profile.

- **One line at a time.** Extract the per-line body of `checkLocalizationTarget` (built-ins,
  policy rules, accepted-finding filter) into a pure function. `checkLocalizationTarget` keeps its
  contract and calls it per line; the indexed scan calls the same function, so the rules cannot
  drift.
- **Scan in pages.** Duplicate sources are grouped from the line columns and shared strings, without
  hydrating lines. Lines are then hydrated in bounded pages of adjacent rows, checked, and dropped.
  A line's units are found by ID through a hash index on the unit ID column, never a unit list.
- **Findings as columns.** The scan keeps per-finding culture, check, rule, fix eligibility and a
  64-bit content hash, plus per-row ranges in line-ID order. Counts, totals and fix counts scan these
  arrays. Pages, focus and proposals re-run the line check for only the rows they return.
- **Finding IDs** are a fast hash of the finding's line, culture, rule, check and canonical actual
  value, so they are cheap, identical on both paths and survive a rescan of unchanged text.
- **One workspace.** `search`, `export`, `focus` and `changes` are written once over a finding list;
  the legacy workspace and the indexed workspace only supply the list.
- **Oracle.** On every fixture and generated index, the indexed workspace's pages, counts, limits,
  rules, focus results and proposals equal the legacy workspace built from the legacy projections of
  the same index. Any difference is a STOP.
- **Hosts.** An opened index offers `localizationQuality(options, ruleDocument)`; hosts never read
  the joined reader. Adapters without an index omit it, and hosts then check the in-memory join.
  The CLI keeps the full report for `loc check` until its output streams.
- **Scale.** Add a quality stage to the scale harness with the peak heap target below.

Not in this phase, each needing its own decision: reporting source-level checks once per line
rather than per culture (changes the report contract and how accepting a finding works), source
rules (`evaluateGameTextSourceQuality` still reads the legacy unit list when a rule document
exists), and the CLI's full report.

## Acceptance targets

Recorded on the generated projects; confirmed read-only on the real one.

|                                             | 1× target | 10× target | Phase 4 result, 1× / 10× |
| ------------------------------------------- | --------- | ---------- | ------------------------ |
| Peak V8 heap during any query               | ≤ 128 MiB | ≤ 256 MiB  | Later query phases       |
| Refresh with nothing changed                | ≤ 5 s     | ≤ 30 s     | 0.43 / 2.18 s; pass      |
| Refresh after one package and one PO change | ≤ 10 s    | ≤ 60 s     | 3.52 / 39.13 s; pass     |
| Count, filter, facet or page query          | ≤ 100 ms  | ≤ 1 s      | Later query phases       |
| Snapshot on disk                            | ≤ 100 MiB | ≤ 1 GiB    | 39.73 / 606.31 MiB; pass |

Phase 4 refresh rows cover package and localization inputs; the saved joined-size reference is
unchanged. Joined refresh/query acceptance must be reconfirmed in Phases 5–6.

## STOP conditions

- The columnar join differs from the oracle on any line, and the oracle is not shown to be wrong.
- A target above cannot be met without a general database. Stop, record the measurements, and
  revisit the storage decision with them.
- The reader contract change would break a published consumer without a migration path.

## Verification

- Pure tests for the format, importers and join, including the oracle comparisons.
- `pnpm run check:precommit`; `cargo test --locked -p uasset-io` if native code changes.
- CLI integration tests with the native reader; Workbench main and extension tests.
- `pnpm test:localization-processes` and `pnpm test:uasset-engine-matrix` on UE 5.7 and 5.8 if the
  reader contract changes.
- The benchmark at 1× and 10×, and the real project read-only, before and after; Node 24 and 26.
- PR CI green and the PR review addressed.

## Evidence

Recorded per phase as it lands.

### Phase 1: scale harness, baseline and oracle

Recorded 2026-10-10 on Windows, Node 24.21.0, with seeded invented content. Tools and commands are in
[`scripts/game-text-scale.md`](../scripts/game-text-scale.md). The generator writes Dashboard
configuration, UTF-16LE manifest and archives, UTF-8 BOM/CRLF PO files, a review file and a
saved-text event stream. The benchmark replays the events through `AssetReader`'s test layer into
the production `TextCorpusService`, then reads evidence, joins with review and key changes, and
queries a status page and `localizationStatusReport`, each in a fresh child process.

**Generated inputs.** A streaming census confirmed every file's entry and event counts without
parsing whole files (1× in 13 s, 10× in 113 s).

|                         |               1× |                 10× |
| ----------------------- | ---------------: | ------------------: |
| Keys, cultures          |      132,606, 10 |       1,326,060, 20 |
| Packages (partial)      | 166,518 (15,400) | 1,665,180 (154,000) |
| Occurrences, gaps       | 1,028,205, 4.8 M |    10,282,050, 48 M |
| Generation              |           21.7 s |             521.7 s |
| Manifest                |            89 MB |              903 MB |
| Archives, all cultures  |           891 MB |             17.9 GB |
| PO files, all cultures  |           600 MB |             12.1 GB |
| Saved-text event stream |           2.0 GB |             20.4 GB |
| Total                   |           3.6 GB |             51.3 GB |

At 10×, Unreal's localization formats alone take 30.9 GB, and the per-gap reader protocol another
20.4 GB.

**Today's pipeline at 1×** (`baseline-1x-traced.json`; heap includes V8 pre-GC peaks, RSS is polled
by the parent; peaks include earlier stages' retained inputs):

| Stage                     | Default heap         | 16 GiB heap | Peak heap / RSS (GiB) | Retained heap |
| ------------------------- | -------------------- | ----------: | --------------------: | ------------: |
| Evidence                  | 72.3 s               |      70.4 s |           1.72 / 2.35 |      1.11 GiB |
| Corpus (event replay)     | 116.9 s              |     113.2 s |           2.53 / 2.91 |      2.24 GiB |
| Join, review, key changes | **OOM** after 25.3 s |      33.3 s |           5.51 / 5.94 |      3.77 GiB |
| Status page and report    | not reached          |      24.9 s |           6.25 / 6.59 |      3.77 GiB |
| Total                     | failed, 215.0 s      |     243.2 s |           6.25 / 6.59 |               |

The synthetic join has 583,507 lines (583,798 units against the real project's 574,848) and 102
key-change pairs. German: translated 128,539, not gathered 60,769, unknown 386,000, outside target
4,132, gathered only 1,048, not translated 1,340, not synced 1,476, not found 203. It is a
proportional workload, not a replica: invented words share strings differently, and the replayed
event stream skips the native package scan and the reader process's ~4 GB. Against the real
project's ~6 minutes, 3.4 GiB retained and 6.6 GB peak, it takes 4.1 minutes, retains 3.77 GiB and
peaks at 6.25 GiB.

**Today's pipeline at 10×: not run.** 1× already needs about 6.2 GiB of heap; ten times the lines
and twice the cultures would exhaust a 64 GB machine. A pre-crash attempt (`baseline-10x.json`)
stopped after 0.09 s at evidence: every 10× localization file exceeds the 320 MiB per-file limit,
and 1,326,060 entries exceed the 1,000,000-entry limit. The manifest's 451.6 million UTF-16 code
units would also be 84% of V8's maximum string length. The benchmark now refuses scale 10 or
above, caps children at 16,384 MiB of heap, 20 GB RSS (polled from the OS, so it works while
JavaScript is blocked; the process tree is killed) and 20 minutes per stage.

**Oracle.** `scripts/localization-join-oracle.test-support.ts` compares joins line by line by
stable ID, keeping target culture order and treating origins and reasons as sets. Tests show
identical and reordered joins compare equal, and that changed identities, origins, sources,
states, facts, reasons, key changes, archive/PO/pending translations, and missing or extra lines
are each reported, with a bounded list.

**Verification.** `pnpm exec vitest run scripts/game-text-scale.test.ts packages/localization
packages/game-text`: 350 passed, 0 failed, 4 skipped (environment-gated). The 15 new tests use
scale 0.001. `pnpm run check:precommit` passed. A tiny generate-and-benchmark smoke run passed at
the default heap and at 256 MiB. No parser, reader, fixture or Unreal integration changed, so
UE 5.7 and 5.8 checks do not apply. Node 26 and the full `pnpm check` were not run for this phase.

### Phase 2: lazy snapshot format and streaming file store

Recorded 2026-10-10 on Windows, Node 24.21.0 and 26.11.1. The pure codec and Effect Node store
remain in Game Text, available to libraries/CLI without a Rust protocol change or new dependency.
The guide describes the reusable APIs; current importer/join semantics remain Phases 3–5.

**Layout and lifecycle.** Version 3 stays in `game-text-v1`; old generations require rebuilding.
Open reads the checksummed header/directory. Source text, identities (keys, namespaces, line/
occurrence IDs), each culture, paths and comments have independent contiguous string domains.
Blocks target raw bytes, including offsets; a small block-start-ID column supports binary lookup.
Pages read only touched blocks. Bulk loads use 64 MiB reads including padding, sequential bounded
zstd frames, per-block CRC/UTF-8/boundary checks, and one byte buffer plus block indexes per domain.
Native UTF-8 validation and raw-sized zstd output chunks avoid redundant JS string/buffer allocation.
Caps remain 128 MiB/section and 16 GiB/file or bulk domain; the 16 KiB trial needs 1,048,576 sections/96 MiB directory.
Writers stream, fsync/rename, verify, then atomically publish the manifest under the owner/PID lock.
Scoped readers pin handles across retirement; typed failures, quarantine and crash recovery remain.

**Scale data.** Replayed saved raw 1× sections: 583,507 lines, 1,028,205 occurrences, ten cultures.
No join or project regeneration. Source UTF-8 is 72.52 MiB, identity UTF-8 250.44 MiB, kept cold.
Paths preserve the original 2,383,209 / 23,832,090 strings at 1×/10×. The synthetic probe scales
measured domain bytes to 5,835,070 lines, 10,282,050 occurrences and twenty cultures. Invented
compressible strings preserve widths; ratios do not forecast real content. Selected 10× creation:
79.14 s, 394.1 MiB peak RSS. All children respect the heap/RSS/stage limits below.

**Cause.** The 24.65 s profiled 10× paths load spends 16.0 s in native zstd/buffer allocation and
teardown plus 2.0 s in GC as thousands of separately retained buffers accumulate; disk idle is <1 s.
CPU profile and raw JSON live under `test-results/game-text-scale`; the old layout was profiled first.

**Decision.** Choose 256 KiB: fewest frames, smallest files and fastest loads; pages and hot opens
remain at least comparable to the previous 2.32/9.55 ms and 97.30/868.65 ms. Keep zstd level 1 for
numeric columns and level 3 for strings, with raw fallback. Bulk times below load string bytes only.

| Scale | Block KiB | File MiB | Page ms | Source load ms | Culture load ms | Paths load ms |
| ----- | --------: | -------: | ------: | -------------: | --------------: | ------------: |
| 1×    |        16 |    64.10 |    2.62 |         151.62 |           29.64 |        249.47 |
| 1×    |        64 |    57.18 |    2.46 |         102.39 |           18.97 |        182.66 |
| 1×    |       256 |    54.36 |    2.28 |          75.03 |           14.86 |        144.89 |
| 10×   |        16 |   772.86 |    6.36 |        1748.24 |          406.97 |       2684.88 |
| 10×   |        64 |   737.54 |    3.47 |        1087.71 |          262.10 |       1803.95 |
| 10×   |       256 |   684.41 |    2.82 |         820.91 |          200.51 |       1451.44 |

| Section group                    | 1× raw MiB | 1× chosen MiB | 10× raw MiB | 10× chosen MiB |
| -------------------------------- | ---------: | ------------: | ----------: | -------------: |
| Numeric columns                  |      73.93 |          7.52 |     1295.80 |          82.46 |
| Source text + block index        |      74.68 |          3.12 |      746.84 |          36.63 |
| Identity strings + block index   |     257.35 |         14.41 |     2573.51 |         114.46 |
| Cultures, IDs/overrides + blocks |     168.14 |         10.17 |     3362.84 |         266.20 |
| Paths, occurrence IDs + blocks   |     125.94 |         18.92 |     1259.35 |         181.89 |
| Comments/review/change           |       0.32 |          0.01 |        3.19 |           0.02 |
| Directory / alignment            |       0.23 |          0.23 |        2.76 |           2.74 |
| **File total**                   | **700.59** |     **54.36** | **9244.29** |     **684.41** |

**Production store/reader, Node 24.** Hot selection remains source/identity IDs, origins, occurrence
indices, culture states and only the picked culture’s flags. Other strings/flags remain lazy.
Times are incremental with no OS cache eviction; memory follows GC/async cleanup. Scans lowercase
strings and count substring matches: `TALUMA` at 1×, `SOURCE` at 10×, `/` for paths. Page ID columns
load separately before the 300-value decode; bulk domain buffers remain explicitly reachable.

| Operation                           |  1× ms | Heap / buffers / RSS MiB |  10× ms | Heap / buffers / RSS MiB |
| ----------------------------------- | -----: | -----------------------: | ------: | -----------------------: |
| Directory only                      |  11.76 |       38.6 / 3.4 / 140.2 |   74.00 |       44.1 / 3.2 / 176.9 |
| Load hot columns                    |  63.17 |      38.8 / 32.1 / 202.5 |  578.57 |     42.7 / 347.4 / 523.3 |
| Bulk source text                    |  78.29 |     38.8 / 106.7 / 277.9 |  832.99 |   42.9 / 1094.3 / 1270.7 |
| Scan source text                    | 108.48 |     38.9 / 106.7 / 278.9 | 1020.12 |   42.9 / 1094.3 / 1271.9 |
| Bulk one culture translations       |  15.26 |     38.9 / 123.7 / 294.9 |  203.28 |   42.9 / 1263.7 / 1440.3 |
| Scan one culture translations       |  25.87 |     38.9 / 123.7 / 295.4 |  241.95 |   42.9 / 1263.7 / 1440.9 |
| Bulk all paths                      | 146.51 |     37.3 / 231.7 / 403.4 | 1398.50 |   42.9 / 2343.9 / 2520.9 |
| Scan all paths                      | 380.26 |     37.3 / 231.7 / 403.7 | 4124.67 |   42.9 / 2343.9 / 2517.2 |
| Page ID columns                     |  73.67 |     37.3 / 251.9 / 452.2 |  470.89 |   43.0 / 2545.5 / 2723.7 |
| Decode 50-line strings (300 values) |   2.39 |     37.4 / 251.9 / 450.8 |    3.43 |   43.0 / 2545.5 / 2725.1 |

10× loads reach 897/833/772 MiB/s, about 1.6–1.9× zstd time; required validation and output copies
explain the remainder. Components below exclude index/setup; scans decode/lowercase strings.

| Domain  | 1× zstd ms | Verify + copy ms | Read ms | 10× zstd ms | Verify + copy ms | Read ms |
| ------- | ---------: | ---------------: | ------: | ----------: | ---------------: | ------: |
| Source  |      41.52 |            34.19 |    0.84 |      525.19 |           293.84 |    8.71 |
| Culture |       7.80 |             6.62 |    0.34 |      126.62 |            71.44 |    2.94 |
| Paths   |      92.52 |            49.30 |    3.01 |      826.42 |           536.27 |   28.33 |

| Measurement                               |                       1× |                        10× |
| ----------------------------------------- | -----------------------: | -------------------------: |
| Publish, including persisted verification |                   3.92 s |                    43.03 s |
| Publish peak RSS                          |                300.1 MiB |                  547.1 MiB |
| Directory + hot open                      |                 74.93 ms |                  652.57 ms |
| Reader peak V8 heap / buffers / RSS       | 96.7 / 316.2 / 464.0 MiB | 76.2 / 2648.8 / 2756.8 MiB |
| Node 26 directory + hot / page            |          77.42 / 2.11 ms |           658.02 / 2.45 ms |
| Node 26 reader peak heap / RSS            |         67.6 / 459.4 MiB |          77.7 / 2763.2 MiB |

**Targets and verification.** Chosen-layout disk/V8 heap targets and page latency pass at both
scales. These are format/reader probes; complete count/filter/facet queries, refreshes and lossless
hydration remain Phases 3–6. RSS is separate from the V8 targets; identity bytes remain unloaded.

| Verification command                         |                          Passed | Failed |
| -------------------------------------------- | ------------------------------: | -----: |
| Targeted Vitest format/file/store/scale      |                              88 |      0 |
| Required Vitest localization/game-text/scale |                 423 (4 skipped) |      0 |
| Node 26 Vitest format/file/store             |                              72 |      0 |
| 10× CPU profile                              |                           1 run |      0 |
| Benchmark `reblock1` / `synthetic10`         |                      3 / 3 runs |      0 |
| Benchmark `probe`                            |                          6 runs |      0 |
| Benchmark `publish` / `open`                 |                      2 / 4 runs |      0 |
| `pnpm run effect:architecture`               |                          1 gate |      0 |
| `pnpm exec oxfmt` changed files              |                        19 files |      0 |
| `pnpm run check:precommit`                   | 6 stages; 43 architecture tests |      0 |

No Rust, parser, reader contract, codegen, fixture or Unreal integration changed: Rust and UE
5.7/5.8 checks do not apply. Full `pnpm check` was not run; the requested gate is `check:precommit`.
All scale children ran singly with 16,384 MiB heap, 20 GB RSS and 1,200 s stage caps.

### Phase 3: A64 shared-store integration

Recorded 2026-10-10, Windows / Node 26.11.1. Cold import, ordinary PO refresh and size targets
pass; the reader reference gaps remain explicit. Retained projects/saved joins were reused;
no regeneration, 1× join rebuild or legacy 10× pipeline. Heap cap 16,384 MiB/process, total RSS
20 GB; one heavy child at a time. Every 10× command has one absolute 900 s startup-to-cleanup
deadline; expiry is failure. Cold plus stat/edit/restore completed in 677.76 s.
Times are single runs without OS cache eviction; cold means an empty derived store.
Largest child RSS was 8.58 GiB during projection; observed concurrent verification stayed below
20 GB. Content-hash keys, stat fast path, CRCs, oracle comparisons and atomic generations remain.

Profiled in the required order. Cold per-file probes grew with existing segments: en/de/fr
PO at 10× spent 2.980/3.944/3.778 s probing 4/7/9 previous segments. Cold now parses eight workers,
then externally sorts 64 MiB runs once and publishes one sorted segment per domain with every
layer atomically: zero segment probes. Measured largest-worker incremental RSS 248/692 MiB;
2 GB minimum worker budget and 4 GB coordinator reserve; peak cold RSS 2.45/6.77 GiB.

Mixed-domain expansion dominated the reader profile. Domains now decode straight into contiguous
UTF-8 plus typed offsets; scans fold bytes, with Unicode casing fallback only where needed.
Source has 933.74 MB/6.96 million owned strings including native input; front-code reconstruction
adds CPU over Phase 2's direct zstd buffers. First-page ranks touch 243 frames instead of four.
8 MiB decoded caching thrashes; 32 MiB retains 249 blocks/16,399,140 bytes and restores repeat
pages to 0.88 ms. First-page and bulk reference gaps remain explicit.

Refresh profile: prior ID reuse 7.043 s, parse/finish 10.963 s, verification 0.045 s. SHA-256
local-block stamps and remappable ID vectors skip unchanged-block hydration; changed blocks
reuse exact old bytes, including now-explicit source-equal translations. Reuse falls to
0.504 s. Identity fallback covers broad edits/old stores. Hash/parse already share one read;
verification remains because it is cheap. Ordinary edits pass; the CPU-profiled 21.41 s run misses
20 s (13.573 s parse/1.248 s finish). Entry-boundary parse workers could add margin; not measured.

| Whole index MiB                          |    1× compacted |    10× full width |     10× compacted |    10× four edits | 10× full-width forecast |
| ---------------------------------------- | --------------: | ----------------: | ----------------: | ----------------: | ----------------------: |
| Dictionary / indexes / directory         |           11.06 |            129.93 |             95.14 |             95.14 |                  150.60 |
| Active localization / join layers        |           18.81 |            335.68 |            335.63 |            335.63 |                  335.68 |
| Package proxy / publication / stat hints |            2.87 |             28.35 |             27.26 |             27.26 |                   28.36 |
| Retained inactive layers                 |            0.00 |              5.43 |              0.00 |             21.79 |                   21.79 |
| **Whole / target**                       | **32.74 / 100** | **499.40 / 1024** | **458.03 / 1024** | **479.82 / 1024** |       **536.43 / 1024** |

The full census exactly matches 78,066,945 strings / 7,707,973,974 UTF-8 bytes; compaction
leaves 51,981,412 / 5,733,848,265. Forecast takes the largest of full measured dictionary bytes,
per-owner payload×UTF-8 and index×count scaling, or compact dictionary×1.501824, then the largest
measured layers/proxy/metadata/retained bytes. No pruning credit. Package proxy remains an
estimate; synthetic compression does not establish real-content or complete Phase 4 size.

| Operation                                     |                      1× |                     10× | Target / result                                           |
| --------------------------------------------- | ----------------------: | ----------------------: | --------------------------------------------------------- |
| Cold target                                   |          29.18 s; 21/21 |         647.36 s; 41/41 | ≤38 / ≤696 s: pass                                        |
| Stat-hit target                               |                 0.088 s |                 0.190 s | ≤5 / ≤30 s: pass; zero authored bytes                     |
| Fresh one-byte PO                             |                  1.95 s |  16.04–17.67 s ordinary | 10× ≤20 s: ordinary pass                                  |
| Fresh PO with CPU profiler                    |                       — |                 21.41 s | misses 20 s; retained diagnostic                          |
| Edit lookup / reused local strings            |             1 / 396,093 |           1 / 3,960,855 | only one new string looked up                             |
| Compaction / saved projection                 |         17.27 / 19.60 s |       220.73 / 333.66 s | 14 / 26 domain segments; no join rebuilt                  |
| Directory / hot columns                       |        12.75 / 57.95 ms |       41.79 / 383.01 ms | 10× query/open ≤1 s: pass                                 |
| Reader peak V8 heap, sampled and pre-GC trace |               71.82 MiB |               99.93 MiB | ≤128 / ≤256 MiB: pass                                     |
| Source / culture / paths load                 | 0.125 / 0.001 / 0.399 s | 2.638 / 0.274 / 1.573 s | 10× references 0.83 / 0.20 / 1.40 s: gaps explained above |
| Source / culture / paths scan                 | 0.057 / 0.002 / 0.081 s | 0.858 / 0.050 / 0.451 s | 10× ≤1 s: pass                                            |
| Page columns / 300 strings                    |         40.63 / 5.44 ms |      385.55 / 106.51 ms | 5.75 ms reference first-page gap explained                |
| Repeat 300-string page                        |                 0.45 ms |                 0.88 ms | faster than 5.75 ms reference                             |
| Page frames / bytes                           |              2 / 18,800 |         243 / 1,765,028 | only touched blocks decoded                               |
| Native folder query / hydration oracle        |       82.51 / 154.21 ms |     439.62 / 1167.20 ms | 131,558 / 1,315,580 matches; oracle agrees                |
| Saved folder range / scan oracle              |       66.56 / 273.32 ms |      378.17 / 815.56 ms | /Game/: 1,159,763; Package: 1,315,580                     |

Verification: focused **69/0**; requested Vitest **510/0**, four skips; Node 26 **175/0**;
builds **2/0**, compiled worker smoke **3/0**; oxfmt **15/0**; precommit **6 stages/0**, including
**43/0** architecture tests and four contract packages. Final benchmark commands **10/0**;
11 earlier diagnostic/iteration commands **11/0**, excluded from final acceptance. Initial
focused **59/1** and type/lint errors were fixed. UE 5.7 output oracle **7/0**; UE 5.8 **7/0**.
No live editor/UAsset matrix or full `pnpm check`: no engine API, UAsset parser, codegen or fixture
changed. Remaining work: first-page locality, bulk reference gaps and refresh profiling margin,
complete package fields and Phases 4–7. This passes cold/ordinary-refresh/size acceptance, not
every reader reference. [Stage profiles and commands](../docs/engineering/game-text-shared-index-measurements.md).

### Phase 4: package columns, signature refresh and measured shared storage

Recorded 2026-10-10, Windows / Node 24.21.0 for layer measurements; final verification on
Node 26.5.0. Retained generated inputs only; no real project, regeneration or legacy 10×
corpus build. Reader v1.8 and gather rule v1.9 are unchanged. Heavy commands run serially with
16,384 MiB heap/process, 20 GB RSS and an absolute 900 s deadline per 10× command, including
startup and cleanup. All six measured commands finish; none hits a cap or STOP condition.

**Frozen gather evidence.** Select the saved gather flag (`0x00040000`), non-empty summary
text or external actor/package relationships. TextProperty added zero fixture candidates and
remains dropped. Prior source checks locate `ObjectMacros.h` at 123 / 148 / 151, `Text.cpp` at
1024 / 1060 / 1103 and the loaded-package commandlet condition at 779 / 382 / 388–389 for
4.27 / 5.7 / 5.8. Full source paths/lines and the original per-root audit remain in
[the measurement guide](../docs/engineering/game-text-shared-index-measurements.md).
The twelve committed roots retain 116 units / 137 occurrences across 103 packages, with 59
selected and 44 excluded; two selected gaps and excluded `DA_Native.OpaqueValue.Value` remain
explicit. Prior retained UE 5.7 and 5.8 audits each retain 62 units / 71 occurrences.

**Decisions.** Occurrence strings, signatures and gap coordinates become shared source,
identity and path IDs. Package columns preserve status (`complete`, `partial`,
`not_gatherable`, error), bytes, decode errors, reason counts and samples. Fixed 256 path shards
bound replacement work. Callers supply opaque Project Index signatures and header evidence
from the same inventory generation; no second package scan. Digest keys include selection:
flag and external-reference transitions invalidate reuse. Refresh reads only changed/new
selected packages, handles removals and renames, and atomically publishes affected shards
under the shared writer lock. Eight workers prepare cold columns; one target-wide 64 MiB
external sort deduplicates strings, reusing existing IDs without another string sort.

**Oracle and records.** The reusable layer helper compares decoded corpora against today's
full event corpus and selected events with documented `not_gatherable` coverage. Every
committed root and three tiny generated targets pass, including actual stream conversion.
LF-only NDJSON framing preserves U+2028/U+2029. Conversion flags all 16,500 / 165,000 text
packages, leaving 150,018 / 1,500,180 others unflagged. It preserves 1,028,205 / 10,282,050
occurrences and 4.8 M / 48 M gaps; the retained stream has no original package flags.

Whole-index sizes after both edits, MiB. Actual package/localization layers and the saved
Phase 2 joined-size reference share one dictionary. Every declared Phase 2 string width is
imported, including unused variants; compaction supplies no pruning credit.

| On disk                               |              1× |                10× |
| ------------------------------------- | --------------: | -----------------: |
| Package occurrence/coverage layers    |            4.47 |              29.55 |
| Localization layers                   |           14.69 |             289.01 |
| Joined layer, saved size reference    |            4.12 |              46.63 |
| Shared strings and lookup metadata    |           11.14 |             166.95 |
| Active subtotal                       |           34.42 |             532.14 |
| Retained files, publication and hints |            5.31 |              74.17 |
| **Physical total / target**           | **39.73 / 100** | **606.31 / 1,024** |

Times and peak heap/RSS (MiB). Heap includes pre-GC trace peaks per isolate; RSS covers worker
threads in the supervised process. Single runs without OS cache eviction; cold means new
package layers, with empty-store and whole-store adoption measured separately.

| Operation                        | 1× seconds; heap / RSS | 10× seconds; heap / RSS | Target, 1× / 10×         |
| -------------------------------- | ---------------------: | ----------------------: | ------------------------ |
| Retained stream conversion       |     36.40; 231 / 2,498 |     481.95; 390 / 3,504 | Each 10× run ≤900 s      |
| Cold package layer, empty store  |     21.63; 316 / 2,659 |     191.35; 899 / 4,059 | Bounded build            |
| Cold adoption into whole index   |     41.30; 363 / 2,648 |   700.39; 1,188 / 6,039 | Each 10× run ≤900 s      |
| No-change package refresh        |        0.24; 137 / 652 |       1.81; 492 / 2,074 | Zero package reads       |
| No-change package + localization |        0.43; 142 / 681 |       2.18; 534 / 1,467 | ≤5 / ≤30 s               |
| One changed package, whole store |        1.19; 147 / 695 |      19.52; 603 / 2,453 | Exactly one package read |
| One package + one-byte PO edit   |        3.52; 193 / 764 |      39.13; 806 / 2,494 | ≤10 / ≤60 s              |

Standalone package layers are 4.48 / 31.24 MiB plus 2.35 / 22.65 MiB shared strings after one
edit; whole-store IDs compress differently. Combined refresh parses only the changed PO
(62,510,683 / 632,193,682 bytes), reads one package and restores the PO byte. End-to-end 10×
commands take 483.71 s conversion, 219.93 s standalone build/refresh and 772.78 s integrated
build/refresh/size. Peak measured heap 1.16 GiB/isolate and RSS 5.90 GiB stay below caps.
The guide records every stage peak, exact byte sizes, commands and iteration failures.

**Verification.** Vitest passes **849 / 0 / 7 skipped** on Node 24.21.0 and again on
Node 26.5.0 (95 files pass, three skip), including every requested package/extension, scale,
import, dictionary, package-text and native CLI integration test; package-layer tests **21 / 0**.
Changed-file oxfmt and all **six precommit stages pass / 0 fail**, including **43
architecture tests / 0 fail** and contract checks in all four packages. Effect architecture
passes after registering the scope-owned Node worker adapters (initial check: three errors).
Rust, reader, fixtures and engine integrations are unchanged: cargo and UE 5.7/5.8 matrix lanes
are not rerun; prior 13/0 native results per engine remain documented, not claimed as new checks.
Full `pnpm check` was not run. Changeset: `package-text-shared-layer` (Game Text patch).

**Complete.** Phase 4 done; Phase 5 next. Joined-layer implementation and joined refresh,
host and query acceptance remain later work.

### Phase 5: columnar merge join and incremental refresh

Recorded 2026-10-10–11, Windows / Node 24.21.0. Retained generated projects and Phase 4 caches
were reused; no real project, regeneration or Git history operation. One heavy process at a
time, 16,384 MiB heap/process, 20 GB parent-plus-child RSS. Initial full and final incremental
10× commands take 332.55 / 295.45 s, below the absolute 900-second startup-to-cleanup cap.
The object join never runs at 10×. Detailed input, byte, peak and command tables are in
[`game-text-shared-index-measurements.md`](../docs/engineering/game-text-shared-index-measurements.md#phase-5-columnar-join-and-incremental-refresh).

**Implementation.** Sorted numeric namespace/key permutations merge package occurrences,
manifest and culture rows. Bulk UTF-8, offsets, permutations, unit memberships and output
columns use external buffers/typed arrays. Decode strings for namespace stripping, literal
String Table ownership, gather/path rules, source metadata/conflict ordering, key-change
places, notes/long-text signals, review fingerprints and bounded hydration; ordinary identity
and translation comparisons stay on IDs. Gathered occurrence identity follows `gathered-text.ts`;
`%LOCPROJECTROOT%` and `not_gatherable` use today's coverage/diagnostic precedence. Snapshot
columns retain original manifest/archive/PO references, states/facts/reasons, problems, review,
pairs and namespace/file/folder/origin/editing/notes facets. Full raw-unit facets survive
identity slicing. The cache key includes project root and string-ID generation; compaction
rejects stale reads and forces an equal full rebuild. Folder IDs use shared A64 path ranks; labels are interned in batches and
equal physical columns share aliases. Hydration is capped at 10,000 lines. Hosts remain Phase 6.

**Equality.** Import and package-layer oracles first validate identical inputs; the Phase 1
line oracle then compares every field, including metadata, pending PO, review and key changes.
Tiny/fixture cases also compare problem bits and all facets with today's query behavior.

| Input                                                                                           | Result                                                             |
| ----------------------------------------------------------------------------------------------- | ------------------------------------------------------------------ |
| `fixtures/unreal-project`, `fixtures/legacy-unreal-project`, `fixtures/unreal-427-localization` | Each equal, every target                                           |
| Legacy `Generated/4.27`, `Generated/5.3`                                                        | Each equal, every target                                           |
| Perforce baseline, add-arrival, conventional-baseline, conventional-move-actor                  | Each equal, every target                                           |
| Perforce label-north, move-east, two-unclassified-package-edits                                 | Each equal, every target                                           |
| Seed 57, 0.0001 / 0.001; no/current/changed review                                              | Every line equal in each case                                      |
| Semantic absence/partial/excluded/table/keyless/outside/gathered-only cases                     | Equal; all three key-change tiers, ambiguity and split-unit facets |
| Two successive package/PO edits                                                                 | Object oracle equal; flat overlay equals every full column         |
| Saved 1× oracle                                                                                 | 583,507 / 583,507 lines equal; zero differences                    |

Today's 1× object join ran once, saving a 2,786,473,773-byte NDJSON oracle. Evidence/corpus/
join-and-save take 50.13 / 73.51 / 44.48 s, peak heap 5.38 GiB / RSS 5.71 GiB. The first
comparison reuses that file: 802.69 s, heap 7.02 GiB / RSS 8.49 GiB. Final-layout reuse passes all 583,507 lines in
525.93 s (538.00 s end to end), heap 6.65 GiB / RSS 7.67 GiB; zero differences. No oracle correction is claimed: Phase 4 header exclusions move 203 raw-baseline
not-found lines to unknown and remove provable key pairs, as the saved object oracle confirms.

**10× checks.** All 20 cultures equal the independent seeded census: translated 1,285,401;
not_translated 13,390; not_synced 14,759; not_gathered 607,690; gathered_only 10,480;
outside_target 41,320; unknown 3,862,030; other states zero. Total 5,835,070; keyless
3,860,000; zero pairs/ambiguities because old-key packages are header-excluded. Every culture
column is complete; IDs, input/review/pair references and bit masks are valid; permutations
exhaust occurrence/manifest rows. File/folder memberships cover every line once. Folder counts
sum to all lines: Content 5,783,270, Source and Config each 5,240, L10N 41,320. This proves
construction counts and structural integrity, not arbitrary 10× object-model content equality;
true absence/review/pair semantics are covered separately by the line oracle.

**Decision.** Full package-plus-PO refresh takes **11.00 / 167.99 s**, failing ≤10 / ≤60 s.
Stable source/PO edits now recompute changed identities in one flat overlay, bounded to 8,192
accumulated rows over one retained full layer. Structural/coverage, manifest/archive, review,
generation, short-source, conflicting-source and absence-candidate changes fall back to full
rebuilds; measured latency does not cover every fallback. Forced full proofs equal SHA-256 of
all **94 / 164 logical columns** at 1× / 10×, including row references/facets: zero differences.
No-change refresh parses no files, reads no authored bytes and does not rebuild the join.

| Measurement                                 |                           1× |                            10× | Target / result                        |
| ------------------------------------------- | ---------------------------: | -----------------------------: | -------------------------------------- |
| Cold join                                   |                      11.14 s |                        99.99 s | Input layers already present           |
| Peak cold heap / array buffers / RSS, MiB   | 177.30 / 1,137.89 / 1,397.89 | 684.28 / 14,494.49 / 15,049.06 | Pre-GC heap included; total RSS <20 GB |
| Cold joined layer                           |                   10.723 MiB |                    112.427 MiB | Included in whole index                |
| Package + fresh PO parse + incremental join |                       4.49 s |                        44.02 s | ≤10 / ≤60 s: pass                      |
| No-change refresh                           |                       0.58 s |                         2.17 s | ≤5 / ≤30 s: pass; zero rebuilds        |
| Whole index after refresh                   |                    51.08 MiB |                     724.70 MiB | ≤100 / ≤1,024 MiB: pass                |
| Physical index after retaining full proof   |                    61.81 MiB |                     837.13 MiB | Both still pass                        |
| Final command including proof/cleanup       |                      30.52 s |                       295.45 s | Every 10× run ≤900 s: pass             |

Physical accounting retains every Phase 2 width, layer, shared string file, publication and
stat hint; no pruning credit. After final oracle verification the 1× physical index is 72.55
MiB, still within 100 MiB. Single runs without OS cache eviction; cold is a fresh joined layer.

**Verification.** Native-enabled Vitest passes **872 / 0 / 7 skipped** on Node 24.21.0
and Node 26.11.1 (104 files pass, three skip), including all 16 join tests and compaction.
Oxfmt on 19 paths and all **six serial precommit stages pass / 0 fail**: architecture **43 / 0**,
contracts in all four packages. Effect architecture passes. The guide records corrected
iteration failures, including unequal PO inputs and query-helper mistakes; no same-input
semantic difference or STOP. Native reader/parser/fixtures/integration are unchanged:
UE 5.7/5.8 lanes are not needed or rerun. Full `pnpm check` was not run. Changeset:
`columnar-localization-join` (Game Text patch). **Phase 5 complete; Phases 6–7 remain open.**

### Phase 6: stopped on conflicting-source order (historical, resolved below)

Recorded 2026-10-11, Windows / Node 24.21.0 and 26.5.0. This pass stops before host adoption.
The applicable condition is **"The columnar join differs from the oracle on any line, and the
oracle is not shown to be wrong."** A new comparison supplies the original path-ordered package
records to the object oracle, rather than hydrating the oracle corpus from the package layers.
No real project, retained-project regeneration, 1× object build or 10× run occurs. Small test
inputs use invented text and disposable temporary files. No Git history operation occurs.

**Same-input reproduction.** Two complete, gather-flagged packages each contain one read-only
asset property, namespace `UI`, key `Shared`. The event order is the inventory's path order.
The package signatures and all occurrence fields supplied to the layer are identical to those
supplied to the object corpus. Neither package has a localization manifest row; the semantic
test target supplies fifteen other manifest identities, giving sixteen lines in each join.

| Original event / inventory order | Package                          | Shard | Source |
| -------------------------------- | -------------------------------- | ----: | ------ |
| First                            | `Content/Probe/Package00.uasset` |   247 | Alpha  |
| Second                           | `Content/Probe/Package01.uasset` |   230 | Beta   |

| Comparison                      | Matched lines | Different lines | Differences | Result                           |
| ------------------------------- | ------------: | --------------: | ----------: | -------------------------------- |
| Original events → object oracle |            16 |               1 |           1 | STOP                             |
| Layer-hydrated corpus → oracle  |            16 |               0 |           0 | Equal, but shares the reordering |

The differing field is `LocalizationLine.source` on `Cases:["UI","Shared"]`:
the event oracle returns **`Alpha Beta`**, while the index returns **`Beta Alpha`**.
All other compared fields agree. `loadJoinPackages` concatenates shard names in lexical order,
putting shard 230 before 247. Conflicting-source construction sorts by unit ID and then global
occurrence row; both occurrences share a unit ID, so shard order becomes source order.
The existing object join preserves first-seen source order within a unit. There is no evidence
that the oracle is wrong, and no contract change is authorized to hide the difference.

**Regression and recovery.** `scripts/columnar-join.test.ts` now retains this exact comparison
and demonstrates that an oracle hydrated from the layers misses it. The case is explicitly
`it.fails`: its final assertion still demands equality. An unexpected pass fails the test,
requiring removal of that annotation after the defect is fixed. Earlier sixteen join tests
retain their ordinary assertions. Resolve source ordering against the original event oracle,
then rerun Phase 5 equality before resuming Phase 6. The standalone reproduction result is
`test-results/codex/phase6-order-probe.json` (ignored).

**Contract finding.** The existing `LocalizationLine.source` value must survive host migration;
no public schema or host implementation changed. No index-backed host is claimed, no changeset
is added for unchanged package/app behavior, and the product's existing heap guidance remains
accurate for the still-unmigrated hosts. Refresh service, query scans, write invalidation and
host migration remain required.

Both CLI and headless Workbench measurements are **not run because of STOP**, at both scales:

| Measurement                      | 1× target | 10× target | This pass, both hosts |
| -------------------------------- | --------- | ---------- | --------------------- |
| First query after cold build     | Recorded  | Recorded   | Not measured          |
| First query with warm index      | Recorded  | Recorded   | Not measured          |
| Count / filter / facet / page    | ≤100 ms   | ≤1 s       | Not measured          |
| Search / focus                   | ≤100 ms   | ≤1 s       | Not measured          |
| Peak query V8 heap, default heap | ≤128 MiB  | ≤256 MiB   | Not measured          |
| No-change refresh                | ≤5 s      | ≤30 s      | Not measured          |
| One package + one PO refresh     | ≤10 s     | ≤60 s      | Not measured          |

**Verification.** Corrected join suites on Node 24.21.0 and 26.5.0 each pass the sixteen
existing tests and report one expected failure for this STOP. The unwrapped regression is
0 passed / 1 failed / 16 skipped, with the exact source difference. All six final precommit
stages pass, including 43 architecture tests and contract checks in four packages. Oxfmt on
all three changed paths and whitespace checks pass. An initial missing test import/typecheck
failure was corrected; setup now runs outside the expected-failure wrapper. The command ledger is in the
[shared-index measurement guide](../docs/engineering/game-text-shared-index-measurements.md#phase-6-stop-conflicting-source-order).
No new UE 5.7 or UE 5.8 check is claimed: integration/write/reader code is unchanged.
The requested full host/CLI/component/e2e and localization-process verification and the full
`pnpm check` are not run after this semantic STOP. Prior Data Authoring adoption failures are
retained history, not a new result. **Phase 6 is incomplete.**

### Phase 5: source-order correction and equality re-run

Recorded 2026-10-11 on Windows, Node 24.21.0 and 26.11.1. Today's ordering is deterministic:
`scanner.rs:251` sorts `PathBuf`s, `project_io.rs:568–637` assigns parallel work to path-indexed
slots and emits those slots in order, and `protocol_adapter.rs:482` retains that result order.
`project_io.rs:793` traverses exports in saved order; `asset-reader.ts:557–576` does not reorder
the stream. `corpus.ts:713–741` preserves occurrences within units, sorts distinct unit source
values, then sorts unit IDs with `localeCompare`. `gathered-text.ts:46–90` preserves the unit
and occurrence sequence. `localization.ts:355–360` folds distinct occurrence sources in insertion
order; it does not sort them or conflicts. The raw unit source-value sort does not order the
joined line's source. Final localization lines sort by line ID (`localization.ts:519`),
which does not reorder that fold.

Rust compares path components: `Content/A/B.uasset` precedes `Content/A.uasset`. The canonical
order reproduces that existing behavior, followed by saved traversal ordinal within each package;
it does not introduce an object/property re-sort. `package-text-order.ts` supplies the comparison.
The join ranks package paths independently of shard order and uses that rank plus occurrence
ordinal after unit ID ordering for conflicting-source folds. Layer hydration also sorts packages
before folding. Joined cache keys advance to `joined-v5` so old joins and overlays are rebuilt.
Changeset `preserve-package-source-order` records the Game Text patch; today's corpus behavior
and public schemas are unchanged.

The former `.fails` source-order assertion now passes ordinarily. Independent event oracles replace
layer-hydrated oracles for fixture, tiny-scale and targeted comparisons. Four source-order cases
cover two packages, four distinct shards, path-component ordering, and three occurrences inside
one package with object/property names deliberately reversed from traversal order. These four
cases compare the entire hydrated corpus directly, including ordered occurrence arrays.

| Equality surface                                            | Result on Node 24 / 26                |
| ----------------------------------------------------------- | ------------------------------------- |
| All twelve retained fixture projects                        | 12 / 0 each                           |
| Tiny generated scales 0.0001× and 0.001×                    | 2 / 0 each                            |
| Targeted semantics and incremental/full/compaction equality | 2 / 0 each                            |
| Independent source-order regressions                        | 4 / 0 each                            |
| Saved 1× oracle, final comparator, Node 24                  | 583,507 matched lines / 0 differences |

The final saved-file comparison took 363.74 s, with peak sampled V8 heap 4,933.42 MiB,
array buffers 1,087.85 MiB and RSS 5,518.55 MiB, within the 16 GiB heap / 20 GB RSS caps.
It reused `phase5-oracle/oracle-1x.ndjson`; no new object oracle or retained input was generated.
**Conflicting-source lines: 0; conflicting sources across packages: 0.** Duplicate sources in
that target belong to different identities; its prior 583,507-line equality could not expose
this source-order defect. This comparison is oracle verification, not a default-heap host query
measurement. Raw results: `test-results/codex/phase6-final-order-1x.json` and `.log`.

### Phase 6: stopped on findings for split gathered identities (historical, resolved below)

The first STOP condition now applies to a different same-input case. Two complete packages share
saved identity `UI [literal] / T`. The property occurrence strips the package namespace and gathers
as `UI / T`; the string-table entry keeps `UI [literal] / T`. Their sources, `Alpha source twenty four`
and `Beta source twenty four`, are each below the 40-character long-text threshold. Today's query
uses `localizationLineUnits` to slice the saved unit per gathered line (`query.ts:238–255`), then
computes length from that slice (`query.ts:83–105`). Neither line has a finding.

The join's raw-unit pass combines both sources (`joined-target.ts:313–334`), marks its representative
as a finding, and copies that bit to both lines (`joined-target.ts:799–825`). Both `line.problems`
values incorrectly include `finding`. Hydrated states, sources, key changes and translations still
match, so a line-schema-only equality check misses this column/API discrepancy. The unwrapped
Node 24 reproduction fails explicitly on `Cases:["UI","T"]`: expected `false`, received `true`.
The retained test prepares and validates both oracle negatives and both columnar positives in
`beforeAll`; only the equality assertion is `.fails`. It is independent of the four now-passing
source-order regressions. Existing raw-unit facet expectations also need review against the
actual sliced query API before migration.

No host/query refresh service or write invalidation is claimed. No public contract changed and
no CLI/Workbench/extension changeset is added. The product heap note remains because hosts still
build the corpus. The complete-inventory/signature capability is a refresh prerequisite to address
when work resumes, not the STOP condition. Measurements for both CLI and headless Workbench are
not run at either scale after this semantic STOP:

| Measurement                                    | 1× target    | 10× target  | CLI / Workbench at both scales |
| ---------------------------------------------- | ------------ | ----------- | ------------------------------ |
| First query, cold / warm                       | Record both  | Record both | Not measured                   |
| Count / filter / facet / page / search / focus | ≤100 ms each | ≤1 s each   | Not measured                   |
| Peak query heap, default heap                  | ≤128 MiB     | ≤256 MiB    | Not measured                   |
| No-change refresh                              | ≤5 s         | ≤30 s       | Not measured                   |
| One package + one PO refresh                   | ≤10 s        | ≤60 s       | Not measured                   |

Verification command counts and engine results are recorded in the
[measurement ledger](../docs/engineering/game-text-shared-index-measurements.md#phase-6-continuation-source-order-fixed-new-findings-stop).
Both Node host runs pass 990 tests with seven skipped; Game Text components pass 88.
Localization process verification passes separately on UE 5.7.4 and 5.8.3. Precommit passes
all six stages. Full `pnpm check` passes ten stages, then fails the pre-existing Data Authoring
adoption omission; the unchanged Game Text e2e scenarios fail all three stale UI expectations.
These failures are separate from the new semantic STOP, and no full-verification claim is made.
No real project, retained-input regeneration, commit, push, branch switch or stash was used.
**Phase 6 is incomplete; resolve the gathered-slice findings mismatch before host adoption.**

### Phase 6 continuation: differential fuzz and gathered-slice facts

Recorded 2026-10-11, Windows / Node 24.21.0. Before changing the findings calculation,
`node scripts/fuzz-columnar-join.ts 10000` tested seeds 0–9,999 against the original
event-built corpus, Phase 1 join comparator and `textCorpusQuery`. One test failed, exposing
ten distinct differing column fields in 520.47 s. The discovery run completed instead of
stopping on the first differing seed. It retained each first failing input as generic JSON
under `test-results/codex/phase6-fuzz`; bounded greedy shrinking removed packages, occurrences
and localization entries while preserving the chosen mismatch (at most 80 comparisons).
Four small, schema-validated persisted-store reproductions are retained in
`scripts/test-fixtures/columnar-join`. All four failed before the production fix.

The Mulberry32 generator depends only on its seed. Each input has 2–20 packages, 1–40
occurrences and 1–4 cultures. It mixes repeated saved identities inside and across packages,
equal/conflicting sources, property/DataTable versus String Table gathered slices, String
Table references, package namespace markers, keyless and unresolved identities, partial and
not-gatherable packages, review flags/fingerprints, old/new key candidates, project-root token
filters, excluded L10N and outside paths, duplicate/conflicting manifest/archive/PO identities,
empty translations and sources, 39/40/41-character sources, longer sources, LF and U+2028.
The oracle consumes the original records in native package emission order, never package-layer
hydration. The candidate uses the production package columns, localization parser/columns,
columnar join and bounded hydration. The normal suite tests 2,000 fixed seeds. The standalone
script accepts a seed count and first seed for longer local runs.

The fast storage adapter changes only persistence: it runs the production column producers,
global ID remapping, snapshot-directory codec and readers without per-seed filesystem root
publication/fsync. Eight representative seeds also run through the real persisted store,
including seeds 4, 5 and 198 that first exposed the defects. Localization parsing still uses
the real streaming builder and bounded temporary spill files in the fast lane.

Every join field uses the Phase 1 oracle rules. Query summary, search pages, counts, facets,
grouping, culture scopes, focus and localization focus compare recursively on every returned
field. Requests include text and translation searches, both edit capabilities, missing notes,
each review lens, path/file scopes, four groupings and a small page. Facts, reasons and flags
use the Phase 1 set comparison; source/comment order and every other array remain exact.
Problem and origin/editing/notes column membership is checked independently against oracle
filters. **This query comparison currently covers the hydrated query, not the future host
column query; the migrated implementation must be added before claiming Phase 6 complete.**

The ten field differences reduce to three root causes:

| Defect                                                                                         | First seed | Fixed reproduction / behavior                                                                     |
| ---------------------------------------------------------------------------------------------- | ---------: | ------------------------------------------------------------------------------------------------- |
| An empty-source saved unit contributes origins, editability and notes to a visible joined line |          4 | `empty-source-facets.json`: only searchable slices contribute query facets                        |
| Raw-unit origins, capabilities, notes and findings leak between separate gathered identities   |          5 | `split-facets.json` and `split-conflicting-findings.json`: each line uses its matching slice      |
| Two individually short gathered sources are classified using the raw unit's combined length    |        198 | `split-short-findings.json`, plus the former `.fails` test: each slice uses its own source length |

Finding membership now measures each gathered slice's distinct source values, excluding other
gathered lines from the raw saved unit. Duplicate-source membership follows its occurrence's
slice rather than propagating to every line containing the unit. Facets use only searchable
slice occurrences. Existing all-empty stored rows retain their legacy problem derivation,
although search omits those rows. No behavior of the documented object oracle changed;
`.changeset/gathered-slice-query-facts.md` records the index correction. Joined cache keys are
`joined-v6` so old derived facts are rebuilt; reader v1.8 and gather rule v1.9 are unchanged.

An additional `hidden-source-facets.json` regression checks an all-empty saved row. Such rows
have no query file/folder facets; the inspector now checks coverage against faceted rows and
the primary folder stores the empty ID, rather than the next row's folder. The fuzz lane also
runs the index's structural inspector before comparing the join and queries.

The expanded post-fix local run tested the same 10,000 seeds plus all eight persisted checks:
**9 tests passed / 0 failed**, 679.06 s end to end (676.40 s tests), zero differing fields.
The fixed persisted regressions and all Phase 5 fixture/tiny/source-order/split-findings tests
passed together: **25 passed / 0 failed**, 44.26 s end to end. The saved 1× recheck matched
**583,507 / 583,507 lines, zero differences**, 683.00 s for comparison / 696.72 s end to end;
peak pre-GC V8 heap 7,478.2 MiB and OS RSS 8,875.9 MiB (the permitted 16,384 MiB oracle heap,
not a default-heap host query measurement). The remaining command ledger follows below.
No generated inputs or retained
oracle were regenerated, and no real project was read.

Host migration, shared refresh, write invalidation and default-heap CLI/Workbench measurements
remain outstanding. The resolved findings STOP does not justify stopping that work. The
Data Authoring adoption failure and three stale Game Text e2e expectations remain separately
identified pre-existing failures, not new results of the commands above.

### Phase 6 continuation: column query, builder service and UTF-16 STOP

Recorded 2026-10-11, Windows / Node 24.21.0 and 26.11.1. The owner directed the future
default build into Rust. `GameTextIndexBuilder` now exposes the existing import, package
refresh and joined refresh signatures, dictionary intern/compaction and a scoped build
session. `typeScriptIndexBuilderLayer` is the correctness oracle/fallback. The selected
backend owns the writer lease, preventing a future native builder from reacquiring a
TypeScript-held lock. No TypeScript build-speed optimization was attempted.

The new library refresh service depends on this builder and a package inventory/event source;
it imports selected localization files, refreshes selected packages, hashes review state and
publishes the join within one lease. It returns a pinned generation and column query.
Its persisted integration test checks builder injection, unchanged-input reuse, selected PO
refresh, package refresh, review invalidation and old-generation readers. The production
Project Index inventory adapter and host wiring are still outstanding.

The query implementation uses numeric package/join/localization columns behind
`TextCorpusQuery`, plus bounded displayed-line hydration through an Effect cache. It covers
summary, search, counts, culture scopes, problems, filters, facets, grouping, cursor pages,
focus, localization focus/lines and explicit exports. The joined cache key is now `joined-v7`
for private query projections; public schema shapes, reader version and gather rule are
unchanged. Some facet/group scans still decode labels and focus lookup still scans IDs;
performance acceptance and query telemetry are not complete.

The first full-gate attempt on the new query code found seven new Effect architecture
violations: scattered synchronous runtime exits and an unnamed session operation. These
are separate from the pre-existing adoption failure. The synchronous Node IO/query bridge
is now isolated in `joined-query-node.ts`, with one named adapter entry in the architecture
checker and cleanup ownership documented in `docs/engineering/effect.md`. The session helper
uses `Effect.fn`. The focused Effect architecture gate passes; the full gate and differential
checks are rerun after this adapter refactor.

After that refactor, the source pool adds explicit LF/U+2028 and paired-astral strings
at 39/40/41 UTF-16 code units. The final longer run on Node 26 tests **5,000 seeds plus
eight persisted checks**, with all fixture/tiny, regression, refresh and snapshot tests:
**136 passed, 0 unexpected failures, 2 expected UTF-16 failures**, **656.06 s** end to end,
zero differing fields (`phase6-stop-final-fuzz-node26.log` and
`phase6-fuzz/run-v26.11.1-0-5000.json`). This is the final expanded generator and actual
column-query implementation, not just hydrated queries. Reports now retain per-runtime,
first-seed and seed-count filenames alongside the last-run ledger.
The final normal set on Node 24 uses the same expanded pool: **2,000 seeds plus eight
persisted checks**, **136 passed, 0 unexpected failures, 2 expected UTF-16 failures**,
**315.64 s**, zero differing fields (`phase6-stop-final-fuzz-node24.log` and
`phase6-fuzz/run-v24.21.0-0-2000.json`). Final unwrapped assertions still fail exactly the
two surrogate reproductions on each Node version. Final precommit passes all six stages,
including **43 architecture tests / 0 failures**. The seven initial architecture violations
are resolved; the full-gate rerun is recorded separately in the measurement ledger.
The final `pnpm check` passes the preceding native/WASM, package builds, type, Effect
architecture, license, StyleX, architecture, release and packed-consumer stages, then
fails only the known Data Authoring adoption build omission:
`packages/protocol/src/index.ts:163`, missing `./editor-foreground-responsiveness.js` in the
materialized consumer. There are no additional TypeScript diagnostics. Totals before that
stage are **356 Rust passed / 0 failed / 4 ignored**, **43 architecture passed / 0 failed**,
**42 release passed / 0 failed**, and **20 packed tarballs / 0 failures**. The protocol export
and adoption manifest are unchanged from HEAD. Full-gate lint/format/contracts/whole-suite
tests do not run after the adoption failure; final precommit and targeted runs supply their
separate checks. This is not a full-gate pass (`phase6-stop-full-check-fixed.log`).

The following continuation records the historical state before the owner's WTF-8 decision;
the later implementation and verification supersede its STOP and host-migration status.

The differential harness now exercises this actual column query as well as the original
event query and hydrated comparison. It compares every recursive output field, adds export
metadata and full localization lines, cycles all nine filter fields, tests review/key-change
filters, localization cursors and opened asset groups. Discovery retains every distinct
differing field instead of stopping at its first seed. Shrinking is bounded to 80 comparisons
per output family/seed; both the normal test and the local shrink script print the reduced
JSON and save it. The normal suite remains 2,000 fixed seeds; the local script accepts longer
runs. The generator uses valid Unicode including U+2028. Lone surrogate cases below are
separate fixed reproductions, so a clean randomized run does not assert those cases pass.

Before the adapter refactor and source-pool expansion, a local run used seeds 0–4,999 plus eight persisted checks against the
column query: **9 tests passed / 0 failed**, **716.29 s** end to end, and zero differing
fields (`phase6-column-query-fuzz-5000.log`). The earlier
10,000-seed runs on Node 24 and Node 26 covered the join and hydrated query. They are
reported separately rather than overstating the number of final column-query seeds.
The final Node 26 run adds the normal 2,000 column-query seeds and eight persisted checks
to the fixture/tiny, regression, builder-refresh and snapshot suites: **136 passed,
0 unexpected failures, 2 expected UTF-16 failures**, 248.56 s end to end. The same targeted
checks on Node 24, separately from its 5,000-seed run, are **127 passed, 0 unexpected
failures, 2 expected UTF-16 failures**, 32.51 s. Both unwrapped surrogate assertions fail
on both versions (**0 passed / 2 failed** each).
`phase6-fuzz/latest.json` records the last completed run. Per-runtime/count reports retain
the final expanded runs independently, so a later normal-suite run does not erase their evidence.

Additional findings during implementation:

| Defect                                                                                                    | Resolution / fixed evidence                                                                                                                             |
| --------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Asset grouping used package emission order for a joined line's first file                                 | Preserve sorted saved-unit ID order; `asset-group-unit-order.json`, first exposed by seed 0                                                             |
| Incremental query projection updated a String Table reference's own source when its authored line changed | Update a projection only when its own member occurrence changed; full-column incremental/full rebuild equality test passes                              |
| New source-word projection read a manifest string segment before loading it                               | Include manifest sources in the bounded string request; fixture/tiny tests pass                                                                         |
| Export oracle adapter emitted excluded packages in hash-shard order                                       | Correct the test adapter to native path byte order; `excluded-package-order.json`. This was an adapter false positive, not a production behavior change |

The original combined-source findings, gathered-slice facts and empty-source facet defects
remain fixed, with individual persisted tests and the former findings `.fails` test passing.
The Phase 1 event oracle and its deterministic behavior have not been changed.

**STOP: source fidelity for a lone UTF-16 surrogate.** Two minimal schema-validated fixtures
are retained: `lone-utf16-source.json` (two packages, one saved occurrence, one culture) and
`lone-utf16-localization.json` (the same ordinary saved source plus an escaped lone surrogate
in manifest/archive JSON). The object join retains `"\ud800"`; dictionary encoding through
`Buffer.from(value, "utf8")` irreversibly changes it to U+FFFD. The latter reproduction fails
the existing localization importer/parser equality assertion before joining. The former
differs in `join.source`, localization lines, focus and raw/localized exports. This is also
a collision with a literal U+FFFD value, not just presentation.

The documented A64 format contains validated UTF-8 and has no exceptional-code-unit
representation. Neither a gathered-line fix nor query reconstruction can recover the lost
code unit. Preserving it requires an explicit storage encoding/version and native-builder
alignment; rejecting or replacing it would change today's accepted input/observable output.
The native worktree's own Unicode audit independently identifies the same issue, including
its JSON parser's rejection of escaped unpaired surrogates. No native worktree was modified.
This is the plan's first listed STOP condition and the brief's instruction to stop when a public contract
field cannot be served from the index. Both fixed cases remain explicit `.fails` tests;
they must become ordinary passing tests when representation is resolved.

The saved 1× oracle recheck earlier in this continuation remains **583,507/583,507 lines,
zero differences**. It predates the new private query projection; it is not a final equality
claim for this revision. Latest fixture/tiny checks, fuzz results and command counts are
recorded in the measurement ledger below. No retained input or saved oracle was regenerated.

Neither CLI nor headless Workbench hosts have migrated. The extension, production write
invalidation, query telemetry and the product `NODE_OPTIONS` note consequently remain
outstanding. There are no Phase 6 host benchmarks to claim:

| Measurement, both CLI and headless Workbench   | 1× target    | 10× target  | Result             |
| ---------------------------------------------- | ------------ | ----------- | ------------------ |
| First query after cold build / warm index      | Record both  | Record both | Not measured: STOP |
| Count / filter / facet / page / search / focus | ≤100 ms each | ≤1 s each   | Not measured: STOP |
| Peak query V8 heap at default Node heap        | ≤128 MiB     | ≤256 MiB    | Not measured: STOP |
| No-change refresh                              | ≤5 s         | ≤30 s       | Not measured: STOP |
| One package + one PO refresh                   | ≤10 s        | ≤60 s       | Not measured: STOP |

Any future cold-build and refresh numbers must be labeled **TypeScript builder; native
builder pending**. The prior oracle comparison is a correctness measurement under the
permitted 16 GiB oracle cap, never a default-heap host query measurement. No 10× host run,
real-project read, retained regeneration, commit, push, branch switch or stash occurred.
The Data Authoring adoption failure and three stale Game Text e2e expectations are separately
identified pre-existing failures. **Phase 6 is incomplete.**

### Phase 6: WTF-8 decision and host migration

The owner resolved the UTF-16 STOP with `test-results/codex/057-wtf8-spec.md`. Format 4 stores
canonical WTF-8 in every string domain, preserving saved lone surrogates. Six shared byte goldens
and snapshots genuinely written by TypeScript and Rust cover interoperability and rejection of
non-canonical pairs. Both former UTF-16 expected-failure wrappers are ordinary passing assertions.
The manifest/archive parsers match UE 5.7/5.8 rejection of escaped lone surrogates, with file and
offset diagnostics; PO acceptance is unchanged. The engine probe records six rejections and two
paired accepts for each engine. Only saved text receives lone-surrogate fuzz values (3% probability).

`GameTextIndexBuilder` supplies the build session, localization import, package refresh,
dictionary/compaction and joined refresh through an Effect service. Its TypeScript layer keeps the
existing inputs/results/typed failures and remains the oracle/fallback. CLI and Workbench obtain
the builder through that service. One refresh service owns writer leases, publication, pinned
readers, typed recovery and refresh/query telemetry. Hosts use the existing column query API;
list/count/filter/facet/group/page/focus and localization queries retain their public schemas.
PO/review writes invalidate affected file keys and the join marker. `loc gate` retains unselected
inputs and refreshes selected files. Product docs now describe disposable caches and clearing them,
and remove the large-heap setup note. No TypeScript build-speed optimization was undertaken.

The final query projections store normalized paths as WTF-8 bytes and groups/facets as numeric
coordinates, with UTF-16 label ranks preserving the original deterministic ordering. Only display
labels, selected pages/focus and text searches decode strings. Bounded Effect caches keep separate
count baselines for culture selections. Physical chunks support logical columns above 128 MiB;
unchanged aliases share buffers while patched columns keep separate pinned values. Native Project
Index inventory queries provide committed package/sidecar signatures and header gather evidence;
the source verifies selected bundles before and after extraction without a second enumeration.

New fixed cases include empty-source cached facets, saved-only edits without a manifest, restoring
the original content key without overwriting an overlay's base, and generation checks before
opening a retired base. Fixture/tiny comparisons also exposed private-projection ordering and
unpublished-ID bounds; byte order is now stable across append/compaction. The original combined
source findings and each earlier fuzz defect remain individually covered. The event oracle stays
unchanged except the owner-directed Unreal-compatible malformed JSON acceptance fix, which has
its own changeset. The expanded Node 24 differential run now passes **2,000 seeds plus eight
persisted seed assertions**, with zero differing fields, including lone surrogates and the final
numeric problem tally. Node 26 also passes the same 2,000 seeds without differences; the saved
5,000-seed run starting at seed 2,000 completed with zero differing fields
(`phase6-fuzz/run-v26.11.1-2000-5000.json`).

Host discovery also caught recovery guidance drift: the CLI reader-failure boundary now keeps its
established output, and the streaming importer shares the event parser's typed recovery through
`localizationError`. Malformed manifest, archive and PO each have a separate regression assertion;
the importer and real-reader gate rerun passes **51 tests, zero failures**. The gate fixture now
lists the localization files it actually edits and verifies that unlisted files retain their prior
evidence. `not_gatherable` is included in the permitted package diagnostic assertion. The two
unrelated CLI process timeout cases both pass in isolation and in the final one-worker host suite.
The required host roots pass **938 tests / zero failures / seven gated skips on Node 24**, and
**997 / zero / seven on Node 26**, whose run also includes the differential and importer suites.
All **88 Game Text component tests** pass. Pre-commit passes formatting, lint, types, StyleX,
architecture and contracts after fixing the new lint/type findings.

### Phase 6 final verification and recorded 1× results

Recorded 2026-10-11. The broad handoff Node suite passes **1,130 tests / zero failures / seven
gated skips**, 152 passed files, in **377.56 s** on Node 26.5.0 with one worker and an explicit
60-second test budget (`test-setup-optimized-broad.{log,json}`). All three previously timed-out
tests also passed individually with that budget; their broad-suite rerun passes. The default
differential sweep now uses 100 deterministic seeds plus all eight persisted seeds; the file takes
28.59 s, with zero differing fields. All ten minimized/Unicode regression tests pass. The
2,000-seed sweep remains available as `pnpm test:game-text:fuzz`; its seed-count override was
checked separately without repeating a long sweep. Read-only committed native fixture evidence is
shared within one test invocation; each layer/join test still builds its own writable index.
Final fixture checks after simplifying that helper pass **24 / zero failures**, 12.66 s.

The Game Text component rerun passes **88 tests / zero failures**, six files, in **22.88 s**
on Node 26.5.0 (`phase6-final-components-20261011.{log,json}`). Localization-process lanes pass
separately on **UE 5.7.4**, 396.13 s (`localization-rerun-20261011-57-fixed.log`), and
**UE 5.8.3**, 391.46 s (`localization-rerun-20261011-58.log`). Both cover supported operations,
audit, cancellation, review persistence, PO writes through apply/sync, key carryover and the
Unicode JSON probe. The first 5.7 attempt exposed a probe include damaged by markup formatting;
restoring valid C++ and excluding that include from oxfmt fixes compilation on both engines.
Native IO tests were already passing in the incoming handoff. No new parser/codegen engine-matrix
result is claimed. The final pre-push check passes all six stages in 30.58 s, including
**43 architecture tests / zero failures**, formatting, lint, typecheck, StyleX and contracts
(`phase6-final-prepush-20261011.log`). The measurement ledger records each result separately.

The existing host artifacts, not new benchmark runs, provide the final 1× evidence:

| Measurement                                      |                            CLI warm, Node 26.11.1 | Workbench warm, Node 26.11.1 | Target / result                      |
| ------------------------------------------------ | ------------------------------------------------: | ---------------------------: | ------------------------------------ |
| Query stages excluding facets                    |                                     1.31–91.37 ms |                1.41–99.67 ms | ≤100 ms: pass                        |
| Facets                                           |                                         106.09 ms |                    104.85 ms | ≤100 ms: open miss                   |
| Maximum reported query-stage heap                |                                         72.72 MiB |                    82.78 MiB | ≤128 MiB: pass                       |
| Query heap including observed pre-GC trace peaks |                                         77.02 MiB |                    88.86 MiB | ≤128 MiB: pass                       |
| No-change refresh                                |                                            2.59 s |                       4.92 s | ≤5 s: pass                           |
| Opening an existing index                        |                                            4.29 s |                      42.13 s | Workbench startup issue remains open |
| One package + one PO refresh                     | 13.48 s on Node 24; 8.43 s in another Node 26 run |                 Not recorded | ≤10 s: not consistently met          |

Sources are `phase6-cli-1x-{cold,warm}-final.json`,
`phase6-workbench-1x-warm-verified.json`, and the earlier
`phase6-cli-1x-cold-default.json`. The Node 24 cold artifact also records filter/search/facet at
123.05/115.16/203.02 ms; it is not a Node 26 cold-query pass. These measurements cover the
TypeScript builder and host query path with retained package inputs, excluding native catalog
enumeration/extraction. The saved 1× oracle comparison is historical: **583,507/583,507 lines,
zero differences** in `phase6-final-order-1x.json`; it predates the final host/WTF-8 work. No new
saved-scale oracle comparison is claimed. Current fixture, tiny and differential checks cover the
final query implementation.

**The owner stopped all further 10× runs.** The CLI 10× cold attempt failed the 900-second cap
before publication/query (`phase6-cli-10x-cold-default.json`); no cap was relaxed, no prepared
index is relabelled as a successful cold build, and no further benchmarks were run in this handoff.

At the Phase 6 push, the open issues were the TypeScript changed-input refresh's `source-conflict`
fallback to a full join (13.48 s against 10 s), Workbench's 42.13 s open versus CLI's 4.29 s, and
facets around 105–106 ms against 100 ms. The follow-up below addresses the conflict fallback;
its initial fresh-input 1× refresh runs straddle 10 seconds, and subsequent query-buffer reuse
brings all three measured refreshes below the target. Separately, the historical full
`pnpm check` fails at the pre-existing Data Authoring adoption stage (missing
`editor-foreground-responsiveness.js` in the copied protocol package), and three stale Game Text
Workbench e2e expectations fail against the initial scan action and `Quality checks` tab.
Neither is fixed or relabelled as a pass. Targeted verification is complete; full verification,
Phase 6 performance acceptance and Phase 7 remain incomplete. The native-builder workstream stays
separate and was not merged or pushed here.

### Follow-up: incremental source conflicts

Stable package-source edits now create, modify and resolve conflicting-source lines through the
bounded flat overlay. A source-list patch replaces only affected raw/slice rows, with at most
8,192 accumulated rows and 8,192 source IDs in each projection. Both asynchronous and synchronous
readers reconstruct the packed numeric source arena and offsets, including chunked base columns.
Unpatched aliases retain their base buffers. No overlay references another overlay.

Joined metadata v4 identifies the variable-list patches; metadata v3 full layers and fixed-size
overlays remain readable. Cache keys advance to `joined-v11` so older builders rebuild unsupported
overlays. This does not change the physical snapshot's canonical WTF-8 format v4.
Conflict reasons, culture facts/states, source ordering, words, problems, duplicate-source signals
and facets retain full-rebuild semantics. Short-source/visibility, split-unit, structural and
absence-candidate edits continue to fall back to the full merge, as do edits beyond patch bounds.

The targeted regression covers a package-plus-PO edit creating a conflict, further conflicting
edits, conflict resolution and a subsequent PO-only edit. Every step matches the object oracle,
all logical columns of a forced full rebuild, synchronous reads, problem filters and facet counts;
successive edits retain the same full base. Additional checks cover chunked source arenas,
unpatched aliases and malformed/out-of-bound list patches.

Validation on Node 26.5.0: **542 tests pass in 63 files** (142.57 s), covering Game Text,
localization, the Workbench main Game Text services, the join, 100 deterministic fuzz seeds plus
all eight persisted seeds, minimized regressions and column chunks. The package dependency build
and all six pre-commit stages pass, including 43 architecture tests. Artifacts:
`test-results/codex/incremental-source-conflicts-node-20261011.{log,json}` and
`incremental-source-conflicts-precommit-20261011.log`. This is TypeScript join/query work; native
parser and Unreal integration code are unchanged, so the engine lanes were not rerun.

The owner subsequently authorized a fresh 1× measurement on Node 26.5.0. Three sequential
production CLI package-plus-PO refreshes take **10.10 s, 9.65 s and 9.02 s**, median **9.65 s**.
Every run reads one package, parses one fresh PO file and reports `strategy: incremental`,
`affectedLines: 1`, with no fallback. The same-runtime forced full-join control, with the same
fresh PO edit as the first run, takes **42.11 s**. A preliminary pair reuses a cached changed-PO
snapshot (zero files parsed): 37.42 s full versus 9.08 s incremental; it is excluded from the
fresh-input median. This is not a controlled comparison against the historical Node 24
13.48 s result.

After each production refresh, all **165 logical columns** and line/pair/ambiguity counts match
a forced full rebuild of the same changed inputs: **583,507 lines, zero differences** in all
three runs. The correctness proof and input restoration occur outside the refresh timed stage.
Runs use retained synthetic package evidence and copied derived caches, excluding native catalog
enumeration/extraction; default heaps and an explicit 180-second whole-run cap are retained.
The PO byte and package inputs are restored. Artifacts under `test-results/codex/`:
`incremental-conflicts-1x-control-fresh-20261011.{json,log}` and
`incremental-conflicts-1x-fresh-20261011-{1,2,3}.{json,log}`. See the
[measurement method and results](../docs/engineering/game-text-shared-index-measurements.md#incremental-source-conflict-1-refresh-2026-10-11).

Two of three fresh-input runs meet 10 seconds; the first misses by 0.10 s. The conflict fallback
is resolved for this edit, but consistent refresh performance acceptance remains open. Workbench
startup and the historical facet misses were not remeasured. No 10× run, studio project or
native-builder work was performed; the follow-up and harness changes are included in
[PR #62](https://github.com/ue-shed/ue-shed/pull/62).

The updated measurement harness passes all six pre-commit stages, including 43 architecture tests
(`incremental-conflicts-measure-precommit-20261011.log`); the Game Text package build passes.

### Follow-up: reuse immutable query buffers

The owner authorized further optimization. Profiling isolates eager query preparation as a
substantial remaining cost: about 2.87 s of sampled inclusive time in an 8.11 s refresh.
The shared refresh service's two-entry Effect cache now keeps the latest projection for each
dictionary-generation/full-base pair. New incremental generations retain numeric buffers only
for immutable physical layer keys that remain dependencies. Patched and derived columns are
private to each query; obsolete input layers are discarded. Source search reuses encoded WTF-8
bytes and decodes only newly selected IDs, rebuilding when reuse bounds are exceeded. Full-base
changes and compaction reset reuse; older readers remain pinned. Preparation remains eager and
refresh spans record reuse and preparation duration.

The optimized profile takes **6.46 s**, with about **1.15 s** sampled inclusive query preparation.
Three subsequent unprofiled fresh package-plus-PO refreshes take **6.03 s, 6.02 s and 6.06 s**,
median **6.03 s**, range **6.02–6.06 s**. Each reads one package, parses one PO, affects one line
and reports `incremental` without a fallback. All three meet the 10-second refresh target for
this retained-evidence 1× case. The previous unprofiled median was 9.65 s; OS cache effects and
separate-run variation prevent attributing all of the observed 38% median reduction to reuse.
The profile supports about 1.7 s less query preparation. Native discovery/extraction are excluded.

After each refresh, the first page takes **36.52–38.92 ms** and returns 583,507 lines. The added
uncached `phase6-refresh` text search takes **263.96–268.24 ms**, returns the single changed line
and remains above the 100 ms query target. This case was not measured before the optimization.
Workbench startup and the historical facet misses were not remeasured. Overall performance
acceptance remains incomplete even though the measured refresh case now passes.

All three forced-full proofs, timed outside refresh, match **165 logical columns**, plus
line/pair/ambiguity counts: **583,507 lines, zero differences**. Inputs are restored after every
run. The relevant Node suite passes **542 tests in 63 files** (136.14 s); the final focused rerun
passes four tests (25 filtered out), 13.80 s, including source conflict/PO changes, lone-surrogate
sources, chunked aliases, generation invalidation, newly decoded IDs and pinned-reader isolation.
The final package build and all six final pre-commit stages pass, including 43 architecture tests
(`incremental-query-reuse-precommit-20261011.log`). Artifacts under `test-results/codex/`:
`incremental-query-reuse-fresh-20261011-{1,2,3}.{json,log}`,
`incremental-query-reuse-node-20261011.{json,log}` and
`incremental-query-reuse-final-targeted-20261011.log`. See the
[method, profiles and complete results](../docs/engineering/game-text-shared-index-measurements.md#query-buffer-reuse-1-refresh-2026-10-11).

No 10× run, studio project, Rust-builder-tree edit or native/Unreal integration change was made.
The UE lanes were not rerun for this TypeScript query change. This follow-up is included in
[PR #62](https://github.com/ue-shed/ue-shed/pull/62).

### Phase 7 follow-up: desktop browse layout

The owner supplied `test-results/phase7/game-text-layout.html` as the desktop design reference.
Workbench Game Text now uses its compact Key, Source, Translation and State columns with real
query previews. A picked culture supplies translation text and labelled state badges; multiple
cultures retain their state strip. Translation summary counts follow the current query and
picked cultures. They can overlap, so no percentage bar or invented timing is shown. State
buttons use the existing localization query filters; advanced filters and grouping remain.

The list remains beside the selected line in a 400-pixel detail pane. The picked culture's
translation comes first, with editing, review, key carrying, locations and properties retained.
Ctrl/Cmd K focuses search without scrolling the surrounding layout. Only the results and detail
panes scroll; the header remains visible across navigation and refresh. Rescan uses inline progress and permits searching the retained index;
the footer reports the last successful query round trip excluding typing debounce and actual
matching-line, culture and inspected-package counts.

The desktop cold-scan check exposed missing parser-worker bundles: Workbench now emits the
localization and package workers beside its main-process entry, where the shared library
resolves them. This does not change the headless library, index format or Unreal integration.

Verification uses the repository's generic fixture project and isolated Electron profile at
1440×900 and 1280×800. It covers a native cold scan, a real culture's translation in the list
and detail, folder grouping, Ctrl K search, line navigation with the list visible, and Rescan
preserving the search. Component checks cover state filters and searching while a refresh is
held. Validation artifacts are `test-results/phase7/layout-{build,components-final,desktop,precommit}.log`;
screenshots are under `test-results/workbench/game-text-layout.e2e.ts-*/`.

Final checks pass using Node 26.5.0: **90 component tests in six files** (25.92 s), the packaged
Electron workflow, the Workbench build and all six pre-commit stages,
including StyleX checks and 43 architecture tests. These are functional checks on the generic
fixture, not generated-scale UI performance measurements.

Generated-scale desktop timings and the captioned tour remain open. The retained 1× refresh
result above is unchanged; Workbench startup, historical facet latency and uncached text search
still need performance work. No 10× run, studio project or Rust-tree edit was made. UE 5.7 and
5.8 lanes are not rerun for this UI and desktop-packaging change; parser and Unreal code are
unchanged. This browse-layout follow-up is included in
[PR #62](https://github.com/ue-shed/ue-shed/pull/62).

### Follow-up: responsive desktop search

Workbench now selects the shared package's scoped worker search adapter. Search scans run on a
separately pinned reader; the main process keeps its event loop available. Replacement requests
set shared cancellation flags, and scans check them without waiting for worker messages. Different
open groups can load concurrently; replaced pages and old filter selections are retired. Failed
query-cache lookups have zero TTL, preserving completed pages through cancellation. The existing
120 ms typing debounce remains. Worker startup and requests have 30-second bounds with typed
failures. The headless synchronous API and default library layer remain available.

Opening the Text view also defers full localization quality evaluation until the Quality checks
tab is selected. A component regression keeps text search available while that evaluation is
pending. The full quality evaluation itself is unchanged and still needs performance work.

The case-insensitive source fallback now decodes the prepared WTF-8 arena instead of repeatedly
opening compressed shared-string blocks. Unicode and lone UTF-16 values keep their original search
semantics. Text-unit preview schemas preserve their existing optional translation field across
worker transfer. Workbench emits the search worker beside its main bundle; the package emits it in
`dist`, with host adoption instructions and a Changeset.

A local cached-index input probe, with recording and overlays disabled, measured a first four-letter
query at 170 ms per key. First-to-last accepted input fell from 10,995 ms to 539 ms; last-input-to-result
fell from 4,879 ms to 342 ms. A new five-letter query at 60 ms per key fell from 2,807 ms to 268 ms after
the last input. Maximum 50 ms main-process heartbeat gaps fell from 5,546 ms to 66 ms. Match counts
were unchanged. These are single-run observations on a separate cached project, not the generated
1× acceptance lane or a performance guarantee. Local evidence stays under ignored
`test-results/phase7/search-responsiveness/`; no 10× or Rust-tree work was performed.

Validation passes: 55 query/oracle/regression tests in six files; 30 host and worker tests in four
files, with the updated cancellation/group test rerun; 91 component tests in six files; the real
packaged Workbench flow at both viewport sizes (35.6 s); all six pre-commit stages, including 43
architecture tests; and the Effect architecture check. The Game Text tarball contains the worker,
protocol and Node adapter. The full packed-consumer release gate and Unreal runtime lanes were not
rerun for this search-adapter change. Library and Workbench builds pass. This follow-up is included
in [PR #62](https://github.com/ue-shed/ue-shed/pull/62).

### Integration with current main

The merge retains Game Text package-extraction types alongside the saved-world package-error
type added on `main`; the only manual Rust conflict resolution combines those imports. The
generic fixture's gather-candidate audit now asserts all three baseline decoder gaps: two curve
properties in the animation fixture and one opaque value. Candidate extraction excludes these
non-gatherable packages, retains zero gaps and matches the full text corpus.

Rust formatting and Clippy pass. Native IO checks pass 104 tests with one intentional ignored
test. The focused protocol, saved-world, package-record/layer/reader and refresh suite passes
78 tests across six files after rerunning the updated reader expectation. All six pre-commit
stages pass after rebuilding package outputs for the incoming saved-world schema.

### Pullfrog review fixes: current evidence and reader ownership

Failed current manifest, archive and PO reads now make that input unavailable to the new join,
even when its last successful layer remains in storage. Missing and malformed files retain
distinct evidence states. The join cache key advances to `joined-v12` so previously cached joins
rebuild once; the WTF-8 snapshot format remains v4. Historical pinned readers keep their own evidence.

Retained models now prepare in a request scope, publish the replacement, then transfer a host pin
and retire the previous owner. Every operation borrows its published generation for its full scope.
Outstanding queries keep their reader and search worker alive through replacement; rejected or
superseded preparations release only the candidate. Workbench publishes corpus, query and search
through one model reference. Localization target selection follows the same ownership contract.
Raw corpus hydration now retains empty and whitespace-only sources, including empty-source String
Table references, independently of the existing search and export visibility rules.

Eight new regressions reproduce all three review findings against the prior implementation and
pass with the fixes. They use persisted indexes, real localization file reads and the production
search worker. The focused join/query/host suite passes **92 tests across 11 files** (116.90 s).
After the final host refactor, **38 affected tests across six files** pass again (26.26 s). All six
pre-commit stages and the Effect architecture check pass. The Workbench build and packaged desktop
flow pass at both viewport sizes (32.1 s). Artifacts are under `test-results/codex/pr-62-*.log`.

UE 5.7 and 5.8 runtime lanes were not rerun for these TypeScript ownership and corpus changes;
parser, codegen and Unreal integration inputs are unchanged. No scale measurements, 10× runs or
native-builder-tree edits were made. Performance acceptance and the existing open issues above
remain unchanged.

The next review reproduced supersession while asynchronous localization reader retirement was
pending. Workbench now validates the scan revision and project again after that cleanup, under a
single publication permit covering associated state, the model reference and retained ownership.
Cleanup remains outside the permit so a newer refresh can publish while an older cleanup waits.
The new production-reader/worker regression fails on `8ad4fb57` and passes with the correction;
all **34 host tests across four files** pass (17.10 s), along with all six pre-commit stages and
the Effect architecture check. The Workbench rebuild and packaged desktop flow also pass (30.7 s).
The full local packed-package rerun remains unavailable because
this resumed Windows session cannot traverse the Rust/WASM tool links and temporary consumer
dependency links. Hosted portable checks on `8ad4fb57` pass; the fresh CI result for this correction
is tracked on PR #62.

### Phase 8: quality checks over the index

The released project from the Phase 8 context, read-only, Node 24.21, through a desktop host's
Quality checks route with the "all" filter. Before is the in-memory path with a 24 GiB heap so it
could finish; after is the indexed path on Node's default heap.

|                               | In-memory checks | Indexed checks                             |
| ----------------------------- | ---------------: | ------------------------------------------ |
| Time to the first page        |            778 s | 360 s                                      |
| Peak V8 heap (sampled)        |           9.4 GB | 343 MB, including 140 MB before it         |
| V8 heap kept after collection |           9.2 GB | 158 MB                                     |
| Peak process memory           |    11.1 GB (RSS) | 2.4 GB private, 0.8 GB of it index buffers |
| Findings                      |        3,210,355 | 3,210,355; every check's count equal       |

Once built, a culture switch takes 0.17 s, one check's filter 1.3 s, a page at offset 3,000,000
0.13 s, and focus 0.01–0.02 s. Proposals take 10.4 s: they re-check 1,832 scattered rows one page
each. The heap profile at the end holds 23 MB of live samples, against 12.1 GB before.

CPU after: garbage collection 6% (31% before), the Effect runtime inside line hydration 12%, shared
string decoding about 20%; the check rules themselves stay near 1%.

Verification: the oracle test compares every filter, culture, page, export, proposal and focus,
with and without accepted findings, on an index fixture that produces every check, both rule kinds
and source findings. The full `@ue-shed/game-text` suite (379) and the Workbench Game Text host tests
pass, as does `pnpm run check:precommit`. Two worker tests in `index-steps.test.ts` needed a 30 s
timeout: any additional test file reorders the parallel run and pushes their worker start-up past
the 5 s default.

Open:

- Peak heap is 343 MB sampled, 140 MB of it before the query. The owner does not hold quality
  checks to the 128 MiB target; it is not pursued here.
- The scan holds the host's main thread for its 6 minutes; it should move off the main thread.
- Hydration runs through Effect per entry and Schema-decodes every evidence entry the index wrote.
- Proposals should hydrate their rows in adjacent pages.

### Phase 8 follow-up: scan pages, stalls and hydration

Recorded 2026-10-14 on Windows, Node 24.21.0 and the default heap, on the generated 1× project
(583,507 lines, 10 cultures) with the retained Phase 1 inputs and Phase 4 package records. The
scale harness has a quality stage: `--select quality` opens the generated target's index through
the production refresh layer and runs its `localizationQuality` with the review file, as Workbench
does. A 10 ms interval timer runs during the scan; its gaps are the event-loop stalls. Every run
returns 2,027,740 findings. The first run built the index in 81 s; later runs open it in 2.5 s.

A CPU profile of the 2048-line scan put 69% of it in line hydration. Effect.fn's stack capture
and span for every evidence entry and occurrence took 23% of the scan, schema decoding about 17%
(`decodeLocalizationSnapshot` decoded each entry, then hydration decoded it again), and shared
string lookups 26%. The checks, without the units they hydrate, took about 6%.

Hydration now reads a page's columns, evidence entries and strings once, then builds its lines in
a plain synchronous loop. `decodeLocalizationSnapshot` rebuilds entries without decoding each one:
the importer validates Unreal's files against the same schemas when it writes the index, and
section checksums guard the index's bytes. At 2048-line pages:

| Hydration                                   |      Scan | Peak V8 heap |
| ------------------------------------------- | --------: | -----------: |
| Before                                      | 201–208 s |  350–443 MiB |
| Synchronous loop, entries decoded twice     |     144 s |      338 MiB |
| Synchronous loop, decoded once              |     142 s |      301 MiB |
| Synchronous loop, no per-entry decode (now) | 104–107 s |  241–246 MiB |

Page sizes before and after that change, which also added the setup yields below; one run each
unless a range is given:

| Lines per page        | Scan before / after | Stall p95 before / after | Longest stall before / after |
| --------------------- | ------------------: | -----------------------: | ---------------------------: |
| 2048                  |     201–208 / 104 s |              2.5 / 1.1 s |              4.1–5.0 / 2.6 s |
| 1024                  |         217 / 108 s |             1.4 / 0.56 s |                  2.6 / 1.4 s |
| 512                   |         228 / 112 s |            0.71 / 0.30 s |                  1.7 / 1.0 s |
| **256 (now)**         |     236 / 114–118 s |       0.35 / 0.16–0.17 s |            1.3 / 0.48–0.71 s |
| 2048, yield every 256 |         191 / 104 s |             1.7 / 0.56 s |                  3.1 / 2.0 s |

The scan now checks 256 lines per page. It is the only size that keeps the longest stall well
under a second. It costs 10% against 2048-line pages with the new hydration (114 s against 104 s)
and is 43% faster than before. Yielding every 256 lines inside 2048-line pages does not help:
hydrating the page is one synchronous block. The setup before the first page also yields now;
decoding every line ID took 0.7 s and the unit index 0.25 s in one block. With 256-line pages the
median gap is 15 ms. The longest stalls are one-time column loads early in the scan; after them,
pages stay under 0.4 s. Peak V8 heap during the scan is 209–234 MiB. Heap kept after collection is
52 MiB, 46 MiB of it the opened index; the findings columns are array buffers.

Measured, not changed:

- Per-page column reads. Each page still makes hundreds of Effect.fn calls to read its columns:
  about 80 line and culture columns, nine occurrence columns per package shard it touches, and
  each evidence file's runs. Their overhead is 15% of the 256-line profile and most of what small
  pages cost. A per-reader cache of these columns would remove most of it.
- Shared string lookups take 37% of the 256-line profile. `bytesSync` rebuilds the segment start
  list and a block key for every ID.
- Units hydrated for the checks take 19%, and finding hashes (`canonicalJson`) 7%.

Verification: `pnpm exec vitest run packages/game-text` passes 388 tests (4 skipped), including a
new oracle test whose 600-key target spans three pages and fails if a page boundary drops a line.
The Workbench Game Text host tests (28 in three files), the harness tests (18), the localization
import oracle (50) and `pnpm run check:precommit` pass. No 10× run was made and Unreal was not run.

### Phase 8 review fixes

Three findings from the PR review, each with a test that failed before its fix:

- **Selection cancels the shared scan.** Publishing another target now clears the quality cache and
  interrupts its scan. An abandoned scan used to keep checking, and pinning, the previous target
  until another quality request replaced it. A Workbench host test reproduces it.
- **Only the join's lines.** The scan reads the rows the query's `localizationLines` returns for
  the target, in that order; it had checked every joined row. Lines without visible source add
  check diagnostics before the blank-source guard, so with unreadable archives the oracle case's
  `missing_archive` limit read 8 instead of 2. Duplicate sources and a unit's line use the same
  rows, and ties in line-ID order and among duplicate identities keep the join's order.
- **Line IDs equal under collation.** Distinct IDs can compare equal, as keys `é` and `e` with a
  combining accent do; the report then interleaves their findings by culture and check. Each run
  of such lines is one block: the scan checks and stores the block's findings in report order, and
  hydrating a finding re-checks its block. Nearly every block is one line and takes the same path
  as before.

The same 1× project, Node 24.21 and the default heap; two runs. The first run's open stage rebuilt
the cache after the merge with main (33.6 s); the second opened it warm (2.3 s). The scans took
115.4 s and 114.3 s (114–118 s before) and returned the same 2,027,740 findings. Stalls: median
16 ms, p95 0.17 s and 0.16 s, longest 0.47 s and 0.50 s, 546 and 541 over 100 ms (533–548 in the
recorded runs). Peak V8 heap during the scan was 234 MiB and 237 MiB (209–234 MiB before); 57 MiB
and 54 MiB were kept after collection (52 MiB before). About 2.4 MiB of that comes from main: the
heap kept after opening the index is 48.4 MiB, against 46.0 MiB in the recorded run.

Verification: `pnpm exec vitest run packages/game-text` passes 394 tests (4 skipped), the
Workbench Game Text host tests 29 in three files, and `pnpm run check:precommit` passes.

### Follow-up: source-level checks once per line

The released project's 3,210,415 findings were 1,921,650 missing translator notes and 1,249,240
duplicate sources, both facts about the source line repeated for each of 9 translated cultures.
This settles the first open item above (source-level checks reported per culture).

- **Once per line.** `missing_translator_notes` and `duplicate_source` report once per line, under
  the target's native culture, or the line's first culture in the target by code. Both paths run
  the same `checkLocalizationLine`, so the scan's pages, yields and memory are unchanged. Under a
  culture filter they show only for that culture; review acceptances for them use that culture.
- **Defaults unchanged.** Every check still runs by default. Hosts choose with `checks`,
  `disabledChecks` or `disabledLocalizationChecks`; for example, a host whose packages cannot store
  translator notes (UE 4.27, UE5 before 5.8) disables `missing_translator_notes`.
- **Not in this change:** a "Translated inconsistently" check (`inconsistent_translation`) for shared
  source text whose shipped translations differ within a culture. The indexed scan needs each shared
  line's shipped translation per culture before the main pass: a bounded grouping pass over
  hydrated pages and new oracle cases. It is left for a follow-up.

Verification: the main oracle test (`localization-quality-index.test.ts`) asserts that neither check
appears under a non-native culture and that each finding names a distinct line. It and the two
updated unit tests fail on the previous code. The multi-page and collation-tie oracle cases still
match on both paths; the tie case now accepts `duplicate_source` under the native culture.

1× scale harness, `--select quality`, Node 26.11.1, one run each: findings 2,027,740 to 227,047
(missing notes 1,889,060 to 188,906, duplicate sources 111,710 to 11,171; whitespace and empty
translations unchanged). Scan 95.5 s before and 107.1 s after, peak V8 heap 178 and 209 MiB, 48 MiB
kept after collection in both. Repeats were not run to separate the time difference from variance.

### Follow-up: player and editor text in the index

Occurrences now carry an audience (`player`, `editor`, `unknown`), from the reader's gather-table
editor-only bit (uasset-io 1.11) or the policy table in `text-audience.ts`; see
[player and editor text](../docs/products/game-text.md#player-and-editor-text). The index stores it
so filters, facets and groups never read path strings:

- **Package text, `package-text-v4`.** Two u32 occurrence columns: `occurrence.gather` (0 none,
  1 runtime, 2 editor-only), which round-trips the reader's bit, and `occurrence.audience`
  (audience in two bits, reason in four, policy row plus one in eight). v1 to v3 shards are read
  again. The policy table is hashed into every shard key, so a policy change re-encodes shards
  from their stored evidence without reading packages.
- **Join, `joined-v13`.** `line.audience` holds the audience mask of the line's visible places
  (one bit per audience) and, from bit 4, the out-of-scope reason; `query.raw.audience` and
  `query.slice.audience` hold unit and slice masks. Rollup: player, else unknown, else editor.
  Editor text a target without editor-only data would skip turns `not_gathered` into
  `outside_target`, in both joins. Incremental joins fall back when an audience column changes.

The oracle (`indexed-audience.test.ts`) compares occurrences, lines, scope, 16 filter, facet and
group requests, exported lines and localization quality findings between the index and the
in-memory corpus and join.

1× scale harness, Node 26.12.0, default heap, `origin/main` (`de874f16`) against this branch
(`c3ebc294`, plus earlier commits where marked) on the same machine and inputs: a fresh
`--seed 57` project and its converted records. The records carry no gather-table bits, and the
generator's "editor-looking" text is `NodeTitle` on a DataAsset, which no policy row matches, so
every line is player (178,467) or unknown (405,040) text; units 179,234 and 404,564. States and
findings are unchanged (`not_gathered` 60,769, `outside_target` 4,132, 227,047 findings from the
same four checks). The runs measure storing and querying the audience, not reclassification; a
generator that emits policy-matching editor text would change the retained recipe and is left for
later.

| Stage                                       |                               main |                               branch |
| ------------------------------------------- | ---------------------------------: | -----------------------------------: |
| Package layer cold build (`--mode package`) |                 16.7, 17.8, 24.3 s |         18.6, 20.0 s (17.0–23.2 s ¹) |
| of which string sort                        |                    5.1, 5.3, 8.8 s |             5.4, 5.7 s (4.9–8.8 s ¹) |
| of which layer encode / verify (summed)     |              12.0–13.2 / 4.3–4.8 s |                13.2–15.2 / 4.6–5.7 s |
| Package layer bytes                         |                4,922,180–4,922,236 |          5,055,176–5,055,512 (+2.7%) |
| Peak RSS, package layer cold build          |                    1,576–1,638 MiB |      1,688–1,803 MiB (1,743–1,838 ¹) |
| No-change / one-package refresh             |            0.38–0.59 / 1.24–1.82 s |              0.42–0.58 / 1.41–1.48 s |
| Quality open, cold (package layer, join)    |                      89.1, 109.2 s |             97.6 s (103.6–117.6 s ¹) |
| Peak RSS, cold open                         |                    2,212–2,230 MiB |            2,239 MiB (2,185–2,322 ¹) |
| Quality open, warm                          |                         2.4, 2.4 s |                         2.4, 2.6 s ¹ |
| Heap kept after opening, cold / warm        |               45.7–45.9 / 43.1 MiB |               46.3–46.5 / 43.6 MiB ¹ |
| Quality scan                                |       105.3, 132.1, 133.5, 136.8 s |             133.4 s (98.8–140.7 s ¹) |
| Scan peak V8 heap / kept                    |                184–211 / 49–51 MiB |                175–183 / 50–52 MiB ¹ |
| Scan stalls p95 / longest / over 100 ms     | 185–202 ms / 0.49–0.72 s / 517–546 | 146–209 ms / 0.59–0.68 s / 516–579 ¹ |

¹ Runs on earlier commits of this branch, with the same columns and join and a slower classifier.

Time differences are within the spread one commit shows: the package layer's cold build ranges
over 7 s on both, almost all of it string sort and append, which this change does not touch. The
index keeps about 0.5 MiB more heap open. Peak RSS of the package layer's cold build is about
100 to 200 MiB higher: its eight workers now classify every occurrence. Removing the two new
columns while still classifying left it at 1,869 MiB, so the columns are not the cause. The
classifier takes 1.8 s per million occurrences on one thread (3.9 s before lowercasing and splitting
each subject once), and returns at once when the reader sent the gather-table bit, as real records
usually do; memoizing path parts did not help on 1× paths, which are nearly all distinct. Peak RSS
of the whole cold open is unchanged within its spread.

Search over the opened index (a gitignored probe calling `query.search` for a 50-line page,
first call then repeat):

| Request                        | Units, first / repeat | Target lines, first / repeat |
| ------------------------------ | --------------------: | ---------------------------: |
| Page with origin facet, main   |          196 / 5.7 ms |                 60 / 22.9 ms |
| Page with origin facet, branch |          237 / 7.8 ms |                 64 / 27.4 ms |
| Page with audience facet       |          170 / 8.8 ms |                 63 / 25.6 ms |
| Audience is not editor         |          255 / 5.5 ms |                337 / 26.5 ms |
| Grouped by audience            |          183 / 5.5 ms |                 63 / 29.5 ms |

First calls load columns and the source cache; repeats are in the range of the existing facets.
No 10× run was made; Unreal was not run.

### Follow-up: compiled Blueprint copies

A Blueprint's compile saves its authored subobjects again in the same package: a widget's
`WBP_X.WBP_X.WidgetTree.Title` also as `WBP_X.WBP_X_C.WidgetTree.Title`, UMG animations as
`WBP_X_C.FadeIn_INST`, and sometimes default objects and a skeleton class. Each widget text was two
places, and a Blueprint edited but not compiled read as "Same key, different text". See
[compiled Blueprint copies](../docs/products/game-text.md#compiled-blueprint-copies).

- **Reader, uasset-io 1.12.** Package text records carry `blueprintClasses`: each decoded object
  whose saved `GeneratedClass` names an export of the package, that export's single
  `RF_ClassDefaultObject` export, and a saved skeleton class (the top-level export of the generated
  class's own class named `SKEL_` plus its name; `SkeletonGeneratedClass` is transient) and its
  default object. Stripped below minor 12; package text extraction requests 12.
- **Fold.** `foldRepresentationCopies` (pure, idempotent, per record) folds a copy into the
  occurrence at its authored site with the same location kind, property path and key. Same-key
  properties of one object stay two places; a copy under another key stays a place; sites saved
  only under the class stay places at their own path. The place keeps the authored text as the
  line's source and lists its copies (`objectPath`, `kind`, `source`). A differing copy the game
  runs (generated class, its animation instances, class default) sets the
  `compiled_copy_differs` review signal instead of a conflicting source; a skeleton-only
  difference is listed but raises nothing. The in-memory corpus folds
  each record as it is read; the index folds in `packageTextColumns`, so cold, warm and worker
  paths agree.
- **Package text, `package-text-v5`.** Occurrence rows are places. `occurrence.copies` holds bit 0
  (has copies), bit 1 (a copy differs) and the copy count from bit 2; copies are sparse rows in
  place order (`copy.object`, `copy.kind`, `copy.source`, the source empty when it is the
  place's). `package.blueprints` keeps the reader's classes as JSON. A place's audience is the
  rollup over the place and its copies, each classified from its own gather bit and class, which
  `copy.kind` and `copy.class` keep.
- **Join, `joined-v14`.** Query signal bit 6 is `compiled_copy_differs`. Copy text or flag changes
  rebuild the join in full; place text edits stay incremental and keep the bit. Indexed
  occurrences decode their copies on first access.

Real reader output, read only (no Unreal run): UE 5.7 and UE 5.8 engine `PerformanceCaptureWorkflow`
plugin content and UE 4.27 `VirtualCamera` content give 296 of 5,869, 402 of 8,358 and 7 of 262
occurrences as copies (generated-class widget trees, one or five `_INST` animation tracks); every
copy had its place's text. Construction-script nodes (33 and 35) and class-default text (38 and 43) had no authored site and stay places, including two default-object properties under one key.

The oracle (`indexed-copies.test.ts`) compares places, units, focus, lines and 54 search requests
between the index and the in-memory corpus and join, then an incremental place edit and a full
recompile. `package-text-copies.test.ts` round-trips copies and classes through cold worker and warm
refreshes; `fixture.integration.test.ts` reads the saved fixture's review Blueprint through the
native reader.

1× scale harness, Node 26.12.0, default heap, `origin/main` (`a0508222`) against this branch on
the same machine and freshly generated `--seed 57` inputs (one run each unless listed). The
generated records have no Blueprint evidence, so they measure the new columns, not folding. The
"copies" variant adds `blueprintClasses` to the 16,500 text packages and a generated-class copy
before each of their 831,604 asset-property occurrences, 16,632 with older text (1,859,809 raw
occurrences that fold back to the same 1,028,205 places).

| Stage                                   |                    main |                  branch |           branch, copies |
| --------------------------------------- | ----------------------: | ----------------------: | -----------------------: |
| Package layer cold build                |            20.6, 22.1 s |            19.1, 19.5 s |             25.1, 25.2 s |
| of which string sort                    |              6.8, 8.5 s |              5.6, 5.7 s |               7.3, 7.3 s |
| of which layer encode / verify (summed) |     12.6–13.0 / 4.8–4.9 |     13.9–14.4 / 5.5–5.9 |      16.3–16.6 / 6.9–7.0 |
| Package layer bytes                     |     5,055,324–5,055,496 |     5,193,552–5,193,776 |      6,227,348–6,227,856 |
| Peak OS RSS, package cold build         |         1,677–1,777 MiB |         1,822–1,851 MiB |          1,787–1,894 MiB |
| No-change / one-package refresh         | 0.36–0.50 / 1.31–1.49 s | 0.43–0.47 / 1.37–1.47 s |  0.43–0.46 / 1.59–1.64 s |
| Quality open, cold / warm               |            89.7 / 2.5 s |            90.0 / 2.3 s | 93.6, 116.8 / 2.3, 2.5 s |
| Peak RSS, cold open                     |               2,252 MiB |               2,217 MiB |          2,176–2,220 MiB |
| Heap kept after opening, cold / warm    |         46.5 / 43.7 MiB |         47.1 / 44.1 MiB |     46.6–46.9 / 44.2 MiB |
| Quality scan, cold / warm               |         111.2 / 101.4 s |          112.7 / 91.0 s |        139.0 / 112.4 s ¹ |
| Scan peak V8 heap / kept                |     210–214 / 50–52 MiB |     179–185 / 50–53 MiB |      179–182 / 50–53 MiB |
| Scan stalls p95 / over 100 ms           |    153–164 ms / 518–524 |    140–168 ms / 515–521 |     180–206 ms / 567–587 |

¹ With copies decoded eagerly the scan took 147.3 s cold and 143.8 s warm; never decoding them, a
probe took 104.1 s warm. Quality checks never read copies, whose scattered paths miss the string
block cache, so indexed occurrences now decode them on first access.

Findings are 227,047 in every run. The package layer grows 2.7% at 1×: five new sections per
shard, one of them per occurrence. A first layout with a section per Blueprint field and a
per-occurrence copy offset grew it 5.9%, and to 9.0 MB on the copies variant. Package and quality
times are within the spread one commit shows (the plan's earlier records range over 7 s and 40 s);
the copies variant's cold build reads 81% more raw occurrences. No 10× run was made; Unreal was not
run, and the UE 5.7/5.8 engine matrix was not run (no parser change).

### Follow-up: source quality rules over the index

Hosts evaluated source rules with `evaluateGameTextSourceQuality(result.corpus, rules)` and paged
them with `textQualityQuery`. Reading `corpus.units` hydrates every unit of the index (each
occurrence's eight strings, its package file and its audience), and the evaluation then runs in one
synchronous block. A desktop host on a 238k-line project reported about 55 s blocked and 1.3 GB
added each time rules load or the project refreshes.

- **Indexed scan.** An opened index model's `sourceQuality(ruleDocument, { onProgress? })` (and
  `indexedSourceQuality(joined, corpus, ruleDocument, options?)`) returns the `TextQualityQuery`
  the in-memory pair gives. It reads units in `query.raw.order`, which is the report's unit order,
  in pages of 256 units or 1,024 occurrences, yielding after each. Roles match locations built
  from the occurrence columns with the same `matchesTextRole`; sources are read only for
  occurrences a rule's role selects, and package files only for a finding's occurrences. Budget
  and terminology findings come from `textQualityUnitFindings`, which the in-memory evaluation now
  also uses, so both paths share every rule's logic.
- **Compact findings.** Each finding keeps its rule, unit rank, place among that unit's findings and
  its ID's 64-bit hash: 18 bytes. A stable counting sort by rule gives the report's order. Search
  pages, focus and export rebuild the findings they return from their units and check each
  against its hash. `textQualityQueryOf(report, list)` is the query over any finding list;
  `textQualityQuery` is it over an array. Finding IDs hash with two u32 halves instead of BigInt,
  with the same IDs.
- **Progress.** `SourceQualityProgress` is `{ checkedTextUnits, totalTextUnits, findings }`: once
  before the scan, after each page, the last call with every unit checked.
- **Copies.** Roles match a place by its own location in both paths; a folded Blueprint place's
  copies never match by their compiled paths. A role selects the authored site, whose text is the
  line's. A site saved only under a generated class stays a place at that path and matches there.
- **Hosts.** Workbench's rules report and its localization workspace's source findings use the
  index when the model has one; adapters without an index keep the in-memory functions.

The oracle (`source-quality-index.test.ts`) compares the summary, every export, every search page
by cursor at three page sizes, and every focus and occurrence page between the indexed query and
the in-memory query over the index's corpus, and that report with the one over the reader's own
corpus. It covers five rule documents, including the checked-in v1 and v2 examples, every matcher
kind exact and prefix, both rule kinds, shared and conflicting keys, blank and invariant text, a
partial package's diagnostics, a 703-unit target over several pages and a Blueprint with copies.
`source-quality-fixture.integration.test.ts` runs the same comparison on the saved fixture
project's index with the native reader, for the example documents and a document of roles read
from the fixture's own evidence.

1× scale harness, `--select source-quality` (and `source-quality-memory` for the previous path),
Node 26.12.0, default heap, a freshly generated `--seed 57` project and its converted records.
`scaleSourceRules` has five roles and five rules (two budgets, three terminology rules); every
generated source holds each word the terminology rules look for, so their roles' lines all report.
Both paths return 779,602 findings (627,073 budget, 152,529 terminology).

| Source rules, 1×                      | In memory (before) |                 Indexed, warm |
| ------------------------------------- | -----------------: | ----------------------------: |
| Evaluation                            |             74.9 s |                28.7, 29.2 s ¹ |
| Peak V8 heap during it                |          1,718 MiB |                  102, 102 MiB |
| V8 heap kept after collection         |          1,587 MiB | 46, 46 MiB (44 after opening) |
| Peak RSS (after opening: 826–862 MiB) |          2,817 MiB |                  955, 943 MiB |
| Event-loop stalls p50 / p95           |      one of 74.4 s |                 16 / 33–34 ms |
| Longest stall / over 100 ms           |         74.4 s / 1 |            260–268 ms / 1–2 ² |
| First 50-finding page / its focus     |  23.0 ms / 0.20 ms |   22.8–26.0 ms / 0.36–0.38 ms |

¹ The first run on an empty cache built the index in 104.9 s, then scanned in 33.1 s (longest
stall 0.37 s), before two changes: each shard's occurrence columns are looked up once per scan
instead of per field read, and the scan yields before and after reading the diagnostics.
² The longest stall is the last step: `metadataReport`, the corpus's bounded diagnostics, about
0.25 s over 166,518 packages. The other over 100 ms is the first column loads at 0.1 s.

The indexed scan's RSS above the opened index (about 120 MiB of array buffers) is the occurrence
and unit columns it reads, which the returned query keeps to rebuild findings, and the findings'
columns (13 MiB at 779,602 findings). The in-memory path keeps the hydrated corpus because the
index's `corpus.units` caches it. No 10× run was made; Unreal was not run.

### Follow-up: check severity, shape and source checks (P1.5–P1.7)

A review of shipped projects asked for three things: rank findings by how much they matter, check a
translation's shape against its source, and check source text without a rule file. This change
also adds "Translated inconsistently", left open above.

- **Severity.** Every built-in check has a severity in `checkSeverity`, and every localization
  finding carries it (`severity`, outside the finding's ID). Blocking: `culture_invariant_text`
  (players see it untranslated in every culture) and `outdated_translation` (an archive
  translation recorded for older source; Unreal's resource compile drops it and ships the source).
  Low: `duplicate_source`, `missing_translator_notes`, `number_only_text` and `rich_text_tag_case`
  (Slate matches style and decorator names without case). Everything else, budgets and terminology
  included, is normal (see the follow-up below for the ratings after a shipped project's review).
  Severity is a function of the check, so the index stores nothing new: the
  workspace derives it from each finding's packed filter. Pages and exports list blocking findings
  first, then normal, then low, each in report order, on both paths; pages count findings by
  severity in `severityCounts`, and summaries, focus and CSV rows carry it.
- **`duplicate_source`** now reports once per shared text, on the line whose identity sorts first,
  and leaves out text without letters.
- **Conflicting sources.** A key with several saved texts (`conflicting_source`) is joined into one
  space-separated string for the line's `source` by the in-memory join
  (`localization.ts`, `joinLocalizationTarget`), the index build (`joined-target.ts`) and its
  incremental refresh (`joined-target-incremental.ts`); search and browse rows use that string.
  The checks no longer do: findings on such a line carry the distinct texts in `sourceVariants`,
  workspace summaries and focus show them as a list (`source` is the gathered source or the first
  text), the line is left out of shared-source grouping, and without a manifest source its
  translation is not compared. The joined `source` stays for search; changing it is an index
  format change, left for the work that owns the format.
- **Shape checks.** `format_argument_renamed` pairs dropped and added names in order of appearance
  and owns the one-rename fix; `format_arguments` keeps the rest. `rich_text_tags` compares tag
  names without case, `rich_text_tag_case` their case. `line_breaks` is split from `whitespace`,
  which compares edges only. `segment_separator` counts the rule file's new optional
  `segmentSeparator`. `length_outlier` flags translations under a third or over three times the
  source's visible length (tags, modifiers and arguments removed, wide East Asian characters
  counted twice), for sources of at least 20 visible characters. Empty archive entries of keys a
  partly read package did not yield were already reported (the line falls back to the manifest
  source); a test now covers it. A line whose saved text is blank but whose manifest has the source
  is now checked too, where the join keeps it: the in-memory join does, the index hides such lines
  from the query and so from the scan, unchanged here.
- **Source checks**, with no rule file: `culture_invariant_text`, `placeholder_text`,
  `source_whitespace`, `source_markup`, `number_only_text` and `string_table_key_collision`. They
  run inside the line scan, once per line under the source culture, so the indexed scan keeps its
  pages and memory; the rule file's v1 source report (`evaluateGameTextSourceQuality`) is unchanged
  and adds budgets and terminology on top. Lines without a key used to be skipped before their
  units were built; the indexed scan now asks the occurrence identity column whether such a line
  is culture invariant, so only those lines build units.
- **`inconsistent_translation`.** Lines are grouped by source as for `duplicate_source`, but only
  sources with letters and at least three visible characters. Per culture, every line whose shipped
  translation is not the single most used one gets a finding; when several tie, every line does.
  One finding per line and culture is what the list can act on: it opens that line, and accepting
  it is a per-line review record. The finding lists the five most used translations with their
  line counts. The indexed scan adds a second pass before the main one: the duplicate pass already
  returns the rows of shared lines, and the translation pass reads only their state, facts and
  shipped-translation columns, 4,096 rows per yield. Hydrating those scattered rows as lines took a
  page per row: on the 1× project the first version's scan took 196 s with 3–4 s stalls. Memory
  follows the distinct translations of shared lines.
- **Finding IDs.** Hashes are unchanged; a finding of a check whose evidence did not change keeps
  its ID. `localization-finding-ids.test.ts` pins IDs recorded from main for format arguments,
  rich text, whitespace, escapes, empty translations, modifiers and notes.

1× scale harness, `--select quality`, Node 26.12.0, default heap, on the generated 1× project
(583,507 lines, 10 cultures; 386,000 keyless lines). The machine was shared with other work, so
main and this branch were built and run alternately, twice each, after the index cache was warm:

| Run    |    Scan | Peak V8 heap | Kept after GC | Stall p50 / p95 / max | Findings |
| ------ | ------: | -----------: | ------------: | --------------------: | -------: |
| main   | 125.7 s |      177 MiB |        49 MiB |     18 / 185 / 579 ms |  227,047 |
| branch | 136.8 s |      172 MiB |        50 MiB |     13 / 199 / 616 ms |  225,093 |
| main   | 126.1 s |      185 MiB |        49 MiB |     18 / 192 / 623 ms |  227,047 |
| branch | 128.7 s |      183 MiB |        50 MiB |     13 / 199 / 681 ms |  225,093 |

The scan is 2–9% slower and memory is unchanged. Findings per check, main → branch:
`missing_translator_notes` 188,906 → 188,906; `empty_translation` 13,680 → 13,680; `whitespace`
13,290 → 13,290 (no line-break-only differences at 1×); `duplicate_source` 11,171 → 5,532 (one per
shared text); `source_whitespace` 1,915; `inconsistent_translation` 1,620; `length_outlier` 150.
The generator makes none of the other new checks' cases (no placeholders, tags, culture-invariant
text, String Table collisions, outdated archives or number-only text), so they report 0 here; the
oracle fixtures produce each of them on both paths. Every check stays on by default:
`source_whitespace` and `inconsistent_translation` are under 1% of lines at 1×, and the noisy pair
(`missing_translator_notes`, `duplicate_source`) is rated low rather than disabled. Real projects
are needed to judge `length_outlier`, `culture_invariant_text` and `source_markup` noise.

Earlier runs of this branch, each against the same warm cache but not interleaved: with the
translation pass hydrating lines, 196.4 s and stalls up to 3.9 s; with the column pass, 158.8 s and
127.5 s; with the text helpers' fast paths but keyless lines still building units, 150.2 s and
132.8 s. A CPU profile of that last version put 30% of the scan in building units for checks, the
new text checks each under 1 s, and the translation pass under 0.1 s.

Verification: `pnpm exec vitest run packages/game-text` passes 421 tests (6 skipped); the
Workbench Game Text host tests (44 in five files), the Game Text extension tests (146) and the CLI
tests pass, as do `pnpm run typecheck`, `lint`, `format:check` and `effect:architecture`. Unreal
was not run.

### Follow-up: check noise on a shipped project

The checks above were measured on a shipped UE 4.27 project (237,931 lines, `en` plus 9 cultures),
with a host's defaults (`missing_translator_notes` and `duplicate_source` off, no rule file).
Two blocking checks were almost all noise: `culture_invariant_text` (42,210 findings, none of a
20-line sample actionable) and `outdated_translation` (2,437, of which 1,513 differed from the
current source only in `\r\n` against `\n`). Several others were noisy. Changes:

- **Empty translations.** The shape checks (`format_arguments`, `format_argument_renamed`,
  `argument_modifiers`, `rich_text_tags`, `line_breaks`, `segment_separator`, `length_outlier`,
  `outdated_translation`) skip a translation that is empty or whitespace; `empty_translation`
  reports it.
- **`outdated_translation`** compares sources with line endings normalized. A change of line
  endings only is `source_line_endings_changed`, low.
- **`culture_invariant_text`** is low. It reports a saved place only when it is not editor text
  (the occurrence's audience, which for a folded Blueprint place already rolls up its copies'
  evidence), not in a package whose path contains "debug", not a `TextRenderComponent` (world-space
  labels: waypoint distances, spawner names), and in a property that holds at least as much keyed
  or String Table text in the project as invariant text in such places. A property is a class's
  property path or a DataTable's column, container indexes removed. The indexed scan counts both
  in two passes over the occurrence identity, location, owner and audience columns before the main
  pass, decoding each owner and property string once. The main pass answers keyless lines from the
  same columns, so units are built only for reported lines.
- **`inconsistent_translation`** skips the native culture, sources over four words and ties, and
  groups translations without case, whitespace, punctuation and symbols. When most lines ship the
  source untranslated, it reports those lines (`untranslated: true`), unless under half as many
  lines translate it: a culture leaves internal labels (one repeated on 452 lines)
  untranslated on purpose, and reporting them was 8k of the 16k findings left after the other
  changes.
- **`rich_text_tags`** reports dropped tags (normal); a translation that only adds tags is
  `rich_text_tags_added` (low). Rule files can list `optionalTags`, compared without case, and
  `optionalArguments`: arguments the game always supplies, which a translation may add, with a tag
  around only them (`<PlayerName>{ParentLabel}</>`). An optional argument never pairs as a rename.
- **`line_breaks`** counts breaks between the first and last visible characters.
- **`source_whitespace`** is low and skips Blueprint bytecode fragments (manifest paths ending
  `[Script Bytecode]`) and lines without a manifest entry. `source_markup` and `number_only_text`
  skip bytecode fragments too. `source_markup` reads tags as Slate does: attributes are
  `name="value"` pairs (`<invalid requirement type>` is text), `<{arg}>` opens a tag, a tag right
  after an ASCII identifier character is code (`GetSubsystem<UMySubsystem>()`), and `</Name>`
  closings are listed in `xmlClosings` with their own message.
- **`length_outlier`** allows a quarter for zh, ja, ko and th. `placeholder_translation` reports a
  translation that is only a placeholder word ("skip", "TBD", "script lama", upper-case "TODO") or,
  for a source of three words or more, only punctuation, outside the native culture and unless the
  source is itself a placeholder or the translation equals it; `length_outlier` leaves such lines
  to it.
- **Rule files and built-ins.** The starter rules forbid "placeholder" under `/Game/`, so a list
  showing source quality (now over the index, #88) and the built-ins reported such text twice.
  The quality workspace, which combines the two, leaves out a `placeholder_text` finding whose
  every placeholder a source terminology finding marks in the same text of one of its places, and
  names only the rest in a partly covered one's summary. The localization report keeps them all: it
  holds no source findings, and `loc check` prints only it. A first version dropped the matches in
  the check itself, which left `loc check --check placeholder_text` empty with the starter rules.
  A second rechecked every `placeholder_text` finding when the workspace was built, in one array
  outside the scan's pages. Now the check records the placeholders the rule document's terminology
  leaves (`unreportedMatches`, not part of the ID), reading the line's units only when a term
  overlaps a placeholder, and the indexed scan stores "reported in full" as a fact (one byte a
  finding, only when some is); the workspace reads that fact and hydrates nothing.
- **Stall.** The worst stall (3.7–4.5 s) was not after the last progress call: it was one page
  that held keys saved in thousands of places (`FEventTrackEditor`/`TrackName` "Events" took
  2.3 s, `SCS`/`Default` 2.1 s), whose units every keyed line built for its notes and saved
  places. Lines now build units only for a finding; translator notes and String Table entries are
  read from the occurrence columns (each kept occurrence filtered by its gathered identity, as
  `localizationLineUnits` filters, with namespace, key and notes strings memoized), and policy rules
  build units only for a line with a translation to check. On the project, the counts with these
  column reads and with units were identical per check and culture. Pages also halve, to 64 lines,
  while one takes over 500 ms and grow back below 125 ms: 256-line pages of some stretches took
  1–1.8 s to hydrate. A 200 ms budget with 16-line pages kept every stall under 1 s but made the
  scan 60% longer, as small pages decompress the same string blocks again.

Findings with those defaults, before (`f7d924df`) and after (on main with #82, #87 and
#88). The rule-file run adds `segmentSeparator: "//"`, `optionalArguments: ["ParentLabel"]` and
`optionalTags: ["NPCName", "PlayerName", "Italic"]`:

| Check                         |  Before |  After | Before, rule file | After, rule file |
| ----------------------------- | ------: | -----: | ----------------: | ---------------: |
| `culture_invariant_text`      |  42,210 |    324 |            42,210 |              324 |
| `inconsistent_translation`    |  32,643 |  8,444 |            32,643 |            8,444 |
| `rich_text_tags`              |  20,269 | 11,772 |            20,269 |              248 |
| `rich_text_tags_added`        |       — |  7,587 |                 — |            1,195 |
| `whitespace`                  |  19,803 | 19,803 |            19,803 |           19,803 |
| `empty_translation`           |   7,482 |  7,482 |             7,482 |            7,482 |
| `rich_text`                   |   4,897 |  4,897 |             4,897 |            4,897 |
| `format_arguments`            |   4,285 |  3,289 |             4,285 |            2,476 |
| `rich_text_tag_case`          |   3,364 |  3,364 |             3,364 |            3,364 |
| `length_outlier`              |   2,590 |  1,604 |             2,590 |            1,604 |
| `outdated_translation`        |   2,437 |     13 |             2,437 |               13 |
| `source_line_endings_changed` |       — |  1,513 |                 — |            1,513 |
| `format_argument_renamed`     |   1,859 |  1,859 |             1,859 |            1,854 |
| `line_breaks`                 |   1,548 |    956 |             1,548 |              956 |
| `number_only_text`            |   1,399 |  1,351 |             1,399 |            1,351 |
| `source_whitespace`           |   1,202 |    991 |             1,202 |              991 |
| `placeholder_translation`     |       — |    527 |                 — |              527 |
| `argument_modifiers`          |     329 |    305 |               329 |              305 |
| `placeholder_text`            |     131 |    127 |               131 |              127 |
| `source_markup`               |      43 |     25 |                43 |               25 |
| `segment_separator`           |       — |      — |            13,532 |           11,635 |
| Total                         | 146,491 | 76,233 |           160,023 |           69,134 |
| Blocking                      |  44,647 |     13 |            44,647 |               13 |
| Normal                        |  97,081 | 61,090 |           110,613 |           60,383 |
| Low                           |   4,763 | 15,130 |             4,763 |            8,738 |

With every check on, 356,983 findings became 228,377 (blocking 13). `missing_translator_notes`
fell from 192,165 to 134,768 and `duplicate_source` from 18,327 to 17,376 with #82, which leaves
editor text a target does not gather out of the target. The 13 blocking findings are the
translations made for older text, the 13 the project's review expected. Scan with those defaults:
before 302–316 s, after 319–339 s over three runs (one earlier run of this branch took 262 s);
the machine was shared, so these are not separable. Longest stall 3.7 s before, 0.92–0.94 s after, with 8–14
stalls over 400 ms (445 before the scan changes above); peak V8 heap 268 MiB before,
270–340 MiB after.

1× scale harness, `--select quality`, Node 26.12.0, default heap, on a fresh copy of the generated
1× project (583,507 lines, 10 cultures) and its records, the index cache warmed once. `main` is
`52db2495` (with #82, #87 and #88); main and this branch were built and run alternately, then the
branch twice more after its string memos were released at the end of the scan:

| Run           |   Scan | Peak V8 heap | Kept after GC | Stall p50 / p95 / max | Findings |
| ------------- | -----: | -----------: | ------------: | --------------------: | -------: |
| main          | 88.1 s |      201 MiB |        50 MiB |     15 / 132 / 482 ms |  227,047 |
| branch        | 96.3 s |      212 MiB |        59 MiB |     14 / 143 / 473 ms |  222,872 |
| main          | 87.3 s |      217 MiB |        50 MiB |     15 / 130 / 488 ms |  227,047 |
| branch        | 95.1 s |      188 MiB |        59 MiB |     14 / 139 / 483 ms |  222,872 |
| branch, memos | 94.5 s |      196 MiB |        51 MiB |     15 / 139 / 509 ms |  222,872 |
| branch, memos | 95.6 s |      188 MiB |        51 MiB |     14 / 142 / 476 ms |  222,872 |

The scan is about 8% slower than main, stalls are unchanged, and the heap kept after the scan is
within 1 MiB once the memos are dropped. Findings per check, main → branch:
`missing_translator_notes` 188,906 → 188,906; `empty_translation` 13,680 → 13,680; `whitespace`
13,290 → 13,290; `duplicate_source` 11,171 → 5,532; `source_whitespace` 1,314; `length_outlier` 150. `inconsistent_translation` now reports nothing here: the generator's shared sources that
translate differently are sentences or ties.

Verification: `pnpm exec vitest run packages/game-text` passes 501 tests (8 skipped); the
Workbench Game Text host tests (46 in five files), the Game Text extension tests (150 node, 126
component) and the CLI tests (68, 9 skipped) pass, as do `pnpm run typecheck`, `lint`,
`format:check` and `effect:architecture`. Unreal was not run.
