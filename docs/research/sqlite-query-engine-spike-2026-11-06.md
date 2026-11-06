# SQLite query-engine spike — 2026-11-06

SQLite is a credible architectural candidate. This experiment also found avoidable work in both
the current Rust projection and the first SQL aggregates. Neither the original large SQLite wins
nor the original aggregate losses should be treated as intrinsic engine limits.

The implementation and evidence are isolated on `research/sqlite-query-engine`, based on
`3d7e0ba2` (0.25.0). Production source and backend selection are unchanged. A diagnostic Rust
projection build was made from a retained patch, then the source and default executable were
restored. This is not migration acceptance or a decision to replace either index.

- [Consolidated samples, hashes, versions, plans and resource observations](sqlite-query-engine-spike-2026-11-06.json).
- [Visual comparison](sqlite-query-engine-spike-2026-11-06.html).
- [Experimental implementation and reproduction](../../tools/benchmarks/sqlite-query/README.md).
- [Execution plan](../../plans/archive/064-sqlite-query-engine-spike.md).

## Method and scope

The existing seed-57 retained-record producer and production native join prepare three generated
cohorts: 584, 5,835 and 58,351 visible lines, each with ten cultures. An additional 13-line planted
control contains nonempty Unicode matches, duplicate sources, null/empty translation distinctions,
UTF-16 lengths, NUL, lone surrogates and real reserved Unicode scalars.

SQLite receives a selected projection of the same already-joined facts: identity, source, audience,
culture/state/translation, and basic place fields. These use a normalized dictionary, lines, cultures,
marks and places. The dictionary retains original UTF-16 big-endian bytes for lossless reads,
length and ordinal ordering. Indexed classes of values remain relational; no full-row JSON blobs
are used as query storage. FTS5 supplies candidates, followed by a substring check.

The four paths are the current Rust engine, SQLite through the production TypeScript session and
Rust frame/column encoder, direct Node SQLite, and direct Bun SQLite. The SQLite process server is
an experimental **serial** adapter, not the production engine scheduler. It does not implement
production concurrency, cancellation, recovery or typed query failures.

Windows, Ryzen 9 5950X, 32 logical processors, approximately 64 GiB RAM. Node 26.13.0, Bun 1.4.4,
Rust 1.98.1. SQLite versions are Node 3.54.0, Bun 3.53.4, Rust 3.50.2, Python 3.42.0; compile options
are retained. The default older nightly failed to build the current reader; all reported runs use
the explicitly selected successful toolchain.

Three independently opened processes per path rotate lane order. Each operation has seven measured
repetitions at the two smaller scales and three at 58,351 lines, following a warmup. Case order
rotates inside the process. The Rust projection control repeats the medium experiment with three
repetitions; the SQL count control uses seven. Hashing runs after the operation timer. Every measured
answer matches an independent JavaScript oracle over the retained facts. OS caches are not flushed.
Setup counters cover driver/session/index readiness, not cold application startup or the first-page
warmup. Cold first-page and complete build comparisons remain future work.

Queries cover projected exports, common/absent/Unicode substring searches, namespace, audience and
culture filters, first pages of 1/50/5,000, and namespace/culture-state counts. SQL-only examples cover
grouped duplicate sources, UTF-16 source length, empty translations and a new length-distribution
report. These examples do not implement the full authored-rule evaluator or finding identities.

The long term `taluma` matches every source in the generated cohorts. It is a deliberately broad
search, not a selective indexed hit. Unicode controls establish nonempty semantic matches at small
scale; the main cohorts' non-ASCII probes are absent matches. Selective positive FTS searches,
continuation pages, complete detail reads and every facet's filter-omission semantics remain gaps.

## Current API costs

Median milliseconds at 58,351 lines. A is the original four-path campaign; B is a separate full
campaign with the diagnostic Rust projection. Independent operation medians are not additive.

| Operation                          | Rust current, A | Rust projection control, B | SQLite pipe, A | Node SQLite, A | Bun SQLite, A |
| ---------------------------------- | --------------: | -------------------------: | -------------: | -------------: | ------------: |
| All projected lines                |        1,875.25 |                     227.65 |         407.96 |         207.80 |        156.98 |
| First 50 lines                     |            9.12 |                       9.43 |           0.90 |           0.41 |          0.37 |
| First 5,000 lines                  |          830.06 |                     827.10 |          54.36 |          28.30 |         26.51 |
| Namespace counts, original SQL     |            7.79 |                       6.97 |          18.06 |          15.80 |         17.27 |
| Culture/state counts, original SQL |           32.83 |                      34.28 |          65.55 |          59.16 |         65.88 |

The projected export has identical ordered values and uses the same column encoder, fields and
emitted batch byte count for both process-backed stores. Its initial difference is not caused
solely by the transport. However, the native implementation was constructing unrequested data.

For **pages**, Rust constructs a much richer preview before the harness selects identity and source.
SQLite selects those fields directly. These are actual API costs, not equal-width transport or
pure database timings. The page numbers cannot establish a corresponding speedup for a complete
Workbench view with all culture/provenance fields.

The direct Node and Bun calls are synchronous during SQL execution and row construction. Callback
gaps, including an operation that finishes before its first timer fires, are retained. Direct access
removes the process boundary but does not provide automatic host responsiveness for larger queries.
No Electron renderer, browser interaction or worker-thread SQLite host was measured.

## Rust projection control

[`localization_line_fields`](../../crates/game-text-index/src/engine_rollup.rs) unconditionally calls
`preview(row)` before selecting requested fields. That preview includes every culture's mark,
manifest locations, origin and other presentation data, even for an identity/source-only export.

The retained [diagnostic patch](../../tools/benchmarks/sqlite-query/rust-projection.patch) directly
reads those two fields and the identity's slice condition. It changes no parser, stored format,
filter, frame encoding or query contract. It reduces the medium export by about **8.2×**, from
1,875 to 228 ms. The page path is untouched and remains effectively unchanged. On the repeat
campaign, Node/Bun exports are 207/153 ms and SQLite pipe is 435 ms.

The control matches every measured projected result and nine additional seeded join cases:
138 projected lines, 57 containing non-ASCII text and 32 with null identity. The independent join
oracle also passes. The separate SQLite controls exercise lone surrogates; those nine native
projection cases do not include a visible lone-surrogate source.

This is a diagnostic build, not a production-ready fix. Unused-column corruption behavior, all
field selections and the complete release/engine gate were not assessed for the patch. Its source
is retained as a patch and its executable hash is recorded; it is not applied to production source.

## SQL aggregate control

The original SQL joins labels before grouping every row. A second control groups indexed IDs
first and joins labels only for the resulting groups. It uses the identical copied database,
the same result oracle and no additional index or stored aggregate.

| Counts        | Rust current, A | Node original, A | Node preaggregate | Bun preaggregate | SQLite pipe preaggregate |
| ------------- | --------------: | ---------------: | ----------------: | ---------------: | -----------------------: |
| Namespace     |            7.79 |            15.80 |              3.32 |             3.53 |                     4.66 |
| Culture/state |           32.83 |            59.16 |             35.12 |            41.63 |                    41.12 |

Namespace counts improve roughly 4.8× on Node and become faster than the native baseline.
Culture/state counts become close to the current Rust result. The actual SQL and query plans are
retained in the evidence. These are separate serial campaigns, not randomized paired trials or
confidence intervals.

The first SQL formulation was therefore not sufficient evidence that SQLite fundamentally loses
these aggregations. Likewise, fixing Rust projection work substantially changes the row comparison.

## Boundary and Bun

The medium campaign's warmed `SELECT 1` control is approximately **0.33 ms through the SQLite process
adapter versus 0.05 ms directly from Node or Bun**. The Rust profile attributes only a small part to
SQL/row extraction and output encoding; request handling, process delivery and the host also matter.

For a 50-line projection the SQLite pipe is approximately 0.90 ms versus 0.41/0.37 ms on Node/Bun.
For the complete projected export the process adapter is 408 ms versus 208/157 ms. These comparisons
include different SQLite builds and binding/result-construction implementations: subtracting them
does **not** isolate pure IPC cost or Bun's intrinsic binding overhead. The scalar test is part of
the mixed workload and harness, not a bare native-call microbenchmark.

Bun improves the bulk projection here, but does not consistently win the aggregate workloads. We
cannot turn Bun's vendor benchmarks or these measurements into one multiplier for the application.
Changing the database and eliminating the process boundary remain separate architectural choices.

## Construction, storage, lifecycle and independent use

| Generated cohort | Visible lines | SQLite projection construction, one observation | SQLite projection file |
| ---------------- | ------------: | ----------------------------------------------: | ---------------------: |
| 0.001×           |           584 |                                         0.133 s |        2,387,968 bytes |
| 0.01×            |         5,835 |                                         0.703 s |       23,293,952 bytes |
| 0.1×             |        58,351 |                                         8.301 s |      238,993,408 bytes |

Construction includes normalized inserts, indexes, FTS rebuild, analysis and durable transaction
commit, after input decoding. The database contains fewer kinds of provenance than the native store.
These sizes/times are **not** an equivalent complete-index comparison. Native generation, join and
projection-export diagnostics are separate and cannot be substituted for a complete SQLite build
from extracted Unreal evidence. The full 1× workload and a real project were not measured.

On a disposable copy of the medium database, normalized line/culture edits, insertion, deletion,
rollback, a pinned WAL reader across a commit and killing an acknowledged uncommitted writer pass.
Integrity checks pass after termination. The first normalized source/culture edit took one observed
486 ms; that is not a distribution, a package rescan, a native comparison or a power-loss guarantee.

Python 3.42.0's stock SQLite reads the first 50 projected lines and produces a new length-distribution
report with exactly matching hashes, without UE Shed libraries, a Rust operation or SQLite
extensions. It decodes the original UTF-16 bytes directly. Node, Bun and the SQLite process adapter
also match every planted semantic control. SQLite's file portability is useful; domain schema,
Unicode conventions and policy semantics still belong to us.

Working-set evidence is sampled over each worker and its native descendants, including setup,
warmup and verification hashing; it is not an exact peak or query-only allocator measurement.
Short-lived samples report null when not captured. The complete native store and SQLite projection
also differ in retained evidence, so their process memory is not equivalent full-store capacity.

## What this supports

Keep SQLite under serious consideration for compatibility, query expressiveness and the amount of
bespoke infrastructure we maintain. Standard SQL expressed an independent report and materially
improved counts without a new Rust operation or data-format change.

Do not migrate on the initial row ratios. The strongest apparent Rust disadvantage was mostly
avoidable preview construction. A reasonable SQL rewrite also removed much of its apparent count
disadvantage. Our current APIs, representations and query plans matter at least as much as the
backend name.

The next migration decision needs a full-fidelity SQLite pilot from the same extracted inputs:
all provenance and translation stages, exact authored-rule/evidence semantics, incremental joins
and findings, versioned read views, pinned generations, host responsiveness and packaging. If
those fit the product budgets, SQLite can win on maintainability without winning every microbenchmark.
Project Index needs its own current comparison; Game Text does not decide it by implication.

## Verification and provenance

- Focused TypeScript typecheck, lint and formatting; three independent SQL correctness tests.
- Native SQL request-generation drift test, Rust formatting, Clippy with warnings denied and release
  builds. The retained projection diagnostic additionally has measured parity and the nine seeded
  native/independent join comparisons; it is not included as a shipping change.
- All measured ordered-result hashes/counts match the independent retained-fact oracle. All
  three SQLite paths also pass the planted controls and independent Python read/report.
- The six campaigns retain 8,637 timed operations; the nine projection cases add 138 independently
  checked projected lines. No failed timed sample or outlier was removed from those campaigns.
- SQLite structural lifecycle and post-termination integrity checks pass.
- Full `pnpm check`, hosted CI, real-app screenshots, Node 24, and UE 5.7/5.8 conformance were not run
  for this isolated retained-fact experiment. No parser, codegen, Unreal asset fixture, C++ plugin,
  maintained host or production contract changed.

Original local run files remain under ignored `test-results/sqlite-spike/`. Consolidated evidence
retains every operation time, hash, measured phase, batching volume, versions/options, query plans,
resource samples and source/binary fingerprints; it omits cumulative IO counters and hostnames.
The original run-file hashes are included. The initial small smoke run, fixed aggregate-response
mapping error and failed old-toolchain build are diagnostic history, not claimed benchmark passes.
