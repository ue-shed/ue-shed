# DuckDB Project Index research

Status: accepted design and benchmark evidence, 2026-08-06. DuckDB is the production Catalog
implementation.

For the complete visual comparison with the pre-SQLite JSON baseline and both DuckDB Adapter
shapes, open [Project Index: four eras, one workload](project-index-storage-comparison.html).

## Outcome

DuckDB remains worth adopting, but the earlier experimental Adapter was still leaving substantial
performance on the table. The next experiment should not be a mutable SQLite-shaped database. It
should build a path-ordered, one-row-per-package, immutable DuckDB file for each physical snapshot,
append nested evidence in Arrow record batches, and publish a tiny Generation manifest atomically.

That design preserves the existing storage-neutral Catalog Interface. SQL, files, checkpoints, and
DuckDB configuration remain private to the Adapter; the CLI and Workbench continue to ask bounded,
typed Project Index questions.

## What the engine is good and bad at

DuckDB is strongest when it can ingest and scan vectors, operate on columns in bulk, and amortize
planning and connection setup over substantial queries. Its Appender is the documented bulk-load
Interface, and the Rust client can append an Arrow `RecordBatch`. Prepared single-row inserts are
explicitly not the bulk-loading path.

The Project Index has two natural DuckDB advantages:

- a cold scan already produces ordered batches of independent package records; and
- most questions filter a few columns across the whole snapshot, then hydrate a bounded page.

The mismatches matter just as much:

- DuckDB is not designed for many tiny disconnected queries. Reopening a connection loses cached
  metadata and data, while the Workbench currently starts a native process for every page.
- Cross-process access to one database file is either one read/write process or multiple read-only
  processes. A writer cannot safely coexist with independent read-only query processes on that same
  file.
- ART indexes target point and extremely selective queries. They duplicate data, consume memory,
  and slow loads and updates. The measured Project Index routes do not justify them.
- Updates to nested values rewrite rows. A long-lived mutable file would trade away DuckDB's bulk
  strengths and complicate concurrent publication.
- Row-group parallelism only begins when there are enough row groups. The default 122,880 rows gives
  a 185,676-package table only two row groups, so defaults are not automatically optimal here.

These are reasons to deepen the Adapter, not to weaken the Catalog Interface.

## Measured model experiments

The exploratory conversion driver used an existing disposable SQLite Catalog only as source data
and wrote aggregate evidence without project paths, project identities, package paths, class values,
or serialized-name values. That one-off driver was retired with the SQLite adapter after production
cutover. The retained ignored result is
`test-results/project-index-duckdb-model-research.json`.

The representative snapshot contains 185,676 packages, 631,258 class values, and 7,724,306
serialized-name values. All query measurements fetch the same 13,878 items over 17 bounded pages.

| Model or setting                   | Catalog bytes | 17-page query mean | Finding                                 |
| ---------------------------------- | ------------: | -----------------: | --------------------------------------- |
| Normalized, three unindexed tables |    58,994,688 |           895.6 ms | Fair set-oriented baseline              |
| Nested lists, 122,880-row groups   |    38,023,168 |           819.0 ms | Smaller and faster than normalized      |
| Nested lists, 16,384-row groups    |    41,168,896 |           711.9 ms | More scan parallelism for modest space  |
| Nested lists, 32,768-row groups    |    39,858,176 |           588.7 ms | Best measured size/query compromise     |
| Nested lists, 8,192-row groups     |    43,003,904 |           612.6 ms | No query win over 32,768                |
| Nested lists, 2,048-row groups     |    78,655,488 |           612.7 ms | Metadata/fragmentation cost is too high |
| Nested lists, 16,384, unordered    |    55,848,960 |         1,051.0 ms | Do not discard scanner path ordering    |

The trials share the operating-system file cache and are exploratory rather than release gates.
Their direction is nevertheless clear:

- nested `VARCHAR[]` columns remove two large child relations and their repeated identities;
- preserving `relative_path` order materially improves compression, zonemap Locality, cursor scans,
  and the final `ORDER BY`; and
- the default row-group size under-partitions this package count.

On the warmed 16,384-row-group file, the same workload averaged 738.4 ms with one thread, 537.9 ms
with four, 548.0 ms with eight, 548.4 ms with sixteen, and 545.7 ms with thirty-two. Start with a
four-thread cap and remeasure end to end; more cores did not improve this workload.

A path-ordered immutable copy of the complete nested snapshot took 622.3 ms and produced a
40,382,464-byte file. Bulk variants spent only 2.3–7.6 ms in an explicit checkpoint. Those results
make a complete generation file plausible even for a tiny change, while avoiding same-file
cross-process writer/reader conflicts.

The in-process query workload fell as low as roughly 0.54 seconds after caches were warm. Reopening
the database connection for every page raised that to about 0.75 seconds, but the production
process-per-page measurement is 2.77–2.81 seconds. Most remaining query overhead is therefore above
the SQL scan: executable startup, schema/open work, and protocol orchestration. DuckDB's own guidance
also recommends connection reuse for small repeated queries.

## Recommended private Adapter

Use generation-specific immutable data files plus one atomic manifest:

```text
catalogs-v2/<project-hash>/
  manifest.json
  snapshot-<physical-id>.duckdb
  snapshot-<older-physical-id>.duckdb
```

The manifest records the logical Generation, physical snapshot identity, project identity, profile
version, summary, and schema version. A query validates `expected_generation` against the manifest,
then opens the named snapshot read-only. Publication closes and checkpoints the new file before an
atomic manifest replacement. Old readers keep their already-open immutable file; bounded cleanup
removes retired files later and retries files still held open on Windows.

Cold refresh should create the unpublished snapshot table directly and feed one package row per
scanner result batch:

```text
relative_path, kind, size, modified_nanos, is_map,
profile_version, package_name, failure_code,
classes VARCHAR[], class_names VARCHAR[], serialized_names VARCHAR[]
```

The scanner already owns `Vec<String>` evidence. Convert each bounded 1,024-package batch into an
Arrow `RecordBatch` with list arrays and call the Rust Appender's `append_record_batch`; do not first
explode those vectors into millions of normalized child rows. Because the target file is not
published, cancellation can close and remove it without rolling back a visible Generation.

For a changed refresh, attach the prior snapshot read-only and bulk-create the next ordered table
from unchanged prior rows plus staged replacements. The measured whole-snapshot copy is subsecond,
so this is the safe initial Implementation. A later measured threshold may choose another strategy,
but mutating the published file is not acceptable.

A warm no-op need not copy data. It can atomically publish the next logical Generation pointing to
the same physical snapshot. This retains today's refresh semantics while avoiding write
amplification.

## Query and route publication

Catalog publication means making a new immutable Generation visible; it does not mean having the
Workbench pull all relevant data. Product workflows should remain lazy by route. When one workflow
does require several Project Index predicates, however, it should send them as one bounded query
session so one native process and one read-only connection can stream the pages. Every emitted page
stays within the existing bound; no whole-project manifest enters TypeScript.

Independent routes can also be evaluated concurrently against one read-only connection or against
multiple read-only processes. Start with a single session and four DuckDB threads because that was
the best measured CPU setting and has lower resource contention than spawning many engines.

## Rejected or deferred ideas

- Do not recreate the five SQLite-style ART indexes. The measured build cost was 12.67 seconds, file
  size grew to about 1.02 GB, and DuckDB documents ART indexes as a fit for point or below-0.1%
  selectivity.
- Do not normalize class and serialized-name vectors merely out of relational habit. Regrouping the
  7.7-million-row name relation peaked around 3 GB in the research conversion; direct nested ingest
  avoids that work.
- Do not count a cross-engine SQLite-to-DuckDB conversion as publication time. It exists only to
  create representative research fixtures.
- Do not select 2,048-row groups from query latency alone. They nearly doubled the nested file size.
- Do not adopt `MERGE INTO` on the published file until it proves both faster and compatible with the
  immutable cross-process publication model. Initially, a subsecond full snapshot copy is simpler.
- Do not add `ANALYZE`, custom compression, latest storage format, or an index without an
  `EXPLAIN ANALYZE` result and an end-to-end improvement. CTAS already records statistics, and the
  current evidence does not identify these as bottlenecks.

## Implemented production gate

The production adapter was bounded to these variables:

1. Rust DuckDB 1.5.5 with `bundled` and Arrow Appender support.
2. Direct nested Arrow batches of 1,024 path-ordered packages.
3. Immutable snapshot files with atomic logical-Generation publication.
4. Row-group sizes 16,384 and 32,768, with `threads = 4` as the initial query setting.
5. One persistent bounded query session versus today's process-per-page path.
6. Cold, warm no-op, one-change, one-delete, cancellation, concurrent previous-generation reader,
   corruption/quarantine, binary/package size, peak RSS, locked offline build, and full license
   graph gates.

The natural implementation passed the shared Catalog conformance, release, recovery, representative
performance, and bounded-memory gates. Production therefore selects DuckDB without retaining a
runtime storage-engine choice.

## Primary references

- [DuckDB Rust client](https://duckdb.org/docs/current/clients/rust)
- [DuckDB Appender](https://duckdb.org/docs/current/data/appender)
- [Rust `Appender::append_record_batch`](https://docs.rs/duckdb/latest/duckdb/struct.Appender.html)
- [Concurrency](https://duckdb.org/docs/current/connect/concurrency.html)
- [Tuning workloads and connection reuse](https://duckdb.org/docs/current/guides/performance/how_to_tune_workloads)
- [Indexes and zonemaps](https://duckdb.org/docs/current/guides/performance/indexing)
- [Nested data types](https://duckdb.org/docs/current/sql/data_types/overview)
- [List functions](https://duckdb.org/docs/current/sql/functions/list)
- [Storage format and row groups](https://duckdb.org/docs/current/internals/storage)
- [CHECKPOINT](https://duckdb.org/docs/current/sql/statements/checkpoint)
- [Profiling and `EXPLAIN ANALYZE`](https://duckdb.org/docs/current/dev/profiling)
