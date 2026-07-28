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

The WASM workload is the 2.4 MB `DT_LargeScalars` fixture. Both producers parse, decode, and serialize
the same schema-v7 inspection output. The WASM lane receives already-read bytes and reuses one module
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
- `typescript.input.single`: the source TypeScript CLI application and release reader for the same
  asset. This includes Effect/schema projection and process orchestration, but excludes the
  source-checkout Cargo launcher.
- `typescript.input.project`: the same application scanning every `.uasset` in the fixture project.
  The result records fixture package count and bytes.
- `unreal.commandlet.verify`: an optional fresh `UnrealEditor-Cmd` process running the fixture's
  `-VerifyOnly` path.

The Unreal lane is deliberately labeled as startup plus fixture verification, not equivalent parser
throughput. It currently performs more semantic work than the parser scenarios. Use it to quantify
the cost avoided by an editor-free first result, not to claim a codec speed ratio.

Each distribution includes every sample plus minimum, mean, p50, p95, and maximum. Results also
record the Git revision and dirty state, operating system, CPU, memory, Node and Rust versions,
fixture size, exact run counts, and whether builds were excluded.

## Interpretation and optimization

Compare results from the same machine, power policy, checkout, fixture, and cache condition. Warmups
reduce one-time loader noise but do not make measurements portable across machines. Reference
budgets belong in an accepted decision only after a representative small, medium, and large corpus
has been measured.

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

Incremental caching is the next boundary. `uasset catalog` already keys entries by path, size, and
modification time, but `uasset scan` has no `--cache` yet, and the CLI's own `catalog` invocations
pass no cache path.

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
