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

WASM is a required runtime, but this harness does not fabricate a WASM timing from a native library
build. Add a browser or WASI scenario when the versioned WASM inspection binding ships, and require
it to use the same bytes and semantic fixture assertions as the native producer.
