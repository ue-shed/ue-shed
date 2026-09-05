# Rust core speed pass 2 and actual-project SQLite comparison — 2026-09-05

This pass makes production discovery and Project Index validation faster, fixes worker shutdown,
and runs SQLite through the real coordinator, protocol, and showcase workload. Speed was prioritized;
memory and storage are guardrails. SQLite is now supported by actual-project evidence, not only
the [previous synthetic experiments](rust-core-review-2026-09-05.md).

Historical status at the end of this pass: production still selected DuckDB. The later
[canonical SQLite pass](sqlite-canonical-2026-09-05.md) supersedes that selection. These SQLite
adapters were isolated, reproducible research builds;
they do not change the shipped dependency graph, cache selection, or CI. This distinction matters
when reviewing the performance result versus adopting a fully supported backend.

## Baseline and changes

The starting executable is the previous pass's final binary, SHA-256
`0898e3ce594a4e84dc8bb5ec4b8d6903357ce4805c17b9d0cf74189bd4a16276`.
It already includes the prior Rust correctness fixes, bounded header-name selection, and singleton
DuckDB membership optimization. The original commit remains
`bb36ee6324176e39edf7718624eb2e03dee468ce`; this pass is incremental to that earlier work.

| Area                              | Change                                                                                                                                                      | Evidence                                                                                                                                                                     |
| --------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Discovery                         | Collect signatures during traversal using directory-entry metadata; remove the second stat pass and redundant directory sorts; retain final stable ordering | Large enumeration 4.35–4.48 s in baseline samples versus 1.92–2.03 s in discovery samples; signatures match explicit rereads in a real-filesystem test                       |
| Worker shutdown                   | Drop all result receivers before joining header workers after an early stop                                                                                 | Sink-failure regression returns the original error; no blocked sender can retain the scope                                                                                   |
| Protocol validation               | Use the existing exact type-side validator for Project Index pages at 128 KiB; preserve full decoder errors on invalid input                                | Representative 2.8 MB page: 31.09 → 7.20 ms in the isolated validator measurement; 21 focused transport/protocol tests pass, including nested constraints and unknown fields |
| Header concurrency                | Tried eight workers, retained four                                                                                                                          | Large fresh refresh 14.91 s at eight versus 14.61 s at four; no demonstrated benefit                                                                                         |
| SQLite path postings              | Tried paths in every posting, rejected                                                                                                                      | Large fresh refresh 26.56 s; cache 1.85 GiB; a single exploratory screen                                                                                                     |
| SQLite integer postings           | Rebase IDs in path order inside every physical commit, then index evidence                                                                                  | Full actual refresh and query workloads complete; shared coordinator tests cover changed/deleted/renamed inputs                                                              |
| SQLite class indexes + name scans | Keep class indexes, scan JSONB name arrays                                                                                                                  | Avoids the largest index-construction cost while preserving all five showcase query results; absent-name latency is a tradeoff                                               |

On Windows, `DirEntry::metadata` needs no additional system call; on Unix it is equivalent to
`symlink_metadata`. Discovery continues to skip symlink entries, and changed package headers are
still revalidated after reading. These timings are Windows measurements, not a claimed Unix speedup.
See [Rust directory-entry metadata](https://doc.rust-lang.org/std/fs/struct.DirEntry.html#method.metadata).

The Project Index wire schemas contain validation constraints without decode transformations.
The fast path validates the complete event, including nested arrays and excess-property rejection;
it does not trust unvalidated JSON or bypass the wire schema.

## Production before and after

Three measured samples per scenario per block, with one configured warmup. Each cell below is
**before → after, milliseconds**. The small cohort is the repository fixture (71 packages / 4 maps),
medium is a user-selected project (10,128 / 59), and large is another (199,539 / 257).
Private project identities stay outside the committed report.

| Phase                      |         Small |            Medium |               Large |
| -------------------------- | ------------: | ----------------: | ------------------: |
| Fresh Catalog refresh      |   74.5 → 74.6 |   1,036.3 → 804.1 | 17,183.1 → 14,797.9 |
| Warm no-op refresh         |   54.4 → 53.5 |      214.0 → 96.7 |   4,687.9 → 2,258.3 |
| Queries after fresh build  |   38.2 → 37.8 |     271.2 → 184.4 |   1,918.7 → 1,503.4 |
| Queries after warm refresh |   35.4 → 35.0 |     241.1 → 178.8 |   1,864.3 → 1,449.8 |
| Input decode               |   28.2 → 30.5 |       65.6 → 61.9 |       172.2 → 175.1 |
| Complete fresh workload    | 143.9 → 146.4 | 1,525.4 → 1,080.5 | 19,390.8 → 16,581.5 |
| Complete warm workload     | 142.7 → 141.8 |     519.1 → 319.2 |   6,628.0 → 3,792.3 |

Fresh refresh excludes subsequent queries, folding, and input decoding. Input decode is absent
from the warm scenario. Independent phase medians do not sum to the median total; the total also
contains host orchestration and sampler shutdown. Native evidence-write time overlaps header and
commit phases and is not a pure parser timer.

## Actual SQLite comparison

All variants below use the improved discovery and transport paths. SQLite uses rusqlite 0.37.0,
bundled SQLite 3.50.2, JSONB evidence, a 64 MiB page cache, and `synchronous=FULL`. The indexed variant
indexes serialized names as well as classes; the hybrid indexes classes and scans serialized names.
Every changed physical snapshot rebuilds path-ordered IDs, including insertions, so that work is
included in refresh. Warm no-ops reuse the physical snapshot and do not open a staging database.
See [SQLite JSONB](https://www.sqlite.org/json1.html) and
[WITHOUT ROWID](https://www.sqlite.org/withoutrowid.html).

All times are milliseconds, medians of three samples. Query timings include the real client,
protocol, validation, hydration, and continuation pages, not only SQL execution.

| Cohort / phase          | Improved DuckDB | SQLite indexed names | SQLite scanned names |
| ----------------------- | --------------: | -------------------: | -------------------: |
| small / fresh refresh   |            74.6 |                 35.6 |                 34.8 |
| small / warm refresh    |            53.5 |                 18.3 |                 17.9 |
| small / warm queries    |            35.0 |                 19.2 |                 19.6 |
| small / complete fresh  |           146.4 |                142.7 |                146.0 |
| small / complete warm   |           141.8 |                142.4 |                139.6 |
| medium / fresh refresh  |           804.1 |                866.0 |                577.6 |
| medium / warm refresh   |            96.7 |                 77.7 |                 80.3 |
| medium / warm queries   |           178.8 |                112.1 |                145.8 |
| medium / complete fresh |         1,080.5 |              1,086.9 |                894.1 |
| medium / complete warm  |           319.2 |                308.4 |                312.8 |
| large / fresh refresh   |        14,797.9 |             17,411.6 |             11,255.9 |
| large / warm refresh    |         2,258.3 |              2,429.5 |              2,449.2 |
| large / warm queries    |         1,449.8 |                609.3 |              1,106.8 |
| large / complete fresh  |        16,581.5 |             18,404.3 |             12,682.8 |
| large / complete warm   |         3,792.3 |              3,117.4 |              3,650.3 |

Large-project parity compares every ordered item across all 18 pages, using SHA-256 digests of the
complete returned items. All three adapters match: 257 maps, 12,862 exact-class items, 135 prefix
items, 173 suffix items, and 2,009 serialized-name items. The showcase folds overlapping matches
into 14,927 headers and inspects 173 input candidates. Every measured warm refresh rebuilt zero
headers and committed zero evidence rows; all benchmark scenarios completed.

### One cached-signature mismatch and name-query tradeoffs

The research tool changes one timestamp only in its own marked disposable Catalog, then refreshes
from the unchanged large project. Each backend rebuilt exactly one package. This measures one
cache repair, not a source edit, and is a single observation rather than a distribution.
The first-page query observations use three fresh native processes per predicate, limit 1,024;
they exclude TypeScript but include startup/open, execution, hydration, and protocol output.

| Measurement                       | Improved DuckDB | SQLite indexed names | SQLite scanned names |
| --------------------------------- | --------------: | -------------------: | -------------------: |
| One mismatch: refresh elapsed, ms |         6,890.0 |             13,162.8 |              6,570.0 |
| TextProperty first page, ms       |            95.8 |                 16.4 |                290.3 |
| Absent-name first page, ms        |            76.4 |                  5.5 |                518.4 |
| None first page, ms               |            96.6 |                 14.2 |                 16.9 |

The hybrid is not universally faster: its absent-name scan is substantially slower than either
indexed alternative. Fully indexing names also roughly doubles this observed repair time relative
to DuckDB. The recommendation is workload-dependent, even though the actual showcase results favor
reconsidering SQLite. The JSON records returned item counts and continuation flags for these probes.

## Memory, storage, and executable size

Fresh-scenario medians below are **MiB**. Rust memory is a sampled whole-scenario peak; the small
fixture's workers exit too quickly for reliable observations. The JSON retains missing counts and
Node measurements; Node includes a reused headless runtime heap, not the full Workbench. Cache size
is end-of-scenario logical bytes, including SQLite free pages after staging is dropped, not peak
temporary disk use. Retaining a previous physical generation increases later cache size.

| Cohort / adapter        | Rust sampled peak |  Cache |
| ----------------------- | ----------------: | -----: |
| small / DuckDB          |       unavailable |   0.51 |
| small / SQLite indexed  |       unavailable |   0.24 |
| small / SQLite hybrid   |       unavailable |   0.24 |
| medium / DuckDB         |             69.67 |   7.51 |
| medium / SQLite indexed |            112.78 |  57.05 |
| medium / SQLite hybrid  |             90.43 |  57.05 |
| large / DuckDB          |            561.55 | 138.51 |
| large / SQLite indexed  |            272.96 | 915.96 |
| large / SQLite hybrid   |            253.38 | 915.96 |

The round baseline DuckDB executable is 40,707,584 bytes; indexed SQLite is 6,380,544 bytes.
This is a release executable comparison, not a measured clean CI build speedup. No Depot workflow
was changed and no clean cross-platform build distribution was collected.

## Uncertainty, decision, and evidence

OS caches were not flushed and engine order was not randomized. The first large final-transport
fresh workload took 170.64 seconds, including 164.39 seconds reading headers; its next two were
16.78 and 16.52 seconds total. This outlier is retained in the JSON. The confirmation blocks used
for the large tables are separate later runs. Broad before/after deltas are observed measurements,
not a causal confidence interval. Small input-decode fluctuations are not claimed as parser gains.

Keep the production discovery, worker-shutdown, and transport changes. The real workload now
justifies a production SQLite implementation review: the hybrid is the stronger general showcase
candidate, while complete name postings favor repeated selective-name queries. Memory and storage
do not disqualify either on these projects. DuckDB is no longer justified as an unquestioned speed
winner from the earlier synthetic selection.

The experimental adapter has shared coordinator/process coverage and actual-project parity, but
has not completed SQLite-specific corruption, concurrent-reader, abandoned-staging, full unsigned
numeric-boundary, release, or clean Depot validation. Its per-generation full rebase is deliberate;
larger insertion/deletion distributions remain to be measured. It is retained as reviewable source
instead of silently replacing the shipped Catalog based only on three-sample benchmarks.

Validation: the production IO gate passed after discovery; final Rust formatting, Clippy, 61 library
and 15 process tests passed after the queue fix. The transport change passed 21 focused tests,
package build, package test typecheck, and focused lint. Indexed SQLite passed 51 library tests and
hybrid passed 52; both passed 15 process tests. Final hybrid Clippy passed with warnings denied.
No full Depot run is claimed.

- [Machine-readable measurements and hashes](rust-core-speed-round2-2026-09-05.json).
- [Reproduction tools](../../tools/benchmarks/README.md).
- Local raw blocks, frozen executables, generated source, repair/parity evidence and logs:
  `test-results/rust-core-review-2026-09-05/speed-round2/`.
- Original [change ledger and baseline](rust-core-review-2026-09-05.md).
