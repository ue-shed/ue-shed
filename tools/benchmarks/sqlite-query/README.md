# SQLite query-engine spike

Research for [Plan 064](../../../plans/archive/064-sqlite-query-engine-spike.md), isolated from production.
Use the same retained generated facts with the current Rust query engine, SQLite over the production
frame/batch/host session, direct Node SQLite, and direct Bun SQLite. The Rust SQLite server is serial;
it does not implement production request scheduling, cancellation, or concurrent clients.

## Reproduce

Use explicit runtime versions; the first local campaign uses Node 26.13.0, Bun 1.4.4 and Rust 1.98.1.
The machine's default older nightly does not compile the current production reader.

```powershell
pnpm install --offline --frozen-lockfile --ignore-scripts
pnpm run build:typescript-packages
$env:CARGO_TARGET_DIR = "$PWD/target"
$env:CARGO_BUILD_JOBS = "8"
$env:RAYON_NUM_THREADS = "16"
cargo +1.98.1 build --locked --release -p uasset-io
cargo +1.98.1 build --locked --release --manifest-path tools/benchmarks/sqlite-query/native/Cargo.toml

# Supply the machine's shared UE_SHED_UNREAL_LOCK if it differs from the existing corpus default.
New-Item -ItemType Directory -Force test-results/sqlite-query | Out-Null
node --import tsx tools/benchmarks/sqlite-query/prepare.ts test-results/sqlite-query/small 0.01
node --import tsx tools/benchmarks/sqlite-query/worker.ts build test-results/sqlite-query/small test-results/sqlite-query/small/build.json node
node --import tsx tools/benchmarks/sqlite-query/run.ts --input test-results/sqlite-query/small --output test-results/sqlite-query/small-run --runs 3 --repetitions 7

# Repeat preparation, construction and measurement at 0.001 and 0.1 scale, using new paths.
# Semantic controls cover nonempty Unicode matches, NUL, surrogates, culture states and duplicates.
node --import tsx tools/benchmarks/sqlite-query/controls.ts test-results/sqlite-query/controls
node --import tsx tools/benchmarks/sqlite-query/worker.ts build test-results/sqlite-query/controls test-results/sqlite-query/controls/build.json node
node --import tsx tools/benchmarks/sqlite-query/run.ts --input test-results/sqlite-query/controls --output test-results/sqlite-query/controls-run --lanes node,sqlite-pipe,bun --runs 3 --repetitions 3

node --import tsx tools/benchmarks/sqlite-query/lifecycle.ts test-results/sqlite-query/small/facts.sqlite test-results/sqlite-query/lifecycle
python tools/benchmarks/sqlite-query/read.py test-results/sqlite-query/small/facts.sqlite
```

Every output directory is new. Generated project/evidence files, databases and local raw logs stay
under ignored `test-results/`. Source files are never edited by the harness. There are no Unreal
assets, editor launches or project-content writes; `tinyJoinInput` generates retained records and
localization documents. Heavy input preparation and measurement use the existing corpus lock.
Do not compile, test or run another heavy job alongside the timed campaign.

## What is measured

- Exact ordered projected lines, short/long/missing/Unicode searches, FTS candidates verified by
  substring matching, namespace/audience/culture filters, pages of 1/50/5,000, and grouped counts.
- SQL demonstrations of duplicate-source grouping, UTF-16 length and empty-translation predicates.
  Their oracle is independently evaluated over retained facts. These are not benchmarks of replacing
  the complete authored rule compiler, findings/evidence identities or incremental evaluations.
- A scalar `SELECT 1` control for the three SQLite paths. It has no claimed native query equivalent.
- An independent Python read and a new length-distribution report, using stock SQLite and SQL.
- Separate schema/index construction, fresh-process connection/index readiness, warmed requests,
  callback gaps, sample process-tree memory, SQLite versions/options, query plans and source hashes.
- Structural SQLite edits, rollback, an old reader across a committed WAL write, and killing an
  uncommitted writer. These do not exercise Unreal join invalidation or simulate power loss.

The parent rotates lane order across three independent processes and rotates cases inside each
process. Hashing is outside operation timers. Warmups and all samples are retained or represented;
any hash/count mismatch fails the run. Sampling is bounded by 8 GiB tree RSS and ten minutes per
worker. Short processes may finish before any OS memory sample: those report null, not zero.

## Diagnostic controls

The initial measurements found that the native identity/source export builds the full preview
before selecting its fields. The retained patch tests skipping that unused work; it is not applied
to production source and is not a production-ready corruption/recovery change.

```powershell
New-Item -ItemType Directory -Force test-results/sqlite-query/bin | Out-Null
Copy-Item target/release/uasset.exe test-results/sqlite-query/bin/uasset-baseline.exe
git apply --check tools/benchmarks/sqlite-query/rust-projection.patch
git apply tools/benchmarks/sqlite-query/rust-projection.patch
cargo +1.98.1 build --locked --release -p uasset-io
Copy-Item target/release/uasset.exe test-results/sqlite-query/bin/uasset-projection.exe
git apply --reverse tools/benchmarks/sqlite-query/rust-projection.patch
Copy-Item test-results/sqlite-query/bin/uasset-baseline.exe target/release/uasset.exe
node --import tsx tools/benchmarks/sqlite-query/verify-projection.ts test-results/sqlite-query/projection-parity test-results/sqlite-query/bin/uasset-baseline.exe test-results/sqlite-query/bin/uasset-projection.exe
node --import tsx tools/benchmarks/sqlite-query/run.ts --input test-results/sqlite-query/medium --output test-results/sqlite-query/medium-projection --reader test-results/sqlite-query/bin/uasset-projection.exe --runs 3 --repetitions 3

# Aggregate indexed IDs before joining labels; no schema/index or expected-answer change.
node --import tsx tools/benchmarks/sqlite-query/tune-counts.ts test-results/sqlite-query/medium test-results/sqlite-query/medium-counts
node --import tsx tools/benchmarks/sqlite-query/run.ts --input test-results/sqlite-query/medium-counts --output test-results/sqlite-query/medium-counts-run --lanes node,sqlite-pipe,bun --runs 3 --repetitions 7
```

Do not force a patch that no longer applies to its documented base. Restore source and the default
baseline executable after building the diagnostic, including when an experiment fails.

## Interpretation limits

The SQLite database is a relational projection of already joined facts, not the native index's
complete retained provenance. Its size and build time cannot be compared as complete-store results.
Input preparation/native-join/export timers are diagnostics; they are not a competing end-to-end
SQLite join pipeline. Fresh means application state, not flushed OS caches.

Line export paths produce the same three fields and use the production native column encoder.
For page reads, native Rust constructs richer previews before the harness projects common fields;
SQLite selects those fields directly. This tests the current APIs, not equal-width transport or
pure storage execution. Pooled operation p95s describe these runs, not a statistical guarantee.

SQLite engine versions/compile options differ between Rust, Node, Bun and Python. Binding,
representation and scheduling work differ too. SQLite-pipe minus direct SQLite is not pure IPC
time. The experimental server records SQL/row extraction and encoding/send phases separately;
request overhead also includes the host and runtime.

Strings use a shared dictionary. Big-endian UTF-16 bytes preserve original text, length and
ordinal ordering. A reversible scalar view, matching the native engine's convention, preserves
lone surrogates and distinguishes real reserved scalars. This is an explicit consumer convention,
not automatic SQLite TEXT behavior; Python can recover original strings from UTF-16 BLOBs.
Searches containing reserved scalar markers or lone surrogates need additional semantic proof:
only round-trip and ordinary Unicode search controls are established here.

The FTS index covers dictionary strings, including translations and paths, not only source strings.
Source-only indexing, compression, further query tuning and portable custom Unicode functions are
not exhausted. No claims extend to Project Index, every facet's filter-omission semantics, all
production policies, responsiveness under concurrent rules, or complete cache recovery.

## Checks

```powershell
pnpm exec tsc -p tools/benchmarks/sqlite-query/tsconfig.json
pnpm exec oxlint tools/benchmarks/sqlite-query
pnpm exec oxfmt --check tools/benchmarks/sqlite-query
node --import tsx --test tools/benchmarks/sqlite-query/sqlite.test.ts
cargo +1.98.1 test --locked --manifest-path tools/benchmarks/sqlite-query/native/Cargo.toml
cargo +1.98.1 clippy --locked --manifest-path tools/benchmarks/sqlite-query/native/Cargo.toml --all-targets -- -D warnings
cargo +1.98.1 fmt --manifest-path tools/benchmarks/sqlite-query/native/Cargo.toml -- --check
```

Rust owns the experimental SQL request types. To update their generated TypeScript after changing
the Rust contract, set `UE_SHED_UPDATE_GENERATED=1` for the native contract test, then format it and
rerun the test. The test permits TypeScript formatting changes but rejects changed type tokens.
