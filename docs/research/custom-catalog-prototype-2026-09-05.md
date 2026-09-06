# Custom binary Catalog prototype

The custom adapter improves fresh builds and name queries enough to justify further investigation.
It also regresses warm refresh, single-package repair, and catalog opening. SQLite remains the
production backend. This experiment changes persistence and query execution only; the parser,
discovery, coordinator, protocol, and showcase scan pipeline are unchanged.

## Baseline and reproduction

Base: `6aee4380fa78753faae10679ae274717ebf13fd1`, the shipped canonical SQLite implementation.
Experiment branch: `perf/sqlite-next`. The generator selects the custom adapter in an isolated
workspace; no production backend flag or API change is introduced.

- [Raw measurements, medians, hashes, and parity results](custom-catalog-prototype-2026-09-05.json).
- [Prototype source](../../tools/benchmarks/custom-catalog.rs).
- [Build and measurement instructions](../../tools/benchmarks/README.md#custom-binary-catalog-prototype).
- [Previous production measurements](sqlite-canonical-2026-09-05.md).

Frozen release readers: SQLite 6,393,344 bytes, custom 4,772,864 bytes. Their SHA-256 hashes and
prototype source hashes are in the JSON. The custom reader has no database engine in its normal
Cargo dependency tree; SQLite is retained as a test-only oracle. This removes the database engine
dependency, not the other existing Rust dependencies.

Measurements use Windows, Ryzen 9 7950X, 32 logical CPUs, approximately 63 GiB RAM, Node 26.5.0,
and Rust 1.94.0. Each showcase block has three measured runs and one harness warmup. Runs are
serial blocks, not randomized trials. Fresh means an empty catalog; the OS filesystem cache is
not flushed. Project inputs remain read-only. Caches, executables, and logs live under ignored
`test-results/custom-catalog-2026-09-05/`.

The three cohorts are the repository fixture (small: 71 packages, 4 maps), a medium project
(10,128 packages, 59 maps), and a large project (199,539 packages, 257 maps). Private project
identities, paths, and asset records are deliberately absent from these artifacts.

## Separate speed measurements

All entries are median milliseconds, **SQLite → custom**. The query phase is the complete bounded
showcase candidate workload after a warm refresh, including protocol transfer. It is not pure
engine time. Input decode is targeted Enhanced Input decode in the fresh showcase run. A warm
no-op reuses that decoded input state.

| Cohort |   Fresh catalog scan |        Warm refresh |       Query phase |    Input decode |
| ------ | -------------------: | ------------------: | ----------------: | --------------: |
| Small  |        57.43 → 56.32 |       25.43 → 20.04 |     22.23 → 20.11 |   34.15 → 29.88 |
| Medium |      597.41 → 398.45 |       68.05 → 73.72 |   185.62 → 127.47 |   83.99 → 67.26 |
| Large  | 13,896.07 → 9,854.16 | 2,297.26 → 2,473.98 | 1,253.34 → 733.43 | 195.69 → 206.94 |

Fresh scan improves about 33% on medium and 29% on the initial large comparison. A later SQLite
confirmation block measured a 12,896.17 ms fresh median, 2,310.93 ms warm refresh, and 1,289.18 ms
warm query phase. Against that lower fresh baseline, custom improves 24%. Thus **24–29%** is the
observed large fresh-scan improvement, not a guaranteed speedup. Historical production numbers
were lower again; compare contemporaneous blocks and retain variance rather than substituting an
old timing. Small timings are dominated by startup noise and do not establish a reliable gain.

Warm refresh regresses about 8% on medium and large. The custom refresh opener checksums the full
snapshot and reconstructs metadata; SQLite does not perform an equivalent full-file checksum on
every warm refresh. This is an integrity-policy difference as well as an implementation cost.

Input decode was not modified or independently optimized. Its mixed timing movement is not a
parser speedup claim. The instrumented header phase includes catalog staging: a reduction there
does not imply faster package parsing. For large fresh builds, median evidence-write time falls
from 5,415 to 2,339 ms and commit from 2,730 to 883 ms. Evidence-write time overlaps staging and
commit, so these counters must not be added together.

For the overall showcase operation, including refresh, queries, folding, input work, and overhead:

| Cohort |       Fresh total, ms |      Warm total, ms | Fresh query phase, ms |
| ------ | --------------------: | ------------------: | --------------------: |
| Small  |       190.12 → 182.20 |     168.93 → 163.94 |         37.08 → 25.16 |
| Medium |     1,035.08 → 726.78 |     337.34 → 344.85 |       200.86 → 152.29 |
| Large  | 15,532.89 → 10,872.09 | 3,656.85 → 3,344.00 |     1,326.75 → 799.97 |

Independent phase medians do not sum to the median total. Medium warm total is slightly worse
despite faster queries; the raw samples retain that result.

## Opening versus reused queries

The separate process-session probe opens one catalog per engine, then runs five samples for each
name with a 1,024-result limit. Every returned page has an identical SHA-256 digest across engines.
These timings include protocol serialization, pipes, and Python JSON decoding; they exclude the
digest calculation and are not pure database microbenchmarks.

| Large-project measurement                                   | SQLite, ms | Custom, ms |
| ----------------------------------------------------------- | ---------: | ---------: |
| Process launch and initial one-map query, one sample        |      22.60 |     102.97 |
| `TextProperty`, 1,024 results and continuation, median      |     268.32 |       9.13 |
| Absent name, median                                         |     495.43 |      0.043 |
| `None`, common name, 1,024 results and continuation, median |      11.10 |      11.96 |

The custom file has a full name index; production SQLite scans JSONB names. This is partly a data
layout comparison, not proof that SQL itself is the bottleneck. The custom format shares strings
and packs posting lists cheaply enough to include that index. Reused rare/absent lookups benefit
greatly, while a common name already lets SQLite stop early.

With a separate process for every query, nine samples per predicate across the repair runs give
SQLite → custom medians of 303.83 → 124.30 ms for `TextProperty`, 532.97 → 114.62 ms for absent
names, and **27.62 → 125.45 ms** for `None`. Opening cost materially changes the result.

## Changed refresh and resources

Three large-project repair runs each decrement one successful package's cached timestamp, refresh
the unchanged project, and assert exactly one rebuilt package with no removal. Only marked
disposable cache metadata is changed. This models cache repair, not an authored project edit.

| Repair measurement     |      SQLite |      Custom |
| ---------------------- | ----------: | ----------: |
| Median total           | 2,575.32 ms | 3,488.65 ms |
| Median commit          |      247 ms |    1,219 ms |
| Retained cache storage |  946.48 MiB |  262.00 MiB |

Custom repair is **35% slower**. It rewrites all 199,539 retained records and reconstructs postings;
SQLite uses its optimized incremental snapshot path. Functional mutation tests pass, but timed
insert/delete/rename workloads are still missing.

Resource values below are median fresh-run observations, SQLite → custom. Rust RSS is sampled,
not a guaranteed peak or allocator accounting. Short processes can escape the sampling interval;
missing observations are shown explicitly. Node and Rust samples need not peak simultaneously.

| Cohort | Fresh cache, MiB | Sampled Rust RSS, MiB | Sampled Node RSS, MiB |
| ------ | ---------------: | --------------------: | --------------------: |
| Small  |    0.172 → 0.071 |          Not captured |       147.82 → 147.27 |
| Medium |     33.69 → 8.23 |         56.00 → 36.67 |       217.78 → 234.07 |
| Large  |  473.24 → 131.00 |       284.75 → 399.59 |       337.31 → 313.69 |

The large cache is about 72% smaller, with approximately 115 MiB more sampled Rust memory during
the build. Large warm Rust RSS is 135.20 → 211.30 MiB. Those costs look reasonable for this
experiment's speed priority, but the build is memory-resident and larger projects need measurement.
Repair storage includes retained immutable generations; it is not the size of a single snapshot.

## Implementation and correctness evidence

The prototype implements the existing `Catalog` and `CatalogSnapshot` interfaces. Its versioned
binary file contains five sections: compact inventory, shared string dictionary and lexicon,
posting directory, posting lists, and packed header records. Exact names and classes use postings;
prefix/suffix predicates inspect class strings. Per-snapshot row IDs follow path order. A query
loads metadata once per session and hydrates selected records with bounded pagination.

The writer syncs and reopens/verifies a new immutable file before atomic manifest publication.
No-op refresh reuses the physical snapshot. Old readers retain their original file. Each section
has a length and checksum; selected records and posting lists also have checksums. The decoder
checks counts, bounds, UTF-8, booleans, IDs, and ordering. Checksums are non-cryptographic FNV-1a.

Validation completed:

- **82 library tests and 15 process tests pass** in the isolated custom workspace, including the
  existing SQLite suite, custom adapter conformance, and the shared process pipeline using custom.
- A deterministic 12-generation SQLite-oracle sequence compares status, compact inventory, and
  every hydrated query page. It covers up to 96 paths, 40 operations per generation, inserts,
  deletes, changed evidence, failed headers, sidecars, Unicode, duplicates, reverse discovery,
  11 query specifications, and page sizes 1, 7, and 1,024.
- Additional cases exercise full unsigned signatures, truncation and byte corruption, forged
  impossible counts with valid checksums, failed publication cleanup, empty snapshots, warm
  physical-file reuse, and old-reader preservation.
- Complete ordered results match SQLite for all five showcase query routes on all three cohorts.
  Large parity covers 18 pages: 257 maps, 12,862 exact-class matches, 135 prefix matches, 173 suffix
  matches, and 2,009 serialized-name matches. Counts and hashes are retained in the JSON.
- Targeted Clippy passes with `-D warnings`; release build succeeds. Normal Cargo dependencies
  contain no SQLite, DuckDB, or Turso. Python tooling is syntax-checked and exercised by the runs.

This is not a production persistence contract. Each section has a 512 MiB prototype cap; builds
retain staging/indexes in memory; changed snapshots rewrite everything; and unused dictionary
strings survive until a full rebuild. There is no crash/power-loss soak, cross-platform file
lifecycle validation, or new proof of writer exclusion across independent clients. The tests
establish useful parity with SQLite, not equivalence to SQLite's durability history.

The next catalog work should target incremental snapshot construction and cheaper opening while
retaining the current integrity checks. Those are the measured regressions. The prototype does
not establish that removing SQLite is automatically faster for every workload.
