# Full-evidence Bun SQLite pilot

[Plan 065](../../../../plans/065-sqlite-retained-query-pilot.md). Direct `bun:sqlite` against the
shipping Rust reader through its public TypeScript host. The Node SQLite and SQLite process
adapters are excluded. Node still runs the production Rust host.

This is a retained-query experiment, not a replacement for package extraction, the localization
join or authored-rule execution. Both readers start after the same shipping preparation. SQLite
keeps complete corpus, manifest/archive/PO, review, key-change and arbitrary nested evidence,
including raw blank-source provenance. Its query tables and projections answer queries without
calling Rust or exporting all rows into a JavaScript filter.

## Reproduce

Use Node 26, Bun 1.4.4 and Rust 1.98.1 (the recorded environment); install and build the repository
as in the parent README. Every preparation/retention/output path below must be new.

```powershell
$env:RUSTUP_TOOLCHAIN = "1.98.1"
$env:CARGO_TARGET_DIR = "$PWD/target"
$env:CARGO_BUILD_JOBS = "8"
cargo build --locked --release -p uasset-io

node --max-old-space-size=16384 --import tsx tools/benchmarks/sqlite-query/full/prepare.ts test-results/pilot-source 1
node --max-old-space-size=8192 --import tsx tools/benchmarks/sqlite-query/full/retain.ts test-results/pilot-source test-results/pilot
node --import tsx tools/benchmarks/sqlite-query/full/seal.ts test-results/pilot
bun tools/benchmarks/sqlite-query/full/construct.ts test-results/pilot

bun tools/benchmarks/sqlite-query/full/verify-records.ts test-results/pilot
node --max-old-space-size=8192 --import tsx tools/benchmarks/sqlite-query/full/conformance.ts test-results/pilot
bun tools/benchmarks/sqlite-query/full/evaluate.ts test-results/pilot test-results/pilot/parity.json
python tools/benchmarks/sqlite-query/full/read.py test-results/pilot/complete.sqlite

# Run after construction, verification and other heavy jobs have finished.
node --import tsx tools/benchmarks/sqlite-query/full/benchmark.ts test-results/pilot test-results/pilot-timings 3
```

`prepare.ts ROOT SCALE --reuse` opens an existing generated preparation without doing it again.
This recovered the first full-size preparation after the historical harness attempted one
corpus-sized `JSON.stringify` and reached the JavaScript string-size limit. Retention uses bounded
batches and NDJSON instead. A same-contract hash and file checksums seal that producer's output;
construction verifies them once. Full object equality is checked separately for **every** retained
record, rather than repeatedly schema-decoding our own messages in the measured path.

The complete corpus fingerprint streams through bounded batches. Full-size query conformance
uses it in place of a corpus-sized host array, and checks complete line data against the retained
native stream. The all-fields timing selects 1,000 lines; the identity/source export selects all
visible lines. Both sides receive identical selections and return identical fields and order.

## Semantic and lifecycle fixtures

```powershell
node --import tsx tools/benchmarks/sqlite-query/full/prepare.ts test-results/sqlite-full/semantic-source 0.001 --semantic
node --import tsx tools/benchmarks/sqlite-query/full/retain.ts test-results/sqlite-full/semantic-source test-results/sqlite-full/semantic
node --import tsx tools/benchmarks/sqlite-query/full/seal.ts test-results/sqlite-full/semantic
bun tools/benchmarks/sqlite-query/full/construct.ts test-results/sqlite-full/semantic
node --import tsx tools/benchmarks/sqlite-query/full/conformance.ts test-results/sqlite-full/semantic
bun tools/benchmarks/sqlite-query/full/evaluate.ts test-results/sqlite-full/semantic test-results/sqlite-full/semantic/parity.json

# This mutates only generated localization documents, never an Unreal asset.
node --import tsx tools/benchmarks/sqlite-query/full/advance.ts test-results/sqlite-full/semantic-source
node --import tsx tools/benchmarks/sqlite-query/full/retain.ts test-results/sqlite-full/semantic-source test-results/sqlite-full/semantic-updated
node --import tsx tools/benchmarks/sqlite-query/full/seal.ts test-results/sqlite-full/semantic-updated
bun tools/benchmarks/sqlite-query/full/construct.ts test-results/sqlite-full/semantic-updated
node --import tsx tools/benchmarks/sqlite-query/full/conformance.ts test-results/sqlite-full/semantic-updated
bun tools/benchmarks/sqlite-query/full/evaluate.ts test-results/sqlite-full/semantic-updated test-results/sqlite-full/semantic-updated/parity.json
bun tools/benchmarks/sqlite-query/full/lifecycle.ts test-results/sqlite-full/semantic test-results/sqlite-full/semantic-updated test-results/sqlite-full/lifecycle

bun test ./tools/benchmarks/sqlite-query/full/conformance.checks.ts
pnpm exec tsc -p tools/benchmarks/sqlite-query/tsconfig.json --noEmit
pnpm exec oxlint tools/benchmarks/sqlite-query
pnpm check
```

The semantic fixture includes invisible String Table references, missing evidence and fallback
places. Its updated generation adds Unicode and duplicate-source evidence, deletes a gathered
entry, changes PO text, and adds current/changed review state and key-change pairs. Native pinning
is checked across that update. The mixed edit legitimately takes Rust's full-join fallback for
key matching. The SQLite lifecycle test publishes complete generations, keeps an old reader
pinned, rolls back all tables/layouts, and kills a fully staged uncommitted writer. It does not
claim equivalent incremental package-update cost.

## Storage and measurement

- Dedicated indexed relations hold row selections, raw-unit membership, culture marks, facts,
  groups and folder coordinates. Small integer query columns materialize repeated enum facts;
  SQLite owns row matching and aggregate work. Scope-specific problem masks use temporary tables.
- Case-sensitive FTS5 trigrams provide candidates for selective ASCII source searches, followed
  by the exact substring predicate. Dense searches scan instead; translation search includes its
  culture evidence. A bounded plan cache makes that choice. Raw rank has its own index so streaming
  the complete corpus does not repeatedly sort or scan the visible-row index.
- Nested records use relational object layouts and ordered array children. Scalar strings retain
  original UTF-16 BLOBs, including lone surrogates; query text uses a reversible Unicode view.
  No JSON documents are persisted in SQLite. Projection reads only named object columns.
- There is a 256-statement cache. Statements are finalized on eviction/close so Windows releases
  the database handles deterministically. Record hydration has bounded batches and clears its
  decoded-object cache after each read; there is no hidden all-corpus JavaScript query cache.
  SQLite's connection page cache is 128 MiB. Corpus-header evidence loads only when a query needs
  it; ordinary page reads do not reconstruct the package-coverage/diagnostic arrays.
- Timings include each path's actual row materialization and host processing. Rust uses its
  existing public host, including its current response decoding; Bun reconstructs sealed records.
  Native host decode stages are recorded. These are application paths, not isolated engine or
  binding measurements, and latency differences cannot be attributed solely to storage.
- Three fresh processes per lane, one correctness-checked warmup per case/process, three timed
  repetitions, rotated case/lane order. Hashing is outside timers. Process-tree RSS is sampled
  every 1.5 seconds; query runs stop above 8 GiB or 20 minutes. Callback gaps include synchronous
  work that ends before a timer fires. They are not a Workbench responsiveness test.
- Construction and repair are preparation operations. Their logged durations were observed
  during implementation and are not an isolated writer-throughput comparison.

After those checks and a clean WAL checkpoint, capture the portable evidence and offline chart:

```powershell
bun tools/benchmarks/sqlite-query/full/capture.ts test-results/pilot test-results/pilot-timings docs/research/pilot.json test-results/pilot-check.log test-results/sqlite-full/lifecycle test-results/sqlite-full/semantic test-results/sqlite-full/semantic-updated
bun tools/benchmarks/sqlite-query/full/visualize.ts docs/research/pilot.json docs/research/pilot.html
```

Capture requires the successful `pnpm check` exit code in `pilot-check-exit.txt` beside that log,
and the baseline binary at the path documented in the parent experiment. It verifies timing
hashes, record/query controls, complete-generation lifecycle checks, Python's full-line read and
the shipping reader's binary hash. It records exact source hashes so a dirty measured revision
cannot be mistaken for the initial spike commit.

## Remaining product work

The pilot compares the supported retained read/query cases; it does not implement the complete
`NativeTextQuery` service. Authored finding evaluation and populated finding-layer queries,
related/focus occurrence pagination, sink file APIs, cancellation/recovery scheduling, concurrent
host integration, Project Index, full source-to-SQLite preparation and incremental writers remain
outside this prototype. Asset-type behavior needs a populated type fixture. Passing the retained
data and query cases does not prove these missing capabilities or justify migrating both indexes.
