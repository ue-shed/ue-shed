# Fresh Catalog scan optimization — 2026-09-06

Fresh scans improve by about 8% for the medium project and 5.5% for the large project. The small
fixture is effectively unchanged. The retained changes are confined to native IO: batched header
messages, append-and-sort staging, and direct indexing during posting construction. No parser,
protocol, TypeScript, renderer, dependency, or persisted-format changes are retained.

## Baseline and method

Baseline: `1756fcb269f0f6cc8ba2cd9514938c77f5f46a81` on `perf/sqlite-next`. This follows the
[full-flow pass](full-flow-2026-09-06.md); its improvements are already in this baseline.
Windows x64, Ryzen 9 7950X, 32 logical CPUs, 64 GiB RAM, Rust 1.94.0 and Node 26.5.0.

The cohorts are the checked-in fixture (71 packages, 4 maps), medium (10,128 packages, 59 maps),
and large (199,539 packages, 257 maps). Private project roots were read-only and are omitted.
Fresh means an empty Catalog; the OS filesystem cache was not flushed. All timing blocks ran
serially without compilation or tests. Both readers used the same built TypeScript adapter.

Small and medium have three samples per state and variant. Large has three baseline samples,
six retained samples, then three baseline confirmation samples; the two baseline blocks are pooled
for its reported six-sample median. Each block has one untimed warmup per state. All timed samples
remain in the evidence, including exploratory outliers. These are local measurements, not guarantees.

[Raw JSON](fresh-scan-2026-09-06.json) contains samples, phase times, profiles, source/executable
hashes, rejected experiments, complete query/count parity, snapshot hashes, and packed artifact checks.
Scratch builds, prototypes, and logs live under ignored `test-results/fresh-scan-2026-09-06/`.

- `base.exe`: 4,947,968 bytes; SHA-256 `f2a64a93e8299a273fc4d3446cfac266ee0b10b76dfd53f7f631fe6ce160b3b0`.
- `retained.exe`: 4,939,776 bytes; SHA-256 `e38317bef9d6988697143eadc890f8c9123a3af5512bf6c94c568d612f0d5343`.

## Separate before/after results

Milliseconds, baseline → retained. Queries traverse all five paged candidate routes after warm
refresh. Input decode is the targeted Enhanced Input step from fresh runs.

| Cohort |          Fresh scan |    Warm refresh |         Queries |    Input decode |
| ------ | ------------------: | --------------: | --------------: | --------------: |
| Small  |       37.30 → 38.73 |   17.89 → 18.35 |   17.06 → 17.25 |   24.13 → 25.03 |
| Medium |     218.51 → 200.94 |   36.64 → 35.61 |   81.44 → 77.03 |   60.67 → 56.14 |
| Large  | 2,784.85 → 2,630.68 | 542.72 → 541.26 | 460.28 → 437.89 | 200.02 → 186.61 |

The large fresh improvement is about 154 ms. Warm refresh is unchanged. Query and input-decode
code did not change, so their timing differences are not claimed as direct improvements. The
fixture has about 1.4 ms more fresh overhead in this block; there is no meaningful fixture win.

| Cohort | Full fresh workload ms | Full warm workload ms |
| ------ | ---------------------: | --------------------: |
| Small  |        150.66 → 152.66 |       146.31 → 147.71 |
| Medium |        374.02 → 363.35 |       156.02 → 151.71 |
| Large  |    3,586.86 → 3,369.05 |   1,135.78 → 1,082.30 |

Full workload timers include startup, folding and sampler completion. Stage medians cannot be
added to reconstruct total medians. Electron startup was not remeasured in this native-only pass.

| Large native fresh phase | Before ms | After ms |
| ------------------------ | --------: | -------: |
| enumeratingMs            |     339.5 |    347.5 |
| comparingMs              |      31.5 |     31.0 |
| readingHeadersMs         |    1763.0 |   1699.5 |
| committingMs             |     636.0 |    502.0 |

The largest repeatable phase improvement is committing the initial Catalog. The header phase
also improves, while discovery and comparison are effectively unchanged.

## Profiling and experiments

The refreshed profile uses the current 16-worker pipeline. Timers are injected into a disposable
source copy; production has no added profiling hooks. Worker elapsed totals overlap and must not
be summed into wall time. The following stages execute on the coordinator thread; each column is
one instrumented run, which explains the direction rather than replacing the repeated benchmarks.

| Coordinator stage | Before ms | Retained ms |
| ----------------- | --------: | ----------: |
| sink              |    1434.1 |      1223.4 |
| receive_wait      |     284.0 |       297.5 |
| records_postings  |     262.2 |       142.0 |
| strings_lexicon   |      40.2 |        34.3 |
| posting_encoding  |      46.4 |        34.9 |
| section_checksums |       7.5 |         7.5 |
| write_sync        |      69.9 |        67.0 |
| verify_snapshot   |      91.1 |        91.6 |

The retained profile precedes an equivalent Clippy cleanup from index lookup to iterator access
in the coordinator loop. Final uninstrumented timings use the rebuilt, lint-clean source.

| Exploratory large variant, cumulative unless noted | Fresh median ms |
| -------------------------------------------------- | --------------: |
| base                                               |         2967.00 |
| hash-staging                                       |         2827.28 |
| dense-postings                                     |         2835.13 |
| checkpoint                                         |         2802.89 |
| batch                                              |         2667.11 |
| flat-staging                                       |         2746.61 |
| no-checkpoint                                      |         2636.44 |

These initial three-sample blocks are useful for choosing experiments, but their favorable
differences are not additive and are not the final claims. For example, the exploratory hash-staging
block retains its slow first fresh run. The final baseline confirmation produces a smaller overall
gain than comparing only the first baseline block to the best trial.

Retained:

- Send eight observations per channel message, preserving signature order at the sink. The channel
  queues hold at most 1,024 results in total, plus bounded producer/consumer batches. Partial final
  batches, multiple queue boundaries, and early sink failure are covered. Worker count remains 16.
- Append changed records to a vector, stably sort once, and merge with sorted observed paths.
  This avoids a second path-keyed lookup structure. Stable duplicate handling preserves the last
  staged record and only its postings. Hash-based staging was an intermediate experiment.
- Build posting lists by dense string ID instead of hashing every class/name occurrence. Empty
  lists are omitted; serialization still emits kind/value order and identical snapshot bytes.

Rejected or deferred:

- A parser checkpoint bound a validated summary to its exact serialized bytes and file length,
  then reused the ordinary checked table decoder. It passed 126 parser tests (two existing ignored)
  and IO oracle tests, including changed/truncated prefix and malformed table cases. Removing it
  improved the final exploratory block from 2.75 to 2.64 seconds. Its extra API and retained prefix
  allocation did not earn a fresh-scan win, so all parser changes were removed.
- Repeated name-list caching lacks a compelling bounded hit rate: 104,907 distinct lists across
  199,539 headers, only 5,823 adjacent repeats (2.9%), and 39,343 hits in an offline last-64 model
  (19.7%). No cache was added; hashing/copying those keys could erase the benefit.
- File opening/signature work remains substantial, but the current serial coordinator and commit
  profile justified cheaper data-structure changes first. No freshness checks, header validation,
  checksums, file synchronization, or atomic-publication behavior were removed.

The profiling helper also now copies only tracked fixture inputs. Its first attempt copied
Unreal-generated build outputs and encountered insufficient disk space; that failed preparation
is not a timing sample. The corrected helper is used for the successful profiling builds.

## Memory and storage

MiB, median sampled fresh-run process peaks. Missing brief native processes remain uncaptured.

| Cohort | Native fresh peak | Node fresh peak |   Catalog storage |
| ------ | ----------------: | --------------: | ----------------: |
| Small  |      Not captured | 146.84 → 151.07 |     0.071 → 0.071 |
| Medium |     42.68 → 42.38 | 227.84 → 182.17 |     8.230 → 8.230 |
| Large  |   382.90 → 362.25 | 266.46 → 269.12 | 130.997 → 130.997 |

Large maximum sampled fresh peaks are native 387.73 → 374.20 MiB and
Node 317.33 → 290.00 MiB. Working-set samples are not allocator accounting.
Storage remains unchanged except tiny manifest filename-length differences. Actual physical
snapshot files are byte-identical before and after on every cohort.

## Verification

- Windows and Linux SQLite-oracle conformance: 99 passed, one existing ignored; 15 process tests
  passed on each platform. Repeated unordered staging and batch-boundary ordering are covered.
- IO gate passed: architecture, Rust formatting, Clippy with `-D warnings`, default native/process
  tests, and native/WASM parity for nine fixtures, compact projections, and typed failures/limits.
- Rust 1.89 library check passed before the equivalent iterator cleanup. Its library-only build
  retains the existing unused lookup-helper warning; the modern all-target Clippy gate is clean.
- All five ordered query routes and aggregate count unions match baseline on all three cohorts,
  including duplicate filters. Every physical snapshot SHA-256 also matches.
- The packed native npm artifact installs offline and works with empty PATH: fresh/warm fixture
  scans, map queries, and aggregate counts. No runtime dependency was added.
- Final formatting, whitespace, and private-project-data checks pass. Unrelated Workbench icon
  changes remain untouched. The full `pnpm check` was not run, per repository instructions.

The measured opportunities are retained. Further fresh-scan work should first isolate allocation
and string-interning costs inside the remaining coordinator time, or demonstrate a better file
loading strategy without weakening signature revalidation. The discarded summary checkpoint shows
why reducing repeated worker computation alone does not guarantee a faster complete scan.
