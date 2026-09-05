# Canonical SQLite and incremental snapshots — 2026-09-05

SQLite now owns the production Project Index Catalog. DuckDB and Arrow have been removed from the
production dependency graph. The public library, CLI, protocol, and showcase scan remain shared.
The accepted decision and cache lifecycle are documented in
[ADR 0007](../decisions/0007-separate-uasset-inspection-and-io.md) and the
[SQLite engineering guide](../engineering/sqlite-project-index.md).

This pass then optimized the selected SQLite implementation. It retains faster fresh and warm
refreshes and substantially faster one-package repairs, with a measured large-project query
regression relative to the initial SQLite implementation. Speed remains the priority; memory and
storage are guardrails.

## Baselines and retained changes

The original repository baseline remains `bb36ee6324176e39edf7718624eb2e03dee468ce`. The
[previous pass](rust-core-speed-round2-2026-09-05.md) records the earlier Rust and DuckDB improvements.
This pass froze four executables before measuring:

| Build              | Meaning                                                                                                    | SHA-256                                                            |
| ------------------ | ---------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------ |
| DuckDB base        | Previous pass's final production build                                                                     | `c3dc4a9cffd6a27df0d967165956e283f8195e06970a6039933b02c830f12c04` |
| SQLite base        | Promoted hybrid prototype, lifecycle cleanup and full unsigned signatures; full copy/rebase on replacement | `3d99db7990c40649c396353baf5629858c2f1c677df8acf2c21085e62ef1df8e` |
| SQLite incremental | Direct final-table writes, immutable file copies, changed postings only, path-ordered queries              | `ca43dbe42593053c3dfd0e612e1015ae69bd246e328ff2e15855a9c7e9cfa178` |
| SQLite final       | Incremental implementation plus covering signature index and schema validation                             | `8547b8a48ec55ab10fddc2746b6599a770707e5e06733369c1d46f1b7c2d02cb` |

- Fresh writes go directly into the final entry table, avoiding a second payload copy and the
  resulting free-page high-water mark.
- Changed refreshes copy the immutable committed file into private staging and update only changed
  evidence/postings. Deleted paths remove their evidence and postings. Publication still follows
  one durable transaction, connection close, snapshot verification, and atomic manifest replacement.
- IDs remain stable across changes. Class queries explicitly order by relative path, preserving
  pagination when a new path sorts between existing paths or staging arrives out of order.
- A covering signature index prevents warm inventory comparisons from loading serialized names.
  On the large cohort, the intermediate build's warm refresh was 2,487.7 ms versus final 2,259.1 ms.
  The index added 24.4 MiB to that fresh cache.
- Class and reversed class-name postings remain enabled. Serialized names stay as JSONB arrays;
  full name postings remain rejected because of their fresh-scan cost in the previous pass.
- Rust `u64` signatures use eight-byte blobs; SQLite's signed integer range cannot truncate them.
  Discarded/failed staging closes its connection and removes unpublished database/journal files.
  Manifest validation rejects invalid summary metadata and snapshot verification checks the required
  evidence/postings schema as well as readability.

The old `catalogs-v2` caches are ignored. `catalogs-v3` rebuilds on first refresh; old caches are not
converted or automatically removed. There is no production backend selector.

## Separate speed measurements

Three measured samples per fresh and warm scenario, with one configured warmup. These run the
maintained showcase scan through the headless benchmark: native refresh, five bounded query routes,
TypeScript folding, and targeted Enhanced Input decode. Project files remain read-only.

Small is the generic repository fixture (71 packages); medium contains 10,128 packages; large
contains 199,539 packages. Private identities and paths are deliberately absent from these artifacts.
Values below are median milliseconds, initial SQLite → final SQLite. Query time comes from warm
scenarios; input decode runs in fresh scenarios only. Phases are measured separately and their
medians need not sum to the median complete scenario.

| Cohort | Fresh catalog       | Warm refresh      | Queries           | Input decode  |
| ------ | ------------------- | ----------------- | ----------------- | ------------- |
| Small  | 38.2 → 38.5         | 21.8 → 18.5       | 18.8 → 18.7       | 29.0 → 25.0   |
| Medium | 629.1 → 527.2       | 90.0 → 58.7       | 157.9 → 152.0     | 60.5 → 56.0   |
| Large  | 11,606.8 → 10,518.0 | 2,480.8 → 2,259.1 | 1,109.4 → 1,203.6 | 168.1 → 161.7 |

The medium fresh/warm improvements are 16.2%/34.8%; large fresh/warm improvements are 9.4%/8.9%.
Large queries regress 8.5% against the initial SQLite implementation. Input decoding was not changed
in this pass, so its observed differences are not attributed to a decoder optimization. Small
fresh/queries are effectively flat at this sample size.

| Complete scenario | Small            | Medium           | Large             |
| ----------------- | ---------------- | ---------------- | ----------------- |
| Fresh             | 145.5 → 146.8 ms | 944.0 → 844.5 ms | 12.985 → 12.020 s |
| Warm              | 142.6 → 139.5 ms | 337.1 → 304.1 ms | 3.670 → 3.559 s   |

The complete scenario also includes folding, orchestration, and resource sampling. Short fixture
scenarios are disproportionately affected by sampler/process overhead.

For historical context, the previous pass's final DuckDB large medians were 14.798 s fresh,
2.258 s warm refresh, and 1.450 s queries. Those are earlier blocks, not a contemporaneous randomized
comparison. This pass reran DuckDB for full output parity and repeated cache repair.

## Changed refresh and remaining query costs

Each repair changes one timestamp in a marked disposable cache, then refreshes from the unchanged
real project. All three runs per engine rebuild exactly one package, remove zero packages, and retain
199,539 packages. This models cache repair; it is not an authored project edit benchmark.

| Large cache repair                              | DuckDB base | SQLite base | SQLite final |
| ----------------------------------------------- | ----------- | ----------- | ------------ |
| Complete refresh, median                        | 7,843.7 ms  | 6,658.1 ms  | 2,488.8 ms   |
| Commit phase, median                            | 5,563 ms    | 4,297 ms    | 268 ms       |
| Cache after repair, including retained snapshot | 205.3 MiB   | 1,849.2 MiB | 946.5 MiB    |

Final SQLite repair is 62.6% faster than initial SQLite and 68.3% faster than this DuckDB repair
block. Full-file copying remains an O(cache size) cost; package enumeration also remains necessary.

Name scans remain the clearest query bottleneck. Nine first-page samples per predicate (three after
each repair), including native process startup, show the tradeoff:

| Serialized name probe | DuckDB   | SQLite base | SQLite final |
| --------------------- | -------- | ----------- | ------------ |
| `TextProperty`        | 102.9 ms | 294.1 ms    | 297.7 ms     |
| Absent name           | 83.7 ms  | 520.7 ms    | 528.8 ms     |
| `None`                | 103.7 ms | 25.1 ms     | 25.2 ms      |

These bounded first-page probes are separate from the complete showcase query phase. Further name
filtering must demonstrate a speed benefit without reinstating the fresh-scan cost of full postings.

## Memory, storage, and dependency footprint

Median sampled fresh-scenario resources. RSS is observed process memory, not a guaranteed OS peak;
missing short-lived Rust observations are not zeros. Node is the headless benchmark host, not the
full Workbench/renderer. Cache bytes include free pages and retained snapshots, not peak disk usage.

| Cohort | Rust RSS, MiB               | Node RSS, MiB | Fresh cache, MiB |
| ------ | --------------------------- | ------------- | ---------------- |
| Small  | not observed → not observed | 165.2 → 165.0 | 0.243 → 0.172    |
| Medium | 91.4 → 56.9                 | 225.6 → 231.2 | 57.2 → 33.7      |
| Large  | 252.5 → 273.4               | 330.4 → 333.6 | 924.6 → 473.2    |

The large cache shrank 48.8%; the roughly 21 MiB Rust increase is acceptable for the speed gains.
Retaining two physical snapshots after a changed refresh explains the roughly 946 MiB cache then.

The production Windows executable is 6,393,344 bytes versus DuckDB's 40,697,856 bytes (84.3% smaller).
The root lockfile contains 46 packages versus 179 before migration. Bundled SQLite still needs native
compilation. No hosted Depot or clean CI timing has been measured, so dependency reduction is not
presented as a measured CI time reduction.

## Validation and reproducibility

Production Rust validation passed: 64 IO library tests, 15 process tests, Clippy, formatting,
parser/inspection checks, WASM library/package checks, and native/WASM parity. New adapter regressions
cover full unsigned signatures, discarded and failed publication, missing-postings quarantine,
old-snapshot byte preservation, middle insertion, changed classes, deletion-only refresh, and
one-row continuation pages. The existing conformance suite also covers cancellation, stale
Generations, failure retries, sidecars, empty catalogs, and readers across publication.

All ordered results match across DuckDB base, SQLite base, and SQLite final on all three cohorts.
The large comparison covers 18 pages: 257 maps, 12,862 exact-class matches, 135 prefix matches,
173 suffix matches, and 2,009 serialized-name matches. SHA-256 digests include every hydrated item.

The historical adapter generator was updated to use frozen manifest helpers after the production
module rename. Its regenerated scan variant passed 52 library and 15 process tests. It remains a
research tool, not a selectable production backend.

The full local gate exposed an ignored Workbench debug script, a stale Data Authoring copy manifest,
and a redundant hard-coded IPC channel count. The scratch script was preserved under ignored
benchmark results. The adoption manifest now includes the already-imported analysis model/view and
the process-supervisor workspace member required to reuse the root lockfile with `--locked`. The IPC
test retains its exact comparison against all schema-owned channels instead of a second stale count.

All local gate components passed after targeted repairs and reruns: TypeScript builds/typechecks,
Effect/StyleX/ownership checks, license/release/packed-package checks, lint, formatting, contracts,
and Data Authoring adoption. The full Vitest run had 1,037 passing tests, 34 skipped, and the one stale
IPC count failure; the repaired IPC file then passed all 24 tests. The initial `pnpm check` command
did not pass uninterrupted; successful component reruns are retained alongside the original logs.
The copied foreign host built its locked SQLite reader and discovered/opened the 12 fixture tables.

[Machine-readable evidence](sqlite-canonical-2026-09-05.json) retains every sample, phase median,
query fingerprint, repair measurement, binary hash, and final Rust source hash. Local executable,
source, patch, and log captures live under the ignored
`test-results/rust-core-review-2026-09-05/sqlite-canonical/` directory. Benchmark tools and commands are
in [tools/benchmarks](../../tools/benchmarks/README.md).

These are serial exploratory blocks, not randomized experiments or confidence intervals. Fresh means
an absent application Catalog; OS caches are not flushed. The first large SQLite-base sample took
180.672 s end to end, including 166.155 s in header processing outside evidence writes, versus
12.862/12.985 s for the next two complete scenarios. The outlier is retained in the evidence. Repeat
on CI hardware and representative project changes before asserting wider performance guarantees.
