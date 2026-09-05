# Rust core and Catalog experiments

The synthetic experiments use deterministic, generic input. Actual-project tools accept explicit
roots and write disposable caches. These tools are not production storage adapters and do not
participate in the shipped dependency graph. Results and databases belong under
the ignored `test-results/` directory. See
[the 2026-09-05 review](../../docs/research/rust-core-review-2026-09-05.md) for measured results,
limitations, and the baseline commit.

## Header pipeline profiling

`prepare_header_profile.py <new-output-directory>` copies the native workspace and adds elapsed
timers only to that copy. Build its `uasset-io` release executable, then run:

```powershell
python tools/benchmarks/profile_project_headers.py --project <project-root> --reader <instrumented-reader> --output <new-output-directory>
cargo run --release -p uasset-parser --example benchmark_headers -- <project-root>
```

The first command makes a fresh disposable Catalog and records aggregate stage timings. Worker
times overlap: their sum is neither CPU time nor scan wall time. Instrumentation adds overhead;
use the uninstrumented `benchmark:project-index` command for before/after speed claims.

The replay example samples up to 4,096 packages evenly from sorted discovery and retains at most
512 MiB of header bytes. Two warmups precede ten parse-and-drop samples with file IO excluded.
It prints aggregate counts and a deterministic Debug-model digest without asset identities. The
digest is a regression fingerprint, not a cryptographic proof of equivalence. Loading errors abort
the replay; header parsing errors contribute to the fingerprint and failure count. Compare complete
ordered query output with `compare_project_catalogs.py` as well.

## Binary Catalog hardening and artifacts

The [binary adapter](../../crates/uasset-io/src/direct_executor/catalog_binary.rs) is now the production
backend. See [the storage guide](../../docs/engineering/binary-project-index.md) and
[hardening measurements](../../docs/research/custom-catalog-hardening-2026-09-05.md). Normal builds and
tests exclude SQLite; `cargo test -p uasset-io --all-targets --features catalog-oracle` runs the oracle.

The first prototype remains frozen below. `prepare_custom_catalog.py --version v2` selects the later
research template with CRC32, bulk reuse, locks, and interruption tests. Its oracle feature is named
`sqlite-oracle`; run tests with that feature to include SQLite. Source copies exclude build caches.
Production additionally pins readers on open and checks bounded manifests and summary consistency.

Exercise an assembled Windows native artifact through a fresh, offline-installed npm consumer:

```powershell
python tools/benchmarks/verify_native_package.py --reader target/release/uasset.exe --output test-results/catalog-package
```

The tool never publishes. It uses the maintained assembly script, packs copied packages, installs
them locally with lifecycle scripts disabled, and runs version, fresh/warm refresh, and map queries
with an empty PATH. The current npm artifact supports Windows x64 only.

## Historical custom binary Catalog prototype

`prepare_custom_catalog.py` copies the native workspace, fixtures, and protocol contracts into a
fresh research directory. It selects `custom-catalog.rs` only in that copy. SQLite is a dev-only
oracle in the v1 prototype workspace; the custom release reader
contains no database engine dependency.

```powershell
python tools/benchmarks/prepare_custom_catalog.py test-results/custom-catalog-source
cargo test --manifest-path test-results/custom-catalog-source/Cargo.toml --target-dir target/custom-catalog -p uasset-io --all-targets
cargo clippy --manifest-path test-results/custom-catalog-source/Cargo.toml --target-dir target/custom-catalog -p uasset-io --all-targets -- -D warnings
cargo build --locked --release --manifest-path test-results/custom-catalog-source/Cargo.toml --target-dir target/custom-catalog -p uasset-io
pnpm benchmark:project-index -- --project <project-root> --reader target/custom-catalog/release/uasset.exe --no-build --runs 3 --warmups 1 --output test-results/custom-project.json
```

The format has five length-delimited sections: compact inventory, shared strings, posting directory,
postings, and header records. Exact names and classes have direct postings; prefixes/suffixes inspect
the much smaller class dictionary. IDs follow path order per physical snapshot. Queries load
metadata once per session and hydrate selected records. Section and record/posting checksums detect
accidental damage; they are non-cryptographic. Readers reject invalid counts, bounds, UTF-8, and IDs.
Each section is capped at 512 MiB in this prototype.

Fresh snapshots build their dictionary and indexes in memory. Changed/deleted refreshes rewrite the
retained records and indexes, retaining old string IDs; unused dictionary strings are not compacted
until a full rebuild. A warm no-op reuses the physical snapshot. Publication syncs and verifies the
new file before the atomic manifest switch. Independent old readers keep their open snapshot.
Cache files are isolated under `catalogs-custom-research-v1`.

Tests run both existing adapter suites and a deterministic SQLite-oracle sequence with inserts,
deletions, changed classes/names, failed headers, sidecars, Unicode, duplicate filters, and page sizes
1/7/1024. Additional tests cover damaged/truncated records, forged impossible counts, full unsigned
signatures, failed publication, no-op reuse, and old readers. This is not a crash/power-loss soak or
a production persistence contract.

Use `compare_project_catalogs.py` for complete real-project query parity. Its marked disposable
caches can be passed to `benchmark_catalog_repair.py --engine custom`, which changes one inventory
timestamp and recomputes its checksum before the measured refresh. Only cache metadata is changed;
source projects stay read-only. Historical benchmark scenario notes say SQLite; identify experimental
runs by the supplied reader and report label.

Separate process opening from repeated name queries using those same marked caches:

```powershell
python tools/benchmarks/benchmark_catalog_query_session.py --reader sqlite=<sqlite-executable> --reader custom=<custom-executable> --cache sqlite=<sqlite-marked-cache> --cache custom=<custom-marked-cache> --output test-results/catalog-query-session.json
```

The tool times setup once, then five bounded requests per predicate in each reused native session.
It verifies identical page digests across engines. Timings include protocol transfer and Python JSON
decoding, so they are not pure engine timings. See [the prototype report](../../docs/research/custom-catalog-prototype-2026-09-05.md)
for measured gains, opening and mutation regressions, memory, storage, and validation limits.

## Historical actual-project SQLite Catalog experiment

SQLite is now a test oracle. See [the historical guide](../../docs/engineering/sqlite-project-index.md).
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
of production `Cargo.lock`. These model comparisons remain research only. Their dependencies are permissively licensed: DuckDB/duckdb-rs are MIT,
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
