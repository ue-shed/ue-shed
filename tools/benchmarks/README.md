# Rust core and Catalog experiments

The synthetic experiments use deterministic, generic input. Actual-project tools accept explicit
roots and write disposable caches. These tools are not production storage adapters and do not
participate in the shipped dependency graph. Results and databases belong under
the ignored `test-results/` directory. See
[the 2026-09-05 review](../../docs/research/rust-core-review-2026-09-05.md) for measured results,
limitations, and the baseline commit.

## Historical actual-project SQLite Catalog experiment

SQLite is now the production backend. See [the current guide](../../docs/engineering/sqlite-project-index.md).
This generator retains the earlier copy/rebase experiments for reproducibility.

`prepare_sqlite_catalog.py` prepares an isolated copy of the current Rust workspace, repository
fixtures, and protocol contracts. It replaces only the native Catalog adapter in that copy. The scanner, coordinator, inspection, protocol, and showcase client remain shared.
No production backend flag or dependency is added. Output must be a new directory.

```powershell
python tools/benchmarks/prepare_sqlite_catalog.py test-results/sqlite-catalog-source --serialized-names scan
cargo test --manifest-path test-results/sqlite-catalog-source/Cargo.toml --target-dir target/sqlite-research -p uasset-io --all-targets
cargo build --release --manifest-path test-results/sqlite-catalog-source/Cargo.toml --target-dir target/sqlite-research -p uasset-io
pnpm benchmark:project-index -- --project <project-root> --reader target/sqlite-research/release/uasset.exe --no-build --runs 3 --warmups 1 --output test-results/sqlite-project.json
```

Use `--serialized-names postings` (the default) to index names too. Both variants index exact class,
class prefix, and reversed class-name suffix evidence. The scan variant evaluates name predicates
against JSONB arrays. Every physical replacement rebuilds IDs in path order, so insertion and rename
costs include rebasing; a warm no-op reuses the physical file. Staging is lazy, writes use one
`synchronous=FULL` transaction, and the manifest is atomically published with the production helper.
SQLite cache files are isolated under `catalogs-sqlite-research-v1`.

These are research adapters, not complete production replacements. The shared coordinator and
process suites run unchanged, but the SQLite adapter still needs its own corruption, recovery,
concurrent-reader, abandoned-staging, numeric-boundary, and release/CI review. The generator uses frozen historical manifest helpers in `catalog-manifest-research.rs`, so later
production changes do not silently alter the old experiment.
Fresh timings include JSONB preparation, ID rebasing, indexes, and commit; no index preparation is
excluded. File sizes include free pages retained by SQLite after staging is dropped.

Compare all ordered results from the five showcase query routes, including continuation pages:

```powershell
python tools/benchmarks/compare_project_catalogs.py --project <project-root> --reader duckdb=<duckdb-executable> --reader sqlite=<sqlite-executable> --output test-results/catalog-parity
```

The output directory must be new. It retains marked disposable caches plus path-free query counts
and SHA-256 digests. Project files are read-only. The optional `benchmark_catalog_repair.py` tool
requires one of those marked caches; it changes one cached timestamp, refreshes from the unchanged
project, checks that exactly one package is rebuilt, and records absent/common-name first-page
queries. This models cache repair, not an authored project mutation. DuckDB repair requires the
Python environment described below; SQLite repair uses Python's built-in SQLite.

See [the second speed pass](../../docs/research/rust-core-speed-round2-2026-09-05.md) for actual-project
timings, separate production changes, rejected experiments, and limitations.

## Storage models

Use Python 3.14 with `duckdb==1.5.5` and `pyarrow==23.0.1`; Python's built-in SQLite must support
JSONB (3.45 or newer). The recorded run used Python SQLite 3.50.4. For example, on Windows:

```powershell
python -m venv test-results/catalog-experiment/venv
test-results/catalog-experiment/venv/Scripts/python -m pip install --only-binary=:all: duckdb==1.5.5 pyarrow==23.0.1
test-results/catalog-experiment/venv/Scripts/python tools/benchmarks/catalog_storage.py --output test-results/catalog-experiment/data --packages 185676 --runs 5
```

The harness builds path-ordered DuckDB nested lists, SQLite JSONB, and SQLite JSONB with covering
postings. It also compares bounded postings pagination, page-first DuckDB hydration, and single-value
DuckDB membership. All queries hydrate complete bounded results and compare ordered SHA-256 hashes
across engines. Seven predicates cover maps, exact class, class prefix, class-name suffix, rare
serialized name, absent name, and common name. Page size is 1,024 plus one look-ahead row.

Output directories must be fresh for builds. `--reuse` reruns queries on those same synthetic
databases, preserving build measurements and replacing query results. It never opens application
caches. Retain an earlier `results.json` separately before using `--reuse` if comparing driver revisions.

## Native Rust query comparison

The generator writes `native-query-spec.json`, so Rust executes the same SQL without maintaining a
second query generator. Rust uses `duckdb-rs` pinned to the historical production version and `rusqlite` 0.37.0
(bundled SQLite 3.50.2). Each engine produces the same owned strings and vectors. Every sample checks
counts, page counts, and a fingerprint of all ordered hydrated rows. Fingerprints are cross-engine
assertions in one run, not a stable wire contract.

```powershell
cargo build --locked --release --manifest-path tools/benchmarks/catalog-native/Cargo.toml --target-dir target
target/release/catalog-storage-research.exe test-results/catalog-experiment/data/native-query-spec.json 5 test-results/catalog-experiment/data/native-results.json
```

On Unix, omit `.exe`. The final sample reopens a connection for each page; it does not spawn a process
for each page. Earlier samples reuse one connection for the workload, rotate engine order, and include
connection setup, SQL preparation, query execution, hydration, and fingerprinting. There is no
TypeScript, filesystem enumeration, package parsing, or protocol serialization in these timings.

The separate Cargo workspace and lockfile keep the historical DuckDB comparison out
of production `Cargo.lock`. SQLite is now canonical; these model comparisons remain research only. Its dependencies are permissively licensed: DuckDB/duckdb-rs are MIT,
rusqlite/libsqlite3-sys are MIT, SQLite is public domain, Arrow is Apache-2.0, and serde/serde_json are
MIT OR Apache-2.0. This does not authorize shipping another adapter without the repository's release
and license gates.

## Immutable snapshot mutations

```powershell
test-results/catalog-experiment/venv/Scripts/python tools/benchmarks/catalog_mutations.py test-results/catalog-experiment/data
```

This copies each snapshot before changing one header or deleting one package, commits, then compares
complete query results. SQLite uses backup; DuckDB uses ordered CTAS. It measures copy and mutation
separately and refuses to replace existing output files. It does not implement manifest publication,
reader retention, cancellation, quarantine, or generation checks. New path insertion is not covered:
the postings prototype assigns IDs in path order, so a production design must preserve or rebuild
that ordering when inserting packages.

## Header evidence selection

```powershell
rustc -O tools/benchmarks/header_selection.rs -o test-results/catalog-experiment/header-selection.exe
test-results/catalog-experiment/header-selection.exe > test-results/catalog-experiment/header-selection.jsonl
```

This compares cloning every name, borrowing every name, and retaining a bounded borrowed set. It
checks identical sorted unique output for ascending, descending, shuffled, and duplicate-heavy input
at 64, 512, 4,096, and 65,536 names. Seven samples are retained. This is an isolated algorithm
benchmark, not an end-to-end scanner speedup claim. The production regression also covers empty and
Unicode values, duplicated input, late smaller values, and zero/oversized limits.
