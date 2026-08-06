# UAsset parser benchmarks

The UAsset benchmark answers a narrow product question: how quickly can UE Shed return saved-package
evidence without starting Unreal? It records each process boundary separately so native decode,
TypeScript projection, source-checkout startup, and Unreal startup are not presented as the same
work.

## Commands

Run the portable benchmark:

```powershell
pnpm benchmark:uasset
```

Include the configured UE 5.7 commandlet:

```powershell
pnpm benchmark:uasset:unreal
```

Measure the long-lived Node WASM binding against a fresh native process:

```powershell
pnpm benchmark:uasset:wasm
```

Measure Workbench's shared project-index path against a specific project:

```powershell
pnpm benchmark:project-index -- --project <unreal-project-root> --output test-results/project-index.json
```

This records `project_index.cold_build` and `project_index.warm_noop` without embedding the supplied
project path or asset identities in the evidence. Cold builds the SQLite Catalog, executes the same
bounded map/class/prefix/suffix/name workload used by Workbench domains, folds candidate headers,
and performs targeted Enhanced Input decode. Warm reuses the Catalog and rewrites zero evidence,
but still enumerates and stats Content to prove the Generation is current. Filesystem caches are not
dropped, so "cold" means an absent application Catalog rather than an artificial cold disk.

Evidence schema v4 separates enumeration, comparison, header processing, direct SQLite evidence
writes, commit/index publication, bounded queries, TypeScript folding, and targeted decode.
`headerProcessingExcludingEvidenceWritesMs` subtracts measured Catalog-write time from the
coordinator's header phase; it is an attribution aid, not a claim that all remaining time is parser
CPU. Use the storage split and commit timing together before deciding whether another Catalog
adapter deserves a controlled comparison.

The command builds `@ue-shed/unreal-assets` and the locked release `uasset-io` reader before
measurement, then records `readerBuild: "performed"`; setup time is excluded from every sample. Use
`--no-build` only to reuse already-built TypeScript and native artifacts. Supplying `--reader <path>`
selects a prebuilt native artifact while still rebuilding the TypeScript package, and records
`readerBuild: "skipped"`.

The paired TypeScript/native legacy protocol uses a 1 GiB cumulative output ceiling. This remains a
finite compatibility guard for generic v1 scans, not a target payload size; the bounded Project
Index operations are expected to remain far below it. Individual protocol frames remain measured
separately so a large cumulative result is not confused with one oversized frame.

Each sample records total protocol bytes, the largest complete protocol frame, Node and Rust peak
RSS, native cache bytes, duration, aggregate inventory counts, and only the typed failure kind when
a run fails. `rustPeakRssBytes` is `null` when a worker exits before the platform sampler can observe
it. This is common for the small fixture and should not occur during a representative multi-second
project scan.

Before writing or printing evidence, the harness decodes it through its versioned Effect Schema and
checks that scenario counts, distributions, failure summaries, and mutation configuration agree.
Unknown fields are rejected rather than silently serialized. It also scans the final evidence for
the supplied project and mutation paths, including slash and case variants, and aborts if either
escaped into the aggregate result.

Changed-package and deletion baselines are opt-in because they mutate the filesystem. Supply a
second disposable project, never the read-only measured project:

```powershell
pnpm benchmark:project-index -- --project <read-only-project-root> `
  --mutation-project <disposable-project-root> --output test-results/project-index.json
```

The disposable root must be distinct after path canonicalization, contain at least one package, and
carry `.ue-shed-project-index-benchmark-disposable` with exactly this content (including the final
newline):

```text
UE_SHED_PROJECT_INDEX_BENCHMARK_DISPOSABLE=1
```

The harness changes one package timestamp for `project_index.one_changed_package` and temporarily
renames one package plus its sidecars for `project_index.one_deleted_package`. It restores the
original timestamp and names in `finally` blocks. Refusing a missing/mismatched marker or an existing
backup is part of the safety contract.

The WASM workload is the 2.4 MB `DT_LargeScalars` fixture. Both producers parse, decode, and serialize
the same schema-v8 inspection output. The WASM lane receives already-read bytes and reuses one module
instance; the native lane starts a process and reads the file for every sample. The benchmark labels
that authority difference rather than presenting it as a codec-only comparison. Its JSON result
records every sample, environment and revision identity, input/output size, and optimized module
size.

The harness builds the release parser before measuring. The Unreal lane also builds the fixture
target before measuring; neither build is included in samples. Use `--no-build` only after building
the exact artifacts under test.

Useful options:

```text
--native-runs <count>  Timed runs for native and TypeScript scenarios (default 10)
--unreal-runs <count>  Timed fresh commandlet runs (default 3)
--warmups <count>      Untimed warmup runs for every selected scenario (default 1)
--output <path>        Write the complete JSON result to a file
--json                 Print only the complete JSON result
--no-build             Reuse existing release parser and fixture binaries
--unreal               Include the fresh Unreal commandlet lane
```

`UE_SHED_UNREAL_ENGINE_ROOT` selects the Unreal installation. Without it, the Windows harness uses
the fixture contract to discover a matching Epic Games Launcher installation.

## Workloads

The harness reports:

- `native.inspect.single`: release `uasset inspect` for the fixed Enhanced Input mapping-context
  fixture. This includes process startup, file read, decode, and JSON serialization.
- `native.scan.header.concurrency1` and `native.scan.header.concurrency4`: the same uncached header
  scan with explicit worker counts. Their observed output records scanned assets, emitted assets,
  and cache hits so a faster result cannot silently represent less work.
- `native.scan.header.cache.cold` and `native.scan.header.cache.warm`: the same four-worker header
  scan with a temporary cache. Cold removes the application cache before every sample; warm seeds it
  before measurement. Filesystem caches remain warm in both cases.
- `typescript.input.single`: the source TypeScript CLI application and release reader for the same
  asset. This includes Effect/schema projection and process orchestration, but excludes the
  source-checkout Cargo launcher.
- `native.inspect.level`: release `uasset inspect` over `L_CameraLoad.umap`, the largest package in
  the fixture at 16,525 exports. Paired with `unreal.commandlet.level` below.
- `typescript.input.project`: the same application scanning every package in the fixture project.
  The result records fixture package count and bytes.
- `unreal.commandlet.verify`: an optional fresh `UnrealEditor-Cmd` process running the fixture's
  `-VerifyOnly` path.
- `unreal.commandlet.level`: an optional fresh `UnrealEditor-Cmd` process running
  `-BenchmarkLevelParse`, which loads the same level and walks every serialized property. Its
  `distribution` is wall-clock and therefore mostly editor startup; its `observed` field carries the
  load and property-walk milliseconds the commandlet spent on the package itself.

`unreal.commandlet.verify` is deliberately labeled as startup plus fixture verification, not
equivalent parser throughput. It performs more semantic work than the parser scenarios. Use it to
quantify the cost avoided by an editor-free first result, not to claim a codec speed ratio.

`unreal.commandlet.level` is the lane that _is_ comparable, and it answers two different questions.
Measured on UE 5.7 over the same 16,525-export level, `native.inspect.level` ran 178.0 ms p50 while
the commandlet took 5282.1 ms p50 wall-clock but only 299.9 ms in process (233.3 ms load plus
66.6 ms walk). So the parser is ~30x faster end to end, which is the number a caller actually pays
and is almost entirely editor startup avoided, and ~1.7x faster on parse work alone. Prefer the
end-to-end figure for product claims and the parse-only figure for codec claims, noting that the
parse-only comparison flatters the commandlet: its walk excludes process startup and JSON
serialization, both of which the parser's 178.0 ms includes. The two lanes walk the same set of
property tags — the parser decodes every tag on disk, per
`fixtures/unreal-project/FixtureExpected/level-decode-gaps.json` — but the commandlet's walk is over
already-loaded objects, so it never pays for byte-level decode.

Each distribution includes every sample plus minimum, mean, p50, p95, and maximum. Results also
record the Git revision and dirty state, operating system, CPU, memory, Node and Rust versions,
fixture size, exact run counts, and whether builds were excluded.

## Interpretation and optimization

Compare results from the same machine, power policy, checkout, fixture, and cache condition. Warmups
reduce one-time loader noise but do not make measurements portable across machines. Reference
budgets belong in an accepted decision only after a representative small, medium, and large corpus
has been measured.

The fixture benchmark deliberately has no wall-clock regression threshold. Its TypeScript scenarios
are dominated by source-loader and process startup, while its 52-package cache/concurrency sample is
too small to establish a portable budget. Correctness gates instead require identical validated
output and explicit observed work. Add a numeric threshold only after repeated clean-checkout runs on
a representative project demonstrate a stable distribution.

Optimize the highest boundary cost first. A fast Rust decode does not compensate for spawning one
reader per package, parsing irrelevant exports, or rebuilding unchanged catalogs. Prefer generic
batch inspection, header filtering, streaming progress, and incremental caches before specializing
the core parser for one asset domain.

Batch inspection and header filtering have landed as `uasset scan`, which the project-wide product
scans now use. Measured on this fixture, the reader-level cost per package fell from 11.0 ms when
spawning one `uasset inspect` per package to 2.1 ms for one unfiltered `uasset scan`, and to 0.53 ms
once a class filter lets the reader rule packages out from their headers. That marginal per-package
cost is what scales with project size; the remaining `typescript.input.project` time is dominated by
Node startup, which one fixture-sized scan cannot amortize.

Header-depth `uasset scan` now caches its filtered header projection by path, size, and modification
time. A cache is intentionally specific to its filter set: persisting every export merely to share
one cache would make map-heavy projects much larger. `scan --inventory` streams the same pass's
package and sidecar signatures, allowing consumers to validate persisted derived catalogs without a
separate Node filesystem walk.

### Plan 036 closure sample (2026-08-02)

A three-sample closure run on the 52-package fixture verified identical scanned/emitted counts while
varying concurrency and application-cache state. Filesystem caches remained warm. The complete
machine-readable result was written to the ignored `test-results/uasset-plan036-final-native.json`.

| Scenario                          |      p50 |      p95 | Observed work                         |
| --------------------------------- | -------: | -------: | ------------------------------------- |
| `native.scan.header.concurrency1` | 103.2 ms | 103.5 ms | 52 scanned, 52 emitted, 0 cache hits  |
| `native.scan.header.concurrency4` |  99.6 ms | 116.8 ms | 52 scanned, 52 emitted, 0 cache hits  |
| `native.scan.header.cache.cold`   | 105.5 ms | 107.9 ms | 52 scanned, 52 emitted, 0 cache hits  |
| `native.scan.header.cache.warm`   |  67.4 ms |  76.4 ms | 52 scanned, 52 emitted, 52 cache hits |

This corpus proves cache behavior and stable output but is too small to justify a concurrency or
wall-clock regression threshold. Four workers were only marginally faster at p50 and noisier at p95;
the warm application cache was the material improvement.

### Shared Workbench project-index result (2026-07-30)

The new `benchmark:project-index` runner was measured on a representative 182,626-package project
with an AMD Ryzen 9 7950X, Windows 11, Node 26.5.0, Rust 1.94.0, and a dirty development checkout.
The three samples below keep filesystem caches warm; "cold" means an empty native header cache, not
a cold disk. The ignored JSON evidence is `test-results/project-index-20260730.json`.

| Scenario                          |          p50 |          p95 | Samples                            | Observed work                                                                     |
| --------------------------------- | -----------: | -----------: | ---------------------------------- | --------------------------------------------------------------------------------- |
| `workbench.index.cold_rebuild`    | 5,766.790 ms | 5,771.064 ms | 5,766.790; 5,771.064; 5,592.451 ms | One shared native header index plus 165 targeted Enhanced Input package decodes   |
| `workbench.index.warm_revalidate` | 2,882.836 ms | 2,900.912 ms | 2,882.836; 2,869.162; 2,900.912 ms | One cached header refresh and complete signature inventory; no Input Atlas decode |

The header scan emitted 728 class-filter matches and a complete 182,626-entry package inventory;
there were no sidecars in this corpus. Maps and DataTables are pure projections of that header/index
result, so they do not add a filesystem pass. The former Node manifest walk and dedicated DataTable
scan are not re-run for a direct before/after comparison because their implementation was removed;
the prior audit measured the Node walk alone at 5.7 seconds and the separate Rust header pass at
2.6–4.1 seconds.

### Plan 037 legacy-ceiling sample (2026-08-04)

The hardened schema-v2 harness first reproduced the cumulative 64 MiB failure, then reran the same
184,559-package corpus after paired TypeScript/native releases raised the finite legacy ceiling to
1 GiB. All three cold and warm samples completed and returned the terminal summary. The ignored
aggregate evidence is `test-results/project-index-mb-research-1gib.json`; privacy validation rejects
project paths, asset identities, and fields outside the evidence contract.

| Scenario                   |      p50 |      p95 | Protocol output | Cache bytes | Peak Node RSS | Peak Rust RSS |
| -------------------------- | -------: | -------: | --------------: | ----------: | ------------: | ------------: |
| `project_index.cold_build` | 11.695 s | 11.857 s |      69.166 MiB |  54.828 MiB |     232.0 MiB |     337.2 MiB |
| `project_index.warm_noop`  |  7.111 s |  7.188 s |      67.989 MiB |  54.828 MiB |     218.1 MiB |     322.3 MiB |

Every sample reported 184,559 package inventory entries. Cold reported zero cache hits; warm
reported 184,559. Cold also performed the targeted Enhanced Input decode for 165 candidates. The
legacy path now works for this corpus, but its roughly 68–69 MiB protocol transfer and complete
TypeScript inventory remain the architectural baseline that bounded Project Index queries must
replace.

A same-machine follow-up reused each package signature for both inventory and cache comparison and
skipped serializing/writing the 54.828 MiB JSON cache on an exact no-op. Warm p50 improved from
7.111 seconds to 6.592 seconds (7.3%); its three samples were 6.568, 6.592, and 6.653 seconds. Cold
p50 improved from 11.695 seconds to 11.455 seconds across two normal samples of 10.613 and 11.455
seconds, while a third cold filesystem pass took 245.416 seconds and is retained as an outlier. The
ignored follow-up evidence is
`test-results/project-index-mb-research-scan-cache-optimized.json`.

This harness cannot see decode-only regressions or wins. Its fixture is about 3 KB, so
`native.inspect.single` is dominated by process startup. Removing per-property allocation from the
decoder took `DT_LargeScalars` (10,000 rows) from 45.8 ms to 12.0 ms p50 for decode alone, measured
in process with a parse-once decode-many loop, while `native.inspect.single` did not move at all. Use
a large table and an in-process loop when the question is codec throughput, and keep the two kinds of
measurement labeled separately. See [WASM decode boundary](../research/wasm-decode-boundary.md) for
that measurement and its methodology.

WASM has a separate source-checkout harness because its long-lived in-process authority differs from
the native CLI scenarios above. `pnpm test:uasset-wasm` first proves byte-for-byte inspection parity
over real fixtures and malformed input. `pnpm benchmark:uasset:wasm` then measures the large-table
boundary without pretending its fresh-process native comparison is decode-only. A future browser
scenario or parse-once decode-many Rust export should be added as a separately labeled lane.

[WASM decode boundary](../research/wasm-decode-boundary.md) records the earlier native-derived
reasoning and the first measured WASM result.
