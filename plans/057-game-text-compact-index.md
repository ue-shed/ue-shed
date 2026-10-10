# Plan 057: A compact, persistent Game Text index

> **Executor instructions**: Follow this plan in order. Before editing, read `AGENTS.md`,
> `docs/README.md`, `docs/products/game-text.md`, ADR 0007, `docs/engineering/binary-project-index.md`,
> Plan 033, and Plans 037 and 056 (archived), and `docs/engineering/testing.md`. Run targeted checks while
> iterating and `pnpm check` before handoff. Honour the STOP conditions.
>
> **Drift check (run before each phase)**:
> `git diff origin/main...HEAD -- packages/game-text packages/localization packages/unreal-assets crates/uasset-io apps/cli apps/workbench extensions/game-text`.

## Status

- **State**: IN PROGRESS. Phases 1–3 are implemented, including lazy sections, streaming publication,
  localization file imports and revised 1×/10× evidence. Throughput/whole-index size targets and Phases 4–7 remain. Phase 3 live UE 5.7/5.8 checks
  are unavailable under repository-only access; their committed fixture oracles pass.
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
   the Project Index already computes. Only packages whose headers name `TextProperty` (an existing
   Project Index query) are extracted; the rest are known to hold no text.
2. **Localization files.** Per manifest, archive and PO file: its entries as columns of string IDs,
   sorted by identity. Keyed by the file's content hash. Unreal's files are imported with streaming
   parsers, never decoded whole.
3. **The joined target.** Lines, per-culture states, unknown-reason bits, problem bits, facet IDs and
   key changes, built by a merge join over the sorted inputs. Rebuilt when any input's key or the
   review file's hash changes; the first version may rebuild the whole join, if Phase 5 shows that is
   fast enough.

**One snapshot format for all three.**

- Deduplicated UTF-8 tables by domain (source/identity, each culture, paths and comments), split
  into independently loaded blocks with local offsets. A page reads only the blocks it touches.
- Columns as little-endian typed arrays, 4-byte aligned, so a reader views them without copying.
- Sparse columns where a dense one wastes space. For example, a PO translation is stored only where it
  differs from the archive's, and unknown reasons are stored per line when every culture shares them.
- Sections checksummed and independently compressed with zstd, or raw when compression does not
  pay. Readers open only the header/directory and load sections by positioned read on first use.
- Writers stream sections into a temporary file, retaining at most one payload and its compressed
  copy. Neither readers nor writers need a contiguous whole-file buffer.
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
- Keyed by package signature; only `TextProperty` candidates are read; a refresh re-reads only
  changed packages.
- Measure full and no-change refreshes at 1× and on the real project.

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

## Acceptance targets

Recorded on the generated projects; confirmed read-only on the real one.

|                                             | 1×        | 10×       |
| ------------------------------------------- | --------- | --------- |
| Peak V8 heap during any query               | ≤ 128 MiB | ≤ 256 MiB |
| Refresh with nothing changed                | ≤ 5 s     | ≤ 30 s    |
| Refresh after one package and one PO change | ≤ 10 s    | ≤ 60 s    |
| Count, filter, facet or page query          | ≤ 100 ms  | ≤ 1 s     |
| Snapshot on disk                            | ≤ 100 MiB | ≤ 1 GiB   |

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

### Phase 3: localization files as columns

Recorded 2026-10-10 on Windows / Node 24.21.0, using the retained invented 1×/10× projects.
No regeneration or 10× in-memory reader. The Phase 1 supervisor retains one child, 16,384 MiB
heap, 20 GB OS RSS and 1,200 seconds per stage.

**Profiles.** PO: escape/block decoding led the first 1× CPU profile (447/281 ms self), followed by insertion and UTF-8 encoding (388/337 ms). Archive: record scanning led (276 ms), followed by insertion and UTF-8 encoding (202/201 ms).
Native bounded decoding/scanning, shared PO fast decoding, per-entry dictionaries and encodeInto
replace the profiled character/encoding costs. The revised profile is dominated by entry/schema,
dictionary, string allocation and GC work; decoder/hash take 1.59/1.39 s of the 1× file passes.
The 150 MiB/s goal remains unmet and needs further entry-pipeline optimization.

**Decisions.** Stats record size, exact mtime/ctime nanoseconds and inode/device beside the content key; Windows tests verify stable identity across stats and rewrites. Stat hits open no source. Changed stats hash and parse once; existing hashes discard the parse, and before/after handle/path stats return typed retry failures on mutation. Input spooling is removed; only bounded column blocks spill. Importer version 3 revises the layout while retaining SHA-256(version, normalized options, raw content hash).
Canonical PO context/key comments, empty arrays, zero-msgstr duplication, source-equal translations
and repeated reference prefixes are derived within each file. Measured zstd levels 3/6/9/19 select
identity 6, paths 9, source/translation/comments 3; numerics retain 1. Source 19 costs 184–193 s/file,
identity 19 costs 33–39 s/file, paths 19 costs 9.08 s versus 0.87 s at 9.
The [snapshot guide](../docs/engineering/game-text-snapshots.md#localization-file-import) records
columns/bits and unchanged limits: 16 GiB input/spill, 4 M rows/nodes, depth 64, 4 MiB records,
2,560 files and 512 MiB identities. Existing reader defaults remain unchanged.

**Measurements.** Warm disk, fresh separate file/target caches. Times include all import work
through persisted verification; touched inputs rewrite the same bytes before timing. Memory is
heap / buffers / RSS MiB, using pre-GC/OS peaks; buffers are lower bounds and RSS retains pages.
The [measurements](../docs/engineering/game-text-localization-import-measurements.md) contain
all operations per format, every file's CSV, exact column/domain bytes and every codec result.

| Scale / format (files) |     Seconds |     MiB/s | Heap / buffers / RSS MiB | Snapshot MiB |
| ---------------------- | ----------: | --------: | -----------------------: | -----------: |
| 1× manifest (1)        |        2.14 |      39.8 |     170.3 / 52.3 / 386.2 |         3.26 |
| 1× archive (10)        |   1.55–1.81 | 46.6–58.0 |     168.6 / 95.7 / 433.4 |    2.22–3.15 |
| 1× po (10)             |   1.63–2.00 | 28.5–36.6 |     161.3 / 90.6 / 441.8 |    3.28–4.25 |
| 10× manifest (1)       |       24.09 |      35.8 |   632.4 / 386.3 / 1027.5 |        32.77 |
| 10× archive (20)       | 16.51–18.53 | 48.7–51.5 |   403.9 / 427.9 / 1265.3 |  22.59–32.20 |
| 10× po (20)            | 16.99–18.64 | 30.9–35.5 |   454.7 / 432.3 / 1234.7 |  32.99–42.79 |

Complete target including discovery; stat-hit logical throughput is skipped bytes, not physical IO:

| Target / operation | Read MiB |  Seconds | Logical MiB/s | Heap / buffers / RSS MiB | Snapshot MiB | Published / stat hits |
| ------------------ | -------: | -------: | ------------: | -----------------------: | -----------: | --------------------: |
| 1× cold            |  1507.45 |  37.6353 |          40.1 |     187.3 / 79.7 / 422.7 |        75.38 |                21 / 0 |
| 1× touched         |  1507.45 |  37.2835 |          40.4 |     213.8 / 66.9 / 442.4 |        75.38 |                 0 / 0 |
| 1× stat hit        |     0.00 |   0.0536 |       28118.2 |       63.5 / 3.9 / 353.8 |        75.38 |                0 / 21 |
| 1× one-byte PO     |    59.61 |   1.6336 |         922.8 |     140.2 / 60.2 / 410.2 |        75.38 |                1 / 20 |
| 10× cold           | 29466.57 | 695.3285 |          42.4 |   590.8 / 460.2 / 1222.5 |      1513.06 |                41 / 0 |
| 10× touched        | 29466.57 | 524.6622 |          56.2 |   668.8 / 203.0 / 1047.0 |      1513.06 |                 0 / 0 |
| 10× stat hit       |     0.00 |   0.2014 |      146337.9 |      377.8 / 4.8 / 655.8 |      1513.06 |                0 / 41 |
| 10× one-byte PO    |   602.91 |  15.5483 |        1895.2 |   455.4 / 421.7 / 1033.0 |      1513.06 |                1 / 40 |

10× cold falls from 1,140.91 to 695.33 s; localization size falls from 1,886.05 to 1513.06 MiB.
Stat hits read zero bytes/publish zero snapshots; touched imports read/parse all files/publish zero.
The one-byte change reads/publishes one PO and changes exactly one key.
10× projection: **1513.06 MiB localization + 684.41 MiB joined + 332.98 MiB package estimate = 2530.45 MiB (2.47 GiB)**. The optimistic package proxy uses Phase 2's source (36.63), identity (114.46) and paths/occurrence IDs (181.89); package headers and extra coverage evidence would increase it. The measured independent complete-file layers exceed 1 GiB before joining. Reaching the target needs shared strings across files/layers or sparse evidence overlays and a smaller joined/package representation; no such design change is made here.

**Oracle and verification.** Reusable parser comparison covers all 21 committed fixture files,
including UE 5.7/5.8, every file at scales 0.0001/0.001, one-byte chunks, escapes/continuations,
late Crowdin headers, limits, typed failures, stat identity, mutation/retry and cleanup.
Abandoned import benchmark directories were removed with repository-local ordinary file deletion.

| Final verification command                                                                                                                         |                          Passed | Failed |
| -------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------: | -----: |
| `pnpm exec vitest run scripts/localization-import.test.ts packages/localization packages/game-text scripts/game-text-scale.test.ts --maxWorkers 1` |           465 tests (4 skipped) |      0 |
| `node26 node_modules/vitest/vitest.mjs run scripts/localization-import.test.ts --maxWorkers 1`                                                     |                        42 tests |      0 |
| pnpm --filter @ue-shed/localization build                                                                                                          |                         1 build |      0 |
| pnpm --filter @ue-shed/game-text build                                                                                                             |                         1 build |      0 |
| Benchmark CPU profiles, selected 1× PO/archive                                                                                                     |                          2 runs |      0 |
| Benchmark files / target, both scales                                                                                                              |                          4 runs |      0 |
| Benchmark size before / after / prefix / final directory                                                                                           |                          4 runs |      0 |
| pnpm exec tsc -p tsconfig.scripts.json --noEmit                                                                                                    |                         1 check |      0 |
| pnpm run lint                                                                                                                                      |                         1 check |      0 |
| pnpm run effect:architecture                                                                                                                       |                          1 gate |      0 |
| pnpm exec oxfmt, changed files                                                                                                                     |                        17 files |      0 |
| pnpm run check:precommit                                                                                                                           | 6 stages; 43 architecture tests |      0 |

node26 denotes the retained Node 26.11.1 executable under test-results/game-text-scale/runtime.

Live UE 5.7: unavailable under repository-only access; committed fixture oracle passed.
Live UE 5.8: unavailable under repository-only access; committed fixture oracle passed.
No native integration changed. Full pnpm check was not run; the requested portable gate is
check:precommit. Phases 4–7 and the whole-index size target remain outstanding.
