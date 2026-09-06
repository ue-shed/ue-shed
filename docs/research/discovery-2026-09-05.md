# Parallel project discovery — 2026-09-05

Project Index discovery now shares directories across a bounded set of workers. The final
implementation starts on the caller and creates workers only when queued work exceeds idle
capacity. This avoids the small-project startup regression found with an eager thread pool.
On this machine, large fresh refresh improves another 29% and warm refresh improves 67% relative
to the preceding header-pipeline pass.

## Baseline and measurement

This baseline includes the uncommitted [header-pipeline optimizations](header-pipeline-2026-09-05.md)
on top of commit `9d054f5b94c63d9838a36963b0c6c87f1183e40e`. It is not the original SQLite or binary
Catalog baseline. The frozen executable has SHA-256
`adf3853b4cec7688d90f6d3ee079dc8567dd48f60f6b9e84f7e7bace42082171`.
The measured final executable has SHA-256
`354ef146283554aaab81089559f70bb342cf06fbe3a1ef3189d55635213c77f5`.

The [JSON evidence](discovery-2026-09-05.json) retains executable sizes/hashes, source hashes,
raw samples, medians, rejected variants, and complete query/snapshot parity. Private projects were
read-only. Scratch artifacts and logs are under ignored `test-results/discovery-2026-09-05/`.
Committed evidence contains aggregate counts and hashes, not project identities or asset data.

Windows x64, Ryzen 9 7950X, 32 logical CPUs, 64 GiB RAM, Rust 1.94.0, Node 26.5.0. The maintained
Workbench project-index benchmark exercises the headless production flow. Small and medium use
three timed samples per state. Large uses six per variant, including a final reversed-order block.
Warm states have one untimed warmup per block. Timed blocks run serially without compilation.
Fresh means an empty Catalog; the OS filesystem cache is not flushed. Electron rendering and
hosted CI performance are not measured.

## Separate before/after results

Times are milliseconds; each cell is baseline → final. Queries are the warm five-route workload,
and input decode is the targeted Enhanced Input step during fresh runs.

| Cohort        | Packages |  Fresh catalog scan |      Warm refresh |         Queries |    Input decode |
| ------------- | -------: | ------------------: | ----------------: | --------------: | --------------: |
| Small fixture |       71 |       38.98 → 37.87 |     18.38 → 17.88 |   19.44 → 18.02 |   26.45 → 25.79 |
| Medium        |   10,128 |     301.59 → 254.70 |     67.93 → 41.83 | 113.60 → 107.42 |   62.76 → 55.20 |
| Large         |  199,539 | 5,667.94 → 4,042.22 | 2,338.28 → 774.04 | 623.89 → 665.16 | 175.11 → 179.00 |

The demonstrated gains are discovery and refresh. Query and decode code are unchanged; their
differences are observed variation, not attributed improvements. The large warm final samples range
from 734 to 1,190 ms, versus 2,263 to 2,407 ms before; the slower final samples remain in the median.
The fixture is effectively unchanged. Medium fresh/warm refresh improves approximately 16%/38%.

Complete fresh workload time, including queries, folding, and input decode, is 153.06 → 150.09 ms,
605.41 → 521.33 ms, and 6,643.51 → 5,064.59 ms. Complete warm workload time is 149.35 → 140.67 ms,
321.48 → 165.69 ms, and 3,056.95 → 1,514.74 ms. End-to-end timers also include startup and benchmark
resource-sampler completion, so subtracting stage medians does not reconstruct these totals.

| Cohort |         Cache MiB | Sampled native peak RSS MiB | Sampled Node peak RSS MiB |
| ------ | ----------------: | --------------------------: | ------------------------: |
| Small  |     0.071 → 0.071 |                Not captured |           158.72 → 158.07 |
| Medium |     8.230 → 8.230 |               28.17 → 75.91 |           235.34 → 199.00 |
| Large  | 130.997 → 130.997 |             402.49 → 399.11 |           335.01 → 317.01 |

Memory values are medians of sampled fresh-run peaks. Medium native memory rises materially but
remains below 79 MiB in the samples. The largest observed large-project native peak is 404 MiB
after versus 406 MiB before. The largest Node sample is 464 MiB after versus 352 MiB before,
despite its lower median. These are sampled working sets, not allocator accounting; the fixture's
native process is too brief for this sampler. Catalog storage is byte-for-byte unchanged.

## Experiments and retained design

| Large initial three-sample block | Fresh refresh ms | Warm refresh ms | Warm discovery ms |
| -------------------------------- | ---------------: | --------------: | ----------------: |
| Serial baseline                  |         5,639.65 |        2,376.23 |             2,071 |
| Eager eight workers              |         4,597.89 |          964.38 |               647 |
| Eager sixteen workers            |         4,343.51 |          777.81 |               465 |
| Eager thirty-two workers         |         3,864.13 |          726.33 |               414 |

Eager thirty-two-worker startup regressed fixture warm refresh from 18.38 to 29.91 ms. That variant
was rejected. The final version grows the pool as work arrives and restores fixture warm refresh
to 17.88 ms while retaining the large-project gain. Worker scaling explains discovery differences;
the fresh header phase also varies between blocks, so the entire fresh difference cannot be
attributed to changing the worker cap.

The maximum is 32 workers including the caller, capped by `available_parallelism`. There are at
most 1,024 queued directory paths. A full queue is traversed locally instead of blocking producers.
Signatures accumulate locally, merge after discovery, and sort by the existing relative-path order.
The walker retains the existing file extensions, directory-entry metadata reuse, symlink policy,
cancellation checkpoints, and whole-scan failure behavior. Header reading still uses its separate
eight-worker limit. No new dependency or persisted format was introduced.

## Query investigation

A Node CPU profile of the existing flow showed work in schema validation/Effect execution, garbage
collection, and header folding. This profile includes startup and refresh; it is not an isolated
query CPU benchmark. The warm large workload still transports approximately 24 MB over 18 pages.

The protocol schema includes string trimming, and domain page validation adds length bounds.
Consequently, repeated validation is not automatically interchangeable or removable. The existing
type-side fast path retains decoder fallback for normalization; its misleading comment was corrected.
No query behavior or wire format was changed in this pass. A compact page encoding or explicit
projection remains a candidate for a separately measured protocol change.

## Validation and Linux test correction

- `uasset:check:io` passes, including Clippy, native tests, process tests, and native/WASM fixture
  parity with typed failures and limits.
- Final Windows and Linux oracle runs each pass 94 library tests and 15 process tests. The ignored
  crash-child helper is exercised by the parent process-termination test.
- Discovery tests compare real nested package/sidecar trees against serial discovery with one,
  four, and thirty-two workers and queue capacities of one and four. They also cover cancellation,
  directory failure, and Unix directory symlink exclusion.
- All five ordered showcase query routes match on all three projects. Entire physical snapshot
  SHA-256 hashes also match, covering every indexed package.

The first parallel Linux oracle run failed one existing recovery test when reacquiring a writer
lock. The isolated test and serial suite passed. Inherited descriptors during concurrent process
tests are consistent with this failure: closing one descriptor does not release a lock while a
duplicate remains open. See the [Rust File locking contract](https://doc.rust-lang.org/std/fs/struct.File.html#method.lock)
and [Linux flock semantics](https://man7.org/linux/man-pages/man2/flock.2.html).

Tests that deliberately hand writer ownership over now unlock explicitly. The recovery regression
keeps a duplicated descriptor alive during that handoff, making the relevant condition deterministic.
Parallel Windows and Linux oracle suites then pass. This correction is confined to test code;
production Catalog locking is unchanged. The original failure and subsequent results remain in the
scratch logs. The full repository gate was not run for this focused IO change.
