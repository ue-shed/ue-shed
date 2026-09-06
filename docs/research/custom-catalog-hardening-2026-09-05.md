# Binary Catalog hardening and production selection

The binary Catalog is now selected by the native factory on `perf/sqlite-next`. It improves fresh
scans, indexed queries, cache size, and distributable size. Warm refresh is close to SQLite;
single-package repair and short-lived opens retain measured regressions. SQLite remains an explicit
test oracle, outside default builds and tests. The parser and input decoder were not changed.

## Baselines and artifacts

The base is `6aee4380fa78753faae10679ae274717ebf13fd1`, the canonical SQLite commit. The
[first prototype report](custom-catalog-prototype-2026-09-05.md) remains the earlier record.
[This report's JSON](custom-catalog-hardening-2026-09-05.json) retains all new sample blocks, medians,
ordered-result hashes, binary/source fingerprints, repair probes, and artifact results.

Three variants are distinguished: the first prototype, the second research prototype, and the final
production adapter. Early hardening measurements used the second prototype; the main tables below
use the **final production release binary**, including subsequent recovery fixes. Scratch caches,
executables, source copies, and logs remain under ignored
`test-results/custom-catalog-hardening-2026-09-05/`.

| Windows executable |     Bytes | SHA-256                                                            |
| ------------------ | --------: | ------------------------------------------------------------------ |
| SQLite base        | 6,393,344 | `8547b8a48ec55ab10fddc2746b6599a770707e5e06733369c1d46f1b7c2d02cb` |
| First prototype    | 4,772,864 | `2326ebe8c5b18948ebd618364cdaeef858db00a95baa1dd9223d9e0b83302260` |
| Second prototype   | 4,805,632 | `525b444de83e7227642d97838c67295fe1d331f600bf8df0efe0fba1d7370d3c` |
| Production binary  | 4,811,264 | `32acb89498041b3f952f822a4fe82f348472abcffe8d69d817d713c6cd755597` |

The current [engineering guide](../engineering/binary-project-index.md) describes the storage
contract; [benchmark instructions](../../tools/benchmarks/README.md) describe reproduction. Private
project identities, filesystem roots, and asset records are excluded from committed evidence.

## Speed, split by phase

Measurements use the same Windows/Ryzen 9 7950X host, Node 26.5.0, and Rust 1.94.0 as the prototype.
Each showcase block has three measured samples and one harness warmup. Blocks run serially, without
flushing the OS filesystem cache. Fresh means an empty Catalog, not cold disk pages. Project inputs
remain read-only. Small is the fixture (71 packages, 4 maps), medium has 10,128 packages and 59 maps,
and large has 199,539 packages and 257 maps.

Entries are median milliseconds, **SQLite → final binary**. Queries mean the complete bounded
showcase candidate workload after warm refresh, including protocol transfer. Input decode is the
targeted Enhanced Input phase in a fresh run; warm no-op reuses decoded input state.

| Cohort |    Fresh catalog scan |        Warm refresh |       Query phase |    Input decode |
| ------ | --------------------: | ------------------: | ----------------: | --------------: |
| Small  |         36.40 → 45.61 |       18.98 → 19.17 |     20.52 → 18.95 |   27.58 → 28.16 |
| Medium |       683.18 → 352.86 |       63.69 → 68.33 |   179.98 → 120.50 |   90.72 → 56.87 |
| Large  | 13,296.70 → 10,156.64 | 2,308.98 → 2,345.61 | 1,269.62 → 712.97 | 193.82 → 191.66 |

Medium fresh scans improve about 48%, and large fresh scans about 24% against the initial block.
A later SQLite confirmation measured 14,648.22 ms fresh, 2,280.74 ms warm, and 1,303.66 ms queries.
Against that block the large fresh improvement is 31%. The observed range is therefore **24–31%**.
Large query time improves about 44%; warm refresh is approximately 2% slower against the initial
block, or 3% against confirmation. Medium warm refresh regresses about 7%.

Small fresh scans regress by about 9 ms in this block. Startup noise is material at this size;
neither the earlier fixture gain nor this regression establishes a stable percentage advantage.
Input decode has no implementation change and its variation is not a decoder optimization claim.

The initial large SQLite block contains one 185.09 s end-to-end fresh sample, with 183.42 s in
refresh and most of that in the header-processing phase. It is retained, not discarded. The other
fresh samples were approximately 13.2–13.3 s. Comparisons use medians and the separate confirmation
block; the extreme sample is not used to claim a speedup.

The second research prototype earlier measured 8.68 s fresh on large. Final production measured
10.16 s later, while the SQLite baseline also became slower. Commit medians were nearly unchanged
(645 versus 660 ms); the reading phase varied substantially. The report does not substitute the
faster prototype timing for the final binary or attribute this whole difference to hardening.

| Cohort | Complete fresh operation, ms | Complete warm operation, ms | Fresh query phase, ms |
| ------ | ---------------------------: | --------------------------: | --------------------: |
| Small  |              145.65 → 155.96 |             145.44 → 151.47 |         25.79 → 24.51 |
| Medium |            1,111.06 → 580.87 |             344.30 → 321.31 |       253.03 → 117.18 |
| Large  |        14,931.19 → 11,229.30 |         3,681.70 → 3,169.41 |     1,336.76 → 770.53 |

Totals include folding and orchestration overhead. Independent phase medians do not sum to the
median total. The JSON retains folding and native phase counters separately.

## Repair and opening

Repair changes one successful package's cached timestamp, then refreshes the unchanged large
project. Three samples assert exactly one rebuilt package and no removal. This is cache repair,
not a timed authored insert/delete/rename or evidence-content change. Functional differential tests
cover those mutations, but their full-project timing remains future work.

| Repair measurement  |   SQLite | First prototype, previous session | Final binary |
| ------------------- | -------: | --------------------------------: | -----------: |
| Median total, ms    | 2,537.43 |                          3,488.65 |     2,783.73 |
| Median commit, ms   |      262 |                             1,219 |          538 |
| Retained cache, MiB |   946.48 |                            262.00 |       262.00 |

Bulk reuse cuts the prototype's commit cost by about 56% and repair total by about 20%. The final
repair still costs about 10% more than the current SQLite baseline. It writes a complete new file;
it does not provide SQLite-style page updates. Storage includes retained physical generations.

Repeated name probes use one open process per engine, five requests per predicate, and a 1,024
result limit. Every returned page hash matches. Timings include pipes, protocol serialization, and
Python JSON decoding, excluding digest calculation; they are not pure engine microbenchmarks.

| Large-project measurement                                   | SQLite, ms | Final binary, ms |
| ----------------------------------------------------------- | ---------: | ---------------: |
| Process launch and initial one-map query, one sample        |      16.78 |            70.24 |
| `TextProperty`, 1,024 results and continuation, median      |     285.19 |            12.91 |
| Absent name, median                                         |     521.84 |            0.049 |
| `None`, common name, 1,024 results and continuation, median |      11.62 |            11.74 |

The first prototype's setup was 102.97 ms; the final opener is cheaper but still slower than
SQLite. A separate process per query, over nine samples per predicate, gives SQLite → binary
medians of 303.15 → 96.76 ms for `TextProperty`, 540.77 → 88.65 ms for absent names, and
**26.70 → 98.72 ms** for `None`. Full metadata loading remains a cost for short-lived readers.

The binary format includes a full name index; production SQLite scanned JSONB names. This is a
layout and indexing improvement, not proof that SQL inherently causes the difference.

## Memory, storage, and publication artifacts

Values are median fresh-run observations, SQLite → final binary. RSS is sampled, not allocator
accounting or a guaranteed peak. Short Rust processes escaped sampling on the fixture. Node and
Rust observations are separate and need not peak simultaneously.

| Cohort | Fresh cache, MiB | Sampled Rust RSS, MiB | Sampled Node RSS, MiB |
| ------ | ---------------: | --------------------: | --------------------: |
| Small  |    0.172 → 0.071 |          Not captured |       147.82 → 147.65 |
| Medium |     33.69 → 8.23 |         56.49 → 25.80 |       242.22 → 199.27 |
| Large  |  473.24 → 131.00 |       272.33 → 387.41 |       331.13 → 335.30 |

Large cache size falls about 72%, with about 115 MiB more sampled Rust build memory. Old namespaces
are retained during migration, so an existing installation can temporarily retain both its old
SQLite cache and the new binary cache. These fresh sizes measure each backend independently.

The packed Windows native npm archive falls from **2,598,798 to 1,715,624 bytes**, about 34% smaller.
The executable is about 25% smaller. The same artifact verifier assembled both readers using the
maintained script, packed copied packages, installed them into disposable consumers offline with
lifecycle scripts disabled, and ran version, fresh/warm fixture refresh, and map queries with an
empty PATH. No package was published. Linux release execution and fixture query parity also pass;
its executable and tarball fingerprints are retained in the JSON.

## Changes and validation

The [production adapter](../../crates/uasset-io/src/direct_executor/catalog_binary.rs) adds:

- Bulk copying of unchanged packed records, with remapping of retained posting IDs and updates to
  affected memberships. There is no per-retained-header file read, decode, or re-interning.
- Pinned [Rust CRC32 checksumming](https://docs.rs/crc32fast/1.5.0/crc32fast/) instead of serial
  bytewise FNV for snapshot integrity. Full refresh verification remains enabled.
- Standard OS writer exclusion, including across clear/quarantine and process termination.
- Readers that pin their physical file before their first query, plus Windows quarantine recovery
  when directory renaming is prevented by open handles.
- A 1 MiB manifest bound, summary/inventory consistency checks, and distinction between truncated
  reads and unavailable filesystem operations.
- Cleanup ownership only after exclusive creation succeeds. Ambiguous manifest-publication errors
  preserve the candidate and require reopening, since rename may precede a returned sync error.
- Default builds/tests with no database engine, an explicit `catalog-oracle` feature, a separate
  conditional Depot oracle job, and a dependency-tree architecture check. SQLite remains pinned
  and licensed in the lockfile for that oracle.

Validation evidence:

- Windows: **91 library and 15 process tests pass** with the oracle enabled; Clippy passes with
  `-D warnings`. One ignored child entrypoint is deliberately invoked by the parent crash test.
- Linux/WSL: **90 library and 15 process tests pass**, including the final recovery fixes. The
  difference is the existing Windows-specific test. Release build and standalone execution pass.
- Process termination is exercised at six publication points for both absent and existing
  catalogs. Injected write/sync failures, post-publication uncertainty, filename collision,
  corruption, old-reader retention, and writer exclusion are covered.
- Complete ordered results match SQLite across all five showcase routes and all three projects.
  The large cohort covers 18 pages. Linux and Windows fixture results also match exactly.
- Rust 1.89 `cargo check --all-targets --features catalog-oracle` passes on Linux, with an existing
  unused-variable warning in inspection. The normal 1.94 Clippy check passes without warnings.
- `pnpm check` passes, including 1,038 repository tests with 34 explicit integration skips. The
  last two recovery fixes were additionally checked with the final Rust suites, Clippy, release
  builds, and packed artifacts after the full gate run.
- Python tools are syntax-checked and exercised; all three historical experiment generators still
  produce workspaces that pass `cargo check --all-targets` after the production backend switch.

The published native npm platform remains Windows x64. macOS execution was not available, and no
macOS package support is added. Linux evidence is local WSL execution, not a hosted Depot run. The
new CI job is configured and locally covered, but hosted timings and results require pushing this
branch. Database compilation is removed from the default path; the separate oracle still compiles
SQLite. No hosted build-time reduction is claimed.

This remains a deliberately bounded derived cache: 512 MiB per section, memory-resident staging,
complete physical rewrites on changes, and dictionary compaction only on rebuild. Process-kill and
injected IO tests are not machine power-loss tests or a long-duration soak. Those limitations and
the opening/repair regressions are retained as follow-up work rather than hidden by the scan gains.
