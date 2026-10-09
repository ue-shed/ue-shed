# Plan 057: A compact, persistent Game Text index

> **Executor instructions**: Follow this plan in order. Before editing, read `AGENTS.md`,
> `docs/README.md`, `docs/products/game-text.md`, ADR 0007, `docs/engineering/binary-project-index.md`,
> Plans 033, 037 (archived) and 056, and `docs/engineering/testing.md`. Run targeted checks while
> iterating and `pnpm check` before handoff. Honour the STOP conditions.
>
> **Drift check (run before each phase)**:
> `git diff origin/main...HEAD -- packages/game-text packages/localization packages/unreal-assets crates/uasset-io apps/cli apps/workbench extensions/game-text`.

## Status

- **State**: TODO. Phase 1 is next.
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

- A deduplicated string table: one UTF-8 byte section plus an offsets column. Paths may later use a
  prefix tree if the measurements justify it.
- Columns as little-endian typed arrays, 4-byte aligned, so a reader views them without copying.
- Sparse columns where a dense one wastes space. For example, a PO translation is stored only where it
  differs from the archive's, and unknown reasons are stored per line when every culture shares them.
- Sections checksummed; whole snapshots compressed with zstd, chosen by measurement in Phase 2.
- A small manifest names the current snapshot and the keys of its inputs, published atomically under
  one writer lock, with readers keeping the snapshot they opened. These are the binary catalog's
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
- A benchmark command records, for today's pipeline at 1× and as far as 10× gets: wall time, peak
  heap, peak RSS, and where it fails. Results go to ignored `test-results`, and the plan records
  them.
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
