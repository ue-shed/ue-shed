# Header pipeline speed pass — 2026-09-05

The production binary Catalog remains the baseline. This pass reduces fresh scan time by moving
post-read signature checks onto the header workers, allowing up to eight workers, and removing
successful-path parser allocations. No database, allocator, runtime backend switch, or new
dependency was added. The public parser model, protocol, Catalog format, and evidence profile remain
unchanged.

## Baseline and method

Baseline commit: `9d054f5b94c63d9838a36963b0c6c87f1183e40e` on `perf/sqlite-next`.
The frozen baseline executable has SHA-256
`32acb89498041b3f952f822a4fe82f348472abcffe8d69d817d713c6cd755597`.
The measured optimized executable (`pipeline-c.exe`) has SHA-256
`dc3e890886fd62082f0917f91b8e28c2a0ea548ed8ed8aa411024759db2a69e1`.
Executable sizes, intermediate variants, raw samples, parser replay fingerprints, and derived
medians are retained in [the JSON evidence](header-pipeline-2026-09-05.json).

Windows x64, Ryzen 9 7950X, 32 logical CPUs, 64 GiB RAM, Rust 1.94.0, Node 26.5.0. Projects were
read-only. All caches and private scratch artifacts live under the ignored
`test-results/header-pipeline-2026-09-05/` directory. No project identities or asset data are
included here. Small is the committed Unreal fixture; medium and large are separate real projects.

The maintained Workbench project-index benchmark exercises the headless production flow. Each
state has three timed samples and one warm-state warmup. The large comparison was repeated in
reverse order: its reported medians pool six samples per variant. Timed blocks ran serially without
concurrent compilation. Fresh means a new Catalog, not an OS-cold filesystem cache. These are local
measurements, not hosted CI timings or Electron rendering timings.

## Before and after

All durations below are milliseconds; each cell is baseline → optimized. Queries are the warm
five-route workload. Input decode is the targeted Enhanced Input step in the fresh scenario.

| Cohort | Packages |  Fresh catalog scan |        Warm refresh |         Queries |    Input decode |
| ------ | -------: | ------------------: | ------------------: | --------------: | --------------: |
| Small  |       71 |       43.05 → 36.85 |       17.65 → 17.48 |   17.53 → 18.57 |   26.10 → 30.20 |
| Medium |   10,128 |     343.25 → 282.24 |       63.80 → 61.92 | 136.15 → 111.86 |   62.22 → 57.05 |
| Large  |  199,539 | 8,502.59 → 5,473.30 | 2,285.99 → 2,265.90 | 765.28 → 767.83 | 201.00 → 202.29 |

Fresh scan improves approximately **14%, 18%, and 36%**. The complete fresh workload, including
queries, folding, and targeted input decode, measures 153.02 → 154.51 ms, 658.95 → 533.20 ms, and
9,540.72 → 6,506.70 ms. Small-project startup/transport overhead dominates its complete workload;
there is no demonstrated improvement there. Warm large queries and input decode show no gain.
The medium query difference is observed variance, not a demonstrated query optimization.

| Cohort |         Cache MiB | Sampled native peak RSS MiB | Sampled Node peak RSS MiB |
| ------ | ----------------: | --------------------------: | ------------------------: |
| Small  |     0.071 → 0.071 |                Not captured |           148.80 → 148.54 |
| Medium |     8.230 → 8.230 |               26.35 → 29.46 |           235.65 → 235.54 |
| Large  | 130.997 → 130.997 |             389.89 → 401.55 |           342.43 → 329.46 |

Memory values are medians of sampled peaks during fresh runs, not allocator measurements. The
fixture's native process finishes too quickly for the sampler. The largest native peak observed in
any large fresh/warm sample was 408.93 MiB after the change, versus 397.55 MiB before. The shared
read-ahead budget stays at 1,024 results even with eight workers. Storage is unchanged.

## What changed and why

1. **Parser:** custom-version field paths use lazy formatting. Successful reads no longer allocate
   a diagnostic string for each field. ANSI FString decoding copies ASCII in bulk and retains the
   existing byte-to-Unicode mapping for every non-ASCII value. It does not interpret non-ASCII ANSI
   strings as UTF-8.
2. **Scheduling:** workers obtain the post-read file signature alongside header evidence. The
   ordered coordinator consumes that observation and keeps its existing three-attempt unstable-file
   retry policy. Signature errors still abort refresh; header errors still produce partial evidence.
   The signature check is moved, not removed. As before, this verifies each read and does not provide
   a transactional snapshot of the source filesystem.
3. **Concurrency:** up to eight workers, capped by available parallelism, replace the fixed four.
   Ordering, bounded queues, cancellation, and one Catalog writer remain in place.

The first large instrumented run recorded summed worker elapsed times of 6.53 s in opening/reading
headers, 7.94 s in summary/table/path parsing, 1.21 s selecting evidence, and 3.14 s waiting to send.
The coordinator spent 5.01 s in its serial sink and 1.48 s waiting to receive. These overlap across
threads and are not additive wall-clock or CPU measurements. The profile excludes some allocation
cleanup and scheduler overhead. Instrumentation lives only in a generated research workspace.

The final instrumented large run reduces serial sink time to 1.34 s. Post-read signature checks
now account for 4.73 s summed across workers, while send waits fall to 1.01 s. This supports the
scheduling explanation: expensive file checks no longer serialize behind Catalog staging.

The staged experiments prevented misattribution:

| Large fresh refresh, initial three-sample blocks   | Median ms |
| -------------------------------------------------- | --------: |
| Baseline, four workers                             |  8,381.33 |
| Parser changes only                                |  8,570.97 |
| Parser plus worker signature checks, four workers  |  7,531.55 |
| Parser plus worker signature checks, eight workers |  5,498.54 |

Parser work alone did not improve full-flow throughput in its block. A separate in-memory replay
does show a parser gain. It includes complete `Package::parse_header` and package destruction,
excluding loading, discovery, and model fingerprinting. Two warmups precede ten samples. The sample
uses all 71 fixture packages and 4,096 evenly selected packages from each larger project.

| Header replay | Baseline ms | Optimized ms | Improvement |
| ------------- | ----------: | -----------: | ----------: |
| Small         |        9.67 |         9.46 |          2% |
| Medium sample |      138.46 |       129.03 |          7% |
| Large sample  |       97.20 |        76.56 |         21% |

All sampled parsed-model fingerprints match and every sampled header parses successfully. These
replays are samples, not a claim that parsing the entire large project takes 77 ms.

## Validation

- Targeted `uasset:check:libraries` and `uasset:check:io` gates pass, including native Clippy/tests,
  WASM browser and packed-consumer checks, native/WASM fixture parity, typed failures, and limits.
- Windows Catalog-oracle tests pass against SQLite, including unstable signatures, cancellation,
  atomic publication, and process termination tests.
- Complete ordered output matches for all five showcase query routes on all three projects.
  Entire physical Catalog snapshots also have identical SHA-256 hashes, covering all indexed
  packages rather than only query candidates.
- Added tests cover every ANSI byte value, UTF-8-looking ANSI sequences, exact custom-version
  diagnostic paths and offsets, duplicate GUID rejection, and propagation of worker signature errors.
- Linux passes 123 parser tests, 91 IO/oracle library tests, and 15 process tests. Windows passes
  123 parser tests, 92 IO/oracle library tests, and 15 process tests. Existing optional external-asset
  tests remain ignored; the ignored crash-child helper is launched by the process-termination test.

The full repository gate was not run; this pass changes Rust and research tooling.

## Remaining opportunities

Warm refresh still spends most of its time discovering files. The large warm query workload still
transports about 24 MB across 18 pages. Those are better next full-flow targets than more Catalog
format work. Electron selection-to-first-screen latency still needs its own measurement; the
headless benchmark cannot establish renderer performance.

Summary parsing still occurs twice in the native header loader, and the parser still constructs
the full generic model. Neither was bypassed in this pass. A resumable summary API or reduced
metadata path would need separate evidence and compatibility work. The current gains preserve the
existing validation and model.
