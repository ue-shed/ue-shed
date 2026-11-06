# Complete retained Game Text in Bun SQLite — 2026-11-06

This follows the [bounded spike](sqlite-query-engine-spike-2026-11-06.md). The comparison now
keeps complete retained evidence and returns complete query payloads. Only direct Bun SQLite and
the shipping Rust reader participate. The historical Node SQLite and SQLite process adapters are
excluded from this campaign.

Keep the shipping Rust backend for now. Bun SQLite preserves the complete retained evidence and
wins some page/bulk reads, but this prototype's broad localization counts are far too expensive
for adoption. SQLite's compatibility benefit is demonstrated; a migration needs a better SQL
count model and the missing preparation/rule capabilities, rather than a binding change alone.

## What the pilot proves

The generated full-size cohort has 583,798 saved text units, 583,507 localization lines,
1,028,205 text occurrences and ten cultures. Both paths start from the same generated saved-text
corpus and shipping native localization preparation. SQLite stores the complete corpus, nested occurrences,
manifest/archive/PO evidence, coverage, diagnostics, previews and query projections. It does not
store JSON documents: typed object-layout relations, ordered array relations and UTF-16 scalar
BLOBs retain arbitrary metadata without dropping unknown keys or lone surrogates. Dedicated
relations answer filters, facets, paging and aggregation in SQL.

Every complete unit and localization line was decoded back from SQLite and hashed against the
native retained stream. Complete views, previews and localized unit slices were also checked.
All 1,167,305 domain objects matched. Every raw line reference and rank was verified against a
decoded full line, with a separately hashed raw native stream. The complete corpus fingerprint
also covers its header, coverage, diagnostics and unit order. Integrity checks passed.

All 268 full-size query cases matched complete native responses, including ordered rows,
continuation, counts, own-clause facet omission, groups, all aggregate dimensions, focus/detail
data and explicit bulk reads. The three small/before/after cohorts add 798 matching responses:
1,066 complete-response comparisons in total.

The small semantic fixtures retain blank sources and invisible units that ordinary query pages
omit. They cover manifest-only fallbacks, notes, Unicode, duplicate sources, changed reviews and
key changes. Separate codec checks include NUL, unpaired UTF-16 surrogates, reserved characters,
arbitrary metadata, empty objects/arrays, missing fields and ordered duplicate list entries.

## Measurement

All 486 timed operations and 162 warmups matched their native expected answers. Median complete
operation latency in milliseconds, nine timed observations per cell; lower is better:

| Operation                          | Rust public host | Bun SQLite |
| ---------------------------------- | ---------------: | ---------: |
| Source rows, 50                    |             4.08 |       2.35 |
| Source rows + counts, 50           |            17.49 |     748.35 |
| Source rows, 5,000                 |           137.80 |      94.43 |
| Target rows, 50                    |            13.17 |      14.89 |
| Target rows + counts, 50           |            66.47 |  20,480.36 |
| Target rows, 5,000                 |         1,160.32 |   1,380.38 |
| Target rows + counts, 5,000        |         1,193.61 |  21,891.84 |
| Selective target search + counts   |            15.24 |     140.11 |
| Target namespace grouping + counts |            83.88 |  25,861.31 |
| Translation search, de + counts    |            21.55 |   7,889.08 |
| All fields, 1,000 selected lines   |           577.90 |     229.38 |
| Identity/source, all 583,507 lines |        19,544.12 |   5,259.60 |
| Culture × state aggregate          |           466.84 |   5,350.52 |

The default target search is about 308× slower here, while the all-lines identity/source export
is about 3.7× faster. That split matters: an equally wide retained payload does not make the two
query/data models equivalent. Full ranges for all 27 operations are in the chart and evidence.
For example, default target search ranges from 61.77–73.20 ms in Rust and 20,196.21–38,471.86 ms
in Bun. The observed minimum and maximum describe these samples, not a statistical guarantee.

Sampled process-tree working-set peaks span 2.81–2.99 GiB for Rust and 3.40–6.80 GiB for Bun.
Median callback gaps for default target search are 15.82 ms and 20,480.35 ms respectively. Bun's
direct synchronous query runs on its host thread; worker placement would be a separate adoption
decision. The existing Workbench responsiveness tests cover the shipping path.

This compares a current SQLite prototype with current shipping Rust. It does not reconstruct the
historical SQLite or DuckDB implementations. The initial spike demonstrated avoidable work in
both native projection and SQL aggregation; this follow-up preserves enough data and behavior to
measure the current candidate without mistaking those earlier implementation choices for a
universal database limit.

Three fresh processes per path run one checked warmup per operation and three timed repetitions,
with rotated path and case order: nine observations per operation/path. Every warmup and timed
answer must match the native expected SHA-256. Correctness hashing is outside operation timers.
Other construction, verification and repository checks finish before measurement. These are warm
queries in fresh application processes; OS caches are not flushed.

Reader `setupMs` starts after the harness loads shared input; it is not process-launch latency.
Sampled process-tree working sets include harness inputs/results and file-backed/shared pages,
and must not be interpreted as private index storage or private heap alone.

The Rust path uses the shipping public TypeScript host on Node, including its existing response
decoding. Bun uses direct `bun:sqlite` and reconstructs sealed relational records. Full payloads,
ordering and continuation behavior agree, but internal representations and host work differ.
Consequently these numbers measure the two application paths; they cannot isolate Bun binding
cost, IPC, SQLite execution or Rust execution. Native host-stage observations are retained in
the evidence rather than inferred by subtracting unrelated paths.

In particular, `tsRowObjects` times Effect Schema decoding, and `tsBatchView` times typed batch-view
construction. Other host materialization happens outside those stages. Their sum is not a complete
measurement of the bridge, and subtracting it from total latency does not isolate engine time.

The earlier narrow-projection control remains a particularly useful Rust follow-up: the full-size
export still takes 19.5 seconds despite requesting only identity/source fields. Preserve this
conformance workload when reviewing that fix. For SQLite, profile and redesign the broad culture
statistics passes before drawing a backend conclusion; repeating the current SQL in Bun does not
remove those passes.

The all-fields bulk case selects the same explicit 1,000 line IDs on both paths. The narrower
identity/source bulk case selects all 583,507 visible lines. Full-size conformance uses the
streaming corpus fingerprint and the every-record proof instead of constructing a multi-gigabyte
host array. Small fixtures additionally compare complete public corpus/line arrays.

## Tuning and failures found

The SQLite prototype needed deliberate query-engine work: enum facts in indexed relations,
scope-specific problem masks, SQL grouping, a 128 MiB connection page cache, a bounded statement
cache, and selective FTS5 trigram candidates followed by the exact substring predicate. Dense
searches scan; translation searches include culture evidence. Ordinary row reads load corpus
header evidence lazily. Narrow projections read only the selected object columns.

An initially missing `(kind,rank)` index made batched raw corpus reads repeatedly scan/sort.
The final store includes it. A silent full conformance run was stopped and restarted with per-case
and fingerprint-batch progress; interrupted runs are not timing evidence. Initial construction
was also stopped while redundant record decoding/storage was removed. Its development timings
are not a writer-throughput comparison.

The historical preparation harness hit JavaScript's maximum string size when serializing a
complete corpus. Its already completed native preparation was recovered; the new retention
pipeline uses bounded pages and NDJSON. The retained source is sealed with the native contract
hash and file hashes before construction.

The 5,000-row cases exposed a shipping host schema bug: requests admitted large pages, while
`LocalizationQueryPage.lines` rejected more than 50 responses. The small production fix shares
the existing 100,000-row query bound, with a regression test. No production Rust query changes
are applied. The measured executable must match the recorded shipping baseline hash. The earlier
Rust narrow-projection diagnostic remains a patch for a separate control, not a change silently
included in this comparison.

## Compatibility and publication

A stock Python SQLite reader reconstructs a complete nested line and runs a new audience/length
SQL report. Its complete line hash matches the retained evidence. This demonstrates independent
consumption without the UE Shed Rust engine or Bun runtime; it does not yet define a stable public
database schema.

The semantic update changes generated localization documents, adds/deletes gathered evidence,
changes PO text and publishes review/key-change state. Rust correctly takes its full-join fallback
for the mixed key-matching edit; its old reader remains pinned. SQLite's separate lifecycle test
publishes a complete relational generation, keeps a reader's old data/search result pinned,
rolls back all tables and layouts, and kills a fully staged writer after 436,752 bytes have spilled
to the uncommitted WAL. Recovery retains the committed generation and passes integrity checks.
This uses small semantic fixtures and proves transaction behavior, not comparable incremental
preparation/update cost at full size or power-loss behavior.

The prototype database is approximately 9.7 GB. Its generic lossless layout and retained query
projections are not a compact production writer. Storage size and construction time must not be
compared with a narrow fact-only database or presented as a complete source-to-index replacement.

## Verification and remaining work

`pnpm check` exited 0, including native/WASM IO and contracts, repository/package checks, the main
suite (456 files and 3,348 tests passed; 17 files and 56 tests skipped), and the three responsiveness
tests. The first gate attempt failed on prototype lint errors; those were fixed before the passing
run. Final precommit, prototype TypeScript/lint/format checks and three explicit Bun codec/storage
tests passed. Research `node:test` checks use `.checks.ts` and run explicitly, outside Vitest's
repository test discovery.

The full gate retains configured skips for live Unreal/Remote Control/rendering and Perforce
integration. Fresh UE 5.7 and UE 5.8 editor/conformance matrices were not run: the spike writes no
Unreal assets and changes no parser, code generator or native integration. Hosted CI was not run.
Native tests also retain eight ignored fixture/vector/manual timing/child-process cases. See the
portable evidence for their exact names, configured integration skip lines and gate log hash.

This remains a retained-read pilot. Authored finding evaluation and populated findings queries,
related/focus occurrence pagination, sink file APIs, cancellation/recovery scheduling, concurrent
host adoption, Project Index, full source-to-SQLite preparation and incremental writers remain
unimplemented. Asset-type filters need a populated type fixture. This evidence is sufficient to
compare the implemented Game Text reads; it does not establish a complete product backend swap.

Reproduction and exact commands live in the [pilot README](../../tools/benchmarks/sqlite-query/full/README.md).
The [portable evidence](sqlite-full-evidence-pilot-2026-11-06.json) records every sample/hash,
source fingerprints, runtime/SQLite options, query plans, resources, independent reads and skips.
The [offline chart](sqlite-full-evidence-pilot-2026-11-06.html) shows medians and observed ranges.
