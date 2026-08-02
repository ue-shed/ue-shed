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

This records two application-cache states without embedding the supplied project path in the
evidence: `workbench.index.cold_rebuild` performs the shared header index plus the targeted
Enhanced Input decode with an empty native header cache; `workbench.index.warm_revalidate` repeats
only the cached index refresh. Both states still enumerate and stat the selected roots, because
that is how the inventory validates persisted Workbench projections. Filesystem caches are not
dropped, so "cold" means the application cache, not an artificial cold disk.

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
