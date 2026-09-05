# Rust core review and SQLite reassessment — 2026-09-05

The [second speed pass](rust-core-speed-round2-2026-09-05.md) adds production discovery/transport
improvements and actual-project SQLite Catalog measurements. The experiments below remain the
historical baseline; the later report supersedes the absence of real-project SQLite evidence.

This review implemented five Rust improvements, fixed a package-check harness, and found that SQLite deserves another production
prototype. It does **not** replace the selected DuckDB Catalog or amend ADR 0007: the new measurements
are reproducible synthetic storage experiments, not full alternative-adapter conformance.

## Baseline and change ledger

- Starting commit: `bb36ee6324176e39edf7718624eb2e03dee468ce`.
- Existing user edits: Workbench `index.html`, `electron-window.ts`, `workbench-live.ts`, and untracked
  `public/`. Preserved; these are not part of this review.
- Production storage: duckdb-rs `1.10505.0` / DuckDB 1.5.5, Arrow ingestion in 1,024-package batches,
  immutable snapshots, 32,768-row groups, four query threads, cached query connection, 384 MB writer
  limit. No SQLite production dependency before or after this review.
- Baseline checks: parser 121 passed / two ignored, inspection 15 passed / one external-fixture test
  ignored, supervisor four passed, IO 55 library and 15 process tests passed.
- Environment: Windows x86-64, Ryzen 9 7950X (16 cores / 32 logical processors), 64 GiB RAM,
  Rust 1.94.0. Python 3.14, DuckDB 1.5.5, PyArrow 23.0.1, Python SQLite 3.50.4; native rusqlite
  0.37.0 bundles SQLite 3.50.2. No clock, filesystem-cache, or power-state control was imposed.

| Module                    | Before                                                                                             | Implemented behavior                                                                     | Evidence                                                                                                                                                              |
| ------------------------- | -------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Project Index refresh     | A cached failed header with unchanged metadata was reused; the next refresh could claim `Complete` | Retry failed headers while retaining healthy header reuse                                | Regression failed on both Catalog adapters before fixing; repeated failure stays `Partial`, then same-signature recovery becomes `Complete`                           |
| Catalog snapshot scan     | Open, SQL, and row decode failures were discarded as an empty/partial vector                       | Propagate typed storage failure through the Catalog snapshot interface                   | Missing snapshot plus empty enumeration previously published empty Generation 2; missing/corrupted snapshot now preserves original generation and manifest bytes      |
| Saved World resolution    | Recursive parent traversal could overflow the call stack                                           | Heap traversal and unwind with the existing transform math and cached diagnostics        | A 20,000-component acyclic chain previously exited with Windows `STATUS_STACK_OVERFLOW`; it now resolves x=20,000; a deep cycle returns the original cycle diagnostic |
| Header evidence selection | Clone and sort every name/class before retaining 64 unique values                                  | Keep a bounded borrowed set, allocate only retained strings                              | Same ordered evidence; regression covers duplicates, Unicode, late smaller values, and limits; retained benchmark compares three algorithms                           |
| DuckDB membership         | `list_has_any(column, [?])` even for a single value                                                | Use `list_contains(column, ?)` for exactly one value; retain overlap for multiple values | Native query benchmark: five-route median 1,130.58 → 764.92 ms; extended workload 3,934.64 → 1,962.48 ms, identical hydrated results                                  |

The snapshot trait now returns `Result`; Rust implementations of that interface need to propagate
failures. The TypeScript and wire interfaces, on-disk schema, and stored evidence meaning are unchanged.
Failed headers are deliberately retried on every refresh; permanently malformed packages will cost
another read rather than silently becoming complete.

For shuffled name maps, the isolated old/new selection medians were 33.99/12.70 microseconds at 512
names, 419.73/28.50 microseconds at 4,096, and 10.81/0.279 milliseconds at 65,536. The 4,096-name case
is about 14.7× faster. These are algorithm measurements; no equivalent end-to-end project refresh
speedup is claimed. Auxiliary selection retains at most 64 values, with a temporary 65th during
replacement, rather than building a set of the entire name map.

## Equal-workload storage experiments

The generated large dataset has 185,676 packages, 604,699 class values, and 7,643,771 name values.
It mixes shared names and per-package names and preserves path order. It approximates the cardinality
of the earlier research, but does not reproduce that private project's distribution. All data and
predicates are generic. No existing application cache or studio asset was used.

The five common route shapes return 15,944 items across 17 pages: maps, exact class, class prefix,
class-name suffix, and rare serialized name. The extended workload adds absent and common names,
returning 42,470 items over 44 pages. Every page hydrates full evidence and has the same ordered
contents across engines. Native measurements include connection setup, SQL preparation, hydration
into Rust strings/vectors, and result fingerprinting. Engine order rotates across five samples.
Files remain in the OS cache; these are not cold-disk or process-per-page measurements.

| Query implementation                            | Five routes, 185k median | Seven routes, 185k median | Seven routes, 8k median | Snapshot size, 185k |
| ----------------------------------------------- | -----------------------: | ------------------------: | ----------------------: | ------------------: |
| DuckDB production baseline                      |              1,130.58 ms |               3,934.64 ms |                90.80 ms |            47.46 MB |
| DuckDB single-value membership, now implemented |                764.92 ms |               1,962.48 ms |                64.37 ms |            47.46 MB |
| DuckDB page-first CTE, rejected                 |              1,099.08 ms |               4,137.62 ms |               113.18 ms |           same file |
| SQLite JSONB scans                              |                882.00 ms |               1,665.12 ms |                53.81 ms |           170.75 MB |
| SQLite unbounded postings candidates            |                148.77 ms |               2,086.43 ms |                15.88 ms |           403.40 MB |
| SQLite bounded postings page, then hydrate      |            **113.24 ms** |             **279.77 ms** |            **13.66 ms** |       **403.40 MB** |

The SQLite postings adapter prototype stores `(kind, value, package_id)` in a covering `WITHOUT
ROWID` primary key. Reversed class names turn suffix matching into a prefix range. Package IDs follow
path order within an immutable snapshot. The faster query translates the path cursor, selects at
most 1,025 distinct candidate IDs, and only then loads header JSONB. This matters especially for
common values: materializing all candidates anew for each page erased much of SQLite's advantage.
This is consistent with SQLite's documented use of multi-column indexes for searching and sorting.
See [SQLite query planning](https://www.sqlite.org/queryplanner.html).

SQLite JSONB avoids parsing text JSON internally, but a JSONB array is not automatically an inverted
index. Plain JSONB therefore does not remove the scan cost for missing or rare serialized names.
See [SQLite JSON functions](https://www.sqlite.org/json1.html).

Connection-per-page totals for the seven-route native workload were 4,382.81 ms for baseline DuckDB,
2,404.95 ms for improved DuckDB, and 280.22 ms for bounded SQLite. These exclude process startup.
The Python prototype showed the same direction, but the table uses native results to avoid basing
the decision on Python list/JSON conversion differences.

## Build and immutable replacement costs

| Storage model   | Synthetic ingestion + finalize | One changed header: copy + commit | One deletion: copy + commit | Size relative to DuckDB |
| --------------- | -----------------------------: | --------------------------------: | --------------------------: | ----------------------: |
| DuckDB          |                         5.77 s |                           1.170 s |                     1.173 s |                      1× |
| SQLite JSONB    |                         0.89 s |                           0.397 s |                     0.403 s |                    3.6× |
| SQLite postings |                        14.08 s |                           0.940 s |                     1.228 s |                    8.5× |

These are single exploratory build/mutation observations, not distributions or native refresh
benchmarks. Input/Arrow/JSON/posting preparation was measured separately and excluded from ingestion;
Python call overhead remains. DuckDB uses bounded Arrow registration/insertion in this driver rather
than the production Rust Appender. SQLite inserts in one transaction with `synchronous=FULL`, then
runs `ANALYZE`. Mutation measurements include copying to a new snapshot before any changes, and
check complete query equality afterward. They do not time atomic manifest replacement or OS power-loss
durability. DuckDB uses ordered CTAS; SQLite uses backup. The SQLite delete scans postings by package
ID because this experiment deliberately has no second index for that direction.

Warm no-op publication can reuse the immutable physical file with either engine. A SQLite production
adapter still needs to prove that through the actual coordinator. New path insertion is not covered:
the path-ordered ID strategy needs rebasing or a different key layout when inserting between IDs.
Any claimed incremental update advantage must include that cost and the cost of maintaining postings.

## CI findings and recommendation

SQLite is now a credible candidate: its measured bounded queries exceed the requested "near perf"
target, even against the improved DuckDB query. Its costs are a roughly 8.5× larger disposable Catalog
and slower indexed construction in this prototype. The minimal JSONB design is smaller and fast to
build, but does not consistently beat improved DuckDB on the five common route shapes.

The native build difference is real in size, but no clean Depot timing was measured. On this machine,
the bundled DuckDB static archive is 613,323,006 bytes versus SQLite's 4,873,280 bytes. These are build
artifacts, not shipped executable sizes. The standalone two-engine research build reused existing
dependencies; its elapsed time cannot establish a clean-build speedup.

The IO lane already uses `RUSTC_WRAPPER=sccache`; the installed `cc` crate honors that wrapper for
C/C++ too. Simply adding a C++ wrapper is not a discovered fix. A prebuilt DuckDB library is another
possible route to simpler builds, but requires deliberate binary provenance, platform packaging,
and offline-build treatment. DuckDB documents this option in its
[Rust troubleshooting guide](https://www.duckdb.org/docs/current/clients/rust/troubleshoot).
No CI workflow was changed based on unmeasured assumptions.

**Recommendation:** retain the five implemented improvements, then evaluate a complete immutable
SQLite Catalog adapter behind the existing seam. Reopen ADR 0007 only after it passes the same
coordinator/conformance, stale-generation, cancellation, cross-process reader, corruption/quarantine,
bounded-memory, native/protocol, and package-release checks, plus representative refresh and insertion
benchmarks and clean Depot timing. This is a concrete follow-up candidate, not a claim that the
synthetic query runner is production-ready. No extra backend switch is introduced for users.

Other engines were not benchmarked: RocksDB/LMDB/redb would require custom secondary indexes for
these predicates, and PostgreSQL introduces a server into a disposable local Catalog. They do not
currently offer a clearer path to the user's stated preference for something more common and easier
in CI than SQLite. This is an architectural assessment, not a performance result for those engines.

## Reproduction and evidence

The broader library check also exposed a pre-existing packed-WASM harness failure: it invoked
`node_modules/typescript/bin/tsc`, but the TypeScript 6 compatibility alias now exposes `tsc6`.
The harness now invokes the repository's TypeScript 7 compiler at `@typescript/native/bin/tsc`.
The real packed-consumer declaration check, Node exports, and Chromium smoke test passed afterward;
the scripts TypeScript check and focused lint also passed.

- [Research tools and commands](../../tools/benchmarks/README.md).
- [Machine-readable measurement summary](rust-core-review-2026-09-05.json).
- Local raw evidence: `test-results/rust-core-review-2026-09-05/`, including baseline IO logs,
  all native samples, Python samples, mutations, header-selection distributions, and final check logs.
- Existing decision context: [ADR 0007](../decisions/0007-separate-uasset-inspection-and-io.md) and
  [the previous storage research](../engineering/duckdb-project-index-research.md).

Final validation: `uasset:check:libraries` and `uasset:check:io` both passed, including Rust formatting,
Clippy, parser/inspection/IO tests, browser WASM, packed-consumer declarations and runtime, and
native/WASM parity. IO now has 59 library and 15 process tests; inspection has 16 passing tests and
one expected external-fixture ignore. The standalone research crate passed Clippy with warnings
denied; scripts typechecking and focused lint passed. This review does not claim that the full Depot
gate ran locally. The accompanying JSON retains samples and validation status.

## Follow-up: actual showcase project scan

The user subsequently supplied a real local project. Its identities remain outside this repository's
research record. The maintained `benchmark:project-index` command ran the same Project Index refresh,
bounded queries, header folding, and targeted Enhanced Input scan used by the showcase. Project
content was read-only; disposable Catalogs lived in the benchmark's temporary directory.

The first run exposed another Rust protocol bug: `SavedPropertyValue::Text` serialized absent
localization namespace/key fields as JSON null. The shared inspection schema requires those fields
to be omitted for history `none`. Indexing succeeded, but the subsequent input scan failed schema
validation. The Rust serializer now omits absent identities, preserving identities for base text.
A generic serialization/round-trip regression failed before the fix and passed afterward; no private
asset, text, path, or schema was added to fixtures.

After the fix, the IO gate passed again (60 library tests, 15 process tests, Clippy, formatting, and
native/WASM parity). The unchanged showcase benchmark then completed all three cold and warm samples:

| Observation                                            |                   Result |
| ------------------------------------------------------ | -----------------------: |
| Packages                                               |                   10,128 |
| Maps                                                   |                       59 |
| Folded candidate headers                               |                    2,425 |
| Query pages                                            |                        7 |
| Enhanced Input packages inspected                      |                       38 |
| Input Actions / Mapping Contexts                       |                  26 / 12 |
| Enhanced Input partial / failed packages               |                    0 / 0 |
| Cold Catalog + queries + input decode, median          |             1,423.729 ms |
| Warm refresh + queries, median                         |               605.263 ms |
| Warm changed packages / header reads / evidence writes |                0 / 0 / 0 |
| Catalog size                                           | approximately 7.6–7.9 MB |

Enhanced Input reported complete coverage and no diagnostics. "Cold" still means an absent Catalog,
not a flushed OS file cache; the successful runs followed diagnostic scans. Warm measurements omit
input decoding, as specified by the maintained harness. These are production DuckDB measurements on
the real project, not an actual-project SQLite comparison. The synthetic speed ratio must not be
applied to this smaller project's complete scan time.

Raw before/after and aggregate coverage evidence is retained under
`test-results/rust-core-review-2026-09-05/project-index-real-project*.json`; the successful three-run
result is `project-index-real-project-fixed.json`. The accompanying research JSON includes this
sanitized real-project evidence alongside the original synthetic measurements.

## Follow-up: controlled before/after on the real project

After the user requested an actual before/after comparison, the original Rust tree at
`bb36ee6324176e39edf7718624eb2e03dee468ce` was exported into an ignored standalone source directory
and built with the same release profile, toolchain, and locked dependencies. The **only** baseline
patch was the text namespace/key omission fix above: without it, the original code cannot finish
the cold workload. All performance changes remain absent from the baseline. Both executables were
preserved with SHA-256 identities; the current executable was restored to `target/release/uasset.exe`.

The unchanged showcase harness ran four five-sample blocks in before/after/after/before order, with
one configured warmup per block. That gives ten measured samples per version per scenario. OS caches
were already warm and were not flushed. Both versions returned the same aggregate counts: 10,128
packages, 59 maps, 2,425 candidate headers, seven pages, and 38 input candidates/inspections. All
scenarios completed; warm samples read and rewrote zero package headers.

| Complete showcase workload            | Before median | After median | Observed reduction |
| ------------------------------------- | ------------: | -----------: | -----------------: |
| Cold Catalog + queries + input decode |  1,275.636 ms | 1,252.385 ms |               1.8% |
| Warm refresh + queries                |    556.863 ms |   535.472 ms |               3.8% |

These are modest observed differences, not a decisive large speedup. Cold ranges overlap heavily:
1,235.962–1,347.953 ms before and 1,226.145–1,352.799 ms after. Warm ranges also overlap:
511.574–589.010 ms before and 523.879–542.930 ms after. Cold query-phase medians were
284.305 → 261.811 ms; warm query-phase medians were 269.174 → 246.894 ms. Phase medians are marginal
measurements and should not be added together to reconstruct the median total.

**Conclusion:** the earlier synthetic SQLite query ratio is not a showcase scan speedup. SQLite
still has not replaced the production Catalog. The actual current optimizations save roughly
20–25 ms in the median complete scan on this project; correctness fixes are valuable independently,
but this is a first pass, not the end of performance work. A substantial further optimization needs
to address the measured production refresh/process/query costs, with an equivalent real-project
before/after gate.

The raw blocks, frozen binaries, source export, current Rust patch, and comparison script are retained
locally in `test-results/rust-core-review-2026-09-05/real-project-ab/`. The research JSON includes all
timing samples, phase medians, methodology, and binary hashes under `real_project_before_after`.

### Separate phase measurements

The same ten-sample before/after comparison yields the following phase medians. Fresh Catalog scan
and warm refresh below end at completed refresh; they exclude the subsequent queries, folding, and
input decoding. These are elapsed client-side operations, including their worker/process/protocol
costs, not pure parser or SQL CPU timings.

| Phase                                        |   Before |    After |
| -------------------------------------------- | -------: | -------: |
| Fresh Catalog scan/build                     | 914.4 ms | 891.1 ms |
| Warm refresh, unchanged project              | 231.0 ms | 215.4 ms |
| Queries following fresh build, seven pages   | 284.3 ms | 261.8 ms |
| Queries following warm refresh, seven pages  | 269.2 ms | 246.9 ms |
| Targeted input decode, 38 packages           |  58.6 ms |  59.2 ms |
| TypeScript header folding after fresh build  |  14.2 ms |  15.3 ms |
| TypeScript header folding after warm refresh |  12.3 ms |  12.6 ms |

Input decode is measured only in the cold scenario. Fresh means an absent application Catalog; OS
file caches were warm. Independent medians do not necessarily add to the median scenario duration.
Scenario duration additionally includes host orchestration and benchmark resource-sampler shutdown.

Further useful measurement categories:

- Filesystem discovery/stat and signature comparison, separately from package reads/header parsing.
- Storage ingestion, prior-snapshot copy, ordered snapshot construction/checkpoint, and manifest
  publication. The existing evidence-write timer includes work during both header and commit phases;
  it must not be added to those phase durations or subtracted from the header phase as pure parsing
  time. The current clamped `headerProcessingExcludingEvidenceWritesMs` cannot prove parser CPU cost.
- Each query kind, first page, and continuation pages; connection/worker startup, transport, JSON
  validation, and Rust SQL execution need separate attribution.
- Incremental refresh with one/many changes, insertions, and deletions; cancellation and recovery.
- Time until the Workbench displays useful results, including renderer work. The headless benchmark
  does not measure this.
- Peak Rust/Node memory, Catalog and protocol bytes, plus clean and cached CI build time. Resource
  evidence exists for the scan; clean Depot build timings still do not.

## Follow-up: small, medium, and large project variance

The same frozen before/after executables and unchanged showcase benchmark now cover the repository
fixture and two user-selected local projects. Private project identities remain outside this report.
Each cohort has four blocks in before/after/after/before order, five measured samples per block and
one configured warmup: ten samples per version for fresh builds and ten for warm no-op refreshes.
The medium cohort reuses the preceding comparison; small and large cohorts ran afterward, serially.
All scenarios completed. Aggregate inventory counts match before/after, and every measured warm
refresh reported zero changed packages, header reads, and committed evidence rows.

| Cohort | Packages | Maps | Folded headers | Query pages | Input candidates |
| ------ | -------: | ---: | -------------: | ----------: | ---------------: |
| small  |       71 |    4 |             56 |           5 |               25 |
| medium |   10,128 |   59 |          2,425 |           7 |               38 |
| large  |  199,539 |  257 |         14,927 |          18 |              173 |

### Separate phase medians

All cells are **before → after**, in milliseconds. Fresh scan ends at completed Catalog refresh;
queries, header folding, and input decode are separate operations. OS file caches were not flushed.
Phase medians are independent and do not add to the median complete workload.

| Phase                             |       Small |        Medium |               Large |
| --------------------------------- | ----------: | ------------: | ------------------: |
| Fresh Catalog scan                | 78.6 → 74.7 | 914.4 → 891.1 | 18,889.8 → 18,661.1 |
| Warm refresh                      | 56.0 → 54.5 | 231.0 → 215.4 |   4,802.9 → 4,699.8 |
| Queries after fresh scan          | 37.2 → 37.3 | 284.3 → 261.8 |   2,142.7 → 1,955.7 |
| Queries after warm refresh        | 36.3 → 35.2 | 269.2 → 246.9 |   2,136.4 → 1,869.3 |
| Input decode                      | 28.5 → 28.1 |   58.6 → 59.2 |       178.3 → 187.2 |
| Header folding after fresh scan   |   0.4 → 0.4 |   14.2 → 15.3 |         83.6 → 85.8 |
| Header folding after warm refresh |   0.3 → 0.3 |   12.3 → 12.6 |         81.7 → 75.6 |

### Memory and storage medians

All values below are **before → after, in MiB** (1,048,576 bytes). Memory is the median
of the maximum observed working set/RSS in each complete scenario, not an allocation count or an
OS-guaranteed peak. Rust and Node peaks occur independently and must not be summed as a joint peak.
Node is the long-lived headless benchmark host, including runtime and previously retained heap;
it is not full Workbench or renderer memory. Rust sampling attempts occur every 50 ms through a
PowerShell helper, so short workers and spikes can be missed. No Rust observation was captured for
the small fixture in either scenario; unavailable means missing, not zero.

Storage is the sum of logical file sizes under the disposable cache root after the scenario,
including metadata and retained files. It is not peak temporary disk usage or allocated filesystem
blocks. File-layout variation can change the size even with matching inventory counts.

| Cohort / scenario | Rust sampled peak | Node sampled peak |   Cache on disk | Protocol output |
| ----------------- | ----------------: | ----------------: | --------------: | --------------: |
| small / fresh     |       unavailable |   159.31 → 159.16 |     0.51 → 0.51 |     0.16 → 0.16 |
| small / warm      |       unavailable |   160.08 → 160.68 |     0.51 → 0.51 |     0.08 → 0.08 |
| medium / fresh    |     74.72 → 71.78 |   225.40 → 212.57 |     7.64 → 7.51 |     4.06 → 4.06 |
| medium / warm     |     24.53 → 24.80 |   302.36 → 314.91 |     7.76 → 7.39 |     3.61 → 3.61 |
| large / fresh     |   571.71 → 570.07 |   332.81 → 326.10 | 138.51 → 139.26 |   24.64 → 24.64 |
| large / warm      |   148.31 → 161.72 |   351.66 → 332.03 | 138.76 → 139.64 |   22.93 → 22.93 |

### Variation and interpretation

| Cohort / complete workload |   Before median (min–max), ms |   After median (min–max), ms |
| -------------------------- | ----------------------------: | ---------------------------: |
| small / fresh              |           151.5 (140.5–306.6) |          147.9 (141.6–181.2) |
| small / warm               |           146.8 (138.7–151.8) |          143.5 (141.3–148.7) |
| medium / fresh             |     1,275.6 (1,236.0–1,348.0) |    1,252.4 (1,226.1–1,352.8) |
| medium / warm              |           556.9 (511.6–589.0) |          535.5 (523.9–542.9) |
| large / fresh              | 21,334.1 (19,397.3–186,714.2) | 20,962.7 (19,018.8–22,988.0) |
| large / warm               |     7,044.5 (6,834.2–7,392.9) |    6,673.5 (6,589.1–6,879.5) |

The first observed large-project baseline fresh workload took **186.7 seconds**, including 184.1
seconds in refresh. The remaining samples in that block were about 22.8–23.7 seconds, and later
blocks became faster again. That first read is retained in the raw samples and ranges; it is not
evidence of an optimization speedup. OS cache state was uncontrolled, so even the medians are
observations rather than a causal estimate with a confidence interval.

The large cohort's median complete fresh workload changed 21.33 → 20.96 seconds (1.7% lower), and
warm changed 7.04 → 6.67 seconds (5.3% lower). Warm query time changed 2.14 → 1.87 seconds while
warm refresh itself remained about 4.7–4.8 seconds. Fresh Rust sampled memory stayed around 571 MiB;
warm Rust sampled memory rose from 148.31 to 161.72 MiB. These results do **not** establish a memory
or storage improvement. Small differences in the medium cohort and Node heap measurements should
likewise not be treated as reliable allocation reductions.

This remains a comparison of original versus improved **DuckDB-backed production code**. Neither
real-project SQLite scans nor peak temporary storage, per-phase memory, renderer memory, or clean
CI build costs were measured. The synthetic SQLite results above remain separate evidence.

Raw small/large blocks and the aggregation script are retained locally under
`test-results/rust-core-review-2026-09-05/scale-ab/`; medium blocks remain under `real-project-ab/`.
The accompanying research JSON records all samples, memory observation counts, ranges, phase
timings, inventory checks, and frozen binary hashes under `project_scale_comparison`.
