## Native side

Measured 2026-10-26 at `d12f4da7`, based on `a9a8fa95`. This is attribution, with no algorithm,
format, or product-behaviour changes. The [numeric measurements](game-text-scan-native-measurements.json)
retain the aggregate counters, internal stages, anonymous package samples, and histogram.

### Method and boundaries

One fresh-cache build per project, using the release reader built with
`cargo build --locked --release -p uasset-io`. Node 26.12.0, `RAYON_NUM_THREADS=16`,
`CARGO_BUILD_JOBS=8`; the benchmark harness acquired the shared heavy-job lock. Runs were sequential
background jobs. The projects were read-only inputs; no Unreal Editor or Perforce operation ran.

From Git Bash, select `$project` in memory from the supplied environment file and set `$out`
to a fresh output directory outside the input project, then run:

```bash
: "${project:?Select the benchmark project in memory}"
: "${out:?Set a fresh external output directory}"
export PATH="/c/Users/denny/AppData/Local/vite-plus/data/js_runtime/node/26.12.0:$PATH"
export RAYON_NUM_THREADS=16 CARGO_BUILD_JOBS=8
export UE_SHED_UNREAL_LOCK='E:\es-id-repairs-scratch\unreal.lock'
export TEMP='E:\ue-shed-engine-scratch\temp'
export TMP="$TEMP"
export UE_SHED_GAME_TEXT_STAGES=1
export UE_SHED_UASSET_EXECUTABLE='D:\git\ue-shed-wt-p45-native\target\release\uasset.exe'
export UE_SHED_COLD_SCAN_MEASURE_DIR="$out/native"
mkdir -p "$UE_SHED_COLD_SCAN_MEASURE_DIR"
node scripts/benchmark-game-text-engine.ts --project "$project" \
  --stages build --runs 1 --output "$out"
```

For the 1× project, also pass
`--generated --records 'E:\ue-shed-engine-scratch\phase4\records-1x'`. Output directories were
`E:\ue-shed-engine-scratch\p45-native-released-r2` and
`E:\ue-shed-engine-scratch\p45-native-1x-r2`; the native records are `native/cold-scan-<pid>.ndjson`,
and host spans are `run-1/build/stages.json`. Each output used a new index cache. This does not mean
an empty OS filesystem cache.

`Instant` measures elapsed wall time. Windows `GetProcessTimes` measures kernel plus user CPU summed
across all native threads, including threads that have exited. `GetThreadTimes` measures individual
calling threads for the nested operation aggregates. CPU/wall is average occupied cores, not a
percentage. Request-boundary thread enumeration runs outside the measured wall/CPU interval; internal
boundaries use fast process counters. Thread CPU accounting is quantized (15.625 ms in these samples),
so tiny stages can show zero CPU or CPU greater than their wall time. Large stage totals are useful;
sub-millisecond CPU comparisons are not.

Nested operation wall sums are **thread-seconds** and overlap across workers. They must not be added
to obtain elapsed wall time. Tables using exclusive operation sums subtract nested spans on the same
thread. Coarse sequential stages use elapsed wall and whole-process CPU. The initial probe calibration
that enumerated threads at every boundary was discarded. No per-package names, paths, text, or
per-export logs are collected: retention is ten slow packages, ten last completions, eight histogram
bins, aggregate labels per thread, and at most 256 coarse checkpoints per request.

### Overall measurements

All timing columns are seconds. Host wall includes request transport and probe boundary overhead;
native wall covers execution of the operation itself.

| Operation / project                            | Host wall | Native wall | Native CPU |            Threads doing work | Average cores |
| ---------------------------------------------- | --------: | ----------: | ---------: | ----------------------------: | ------------: |
| Extraction, the released project               |    37.576 |      37.403 |    208.047 | 9 extracting; 17 over request |         5.562 |
| Join, the released project                     |    15.774 |      15.595 |     26.172 |                            17 |         1.678 |
| Join, the 1× project                           |    16.548 |      16.349 |     25.406 |                            17 |         1.554 |
| Package publication, the released project      |     7.929 |       7.759 |     11.109 |                            17 |         1.432 |
| Package publication, the 1× project            |    13.042 |      12.888 |     16.078 |                            17 |         1.247 |
| Localization publication, the released project |    13.619 |      13.490 |     16.062 |                            17 |         1.191 |
| Localization publication, the 1× project       |     9.498 |       9.379 |     13.391 |                            17 |         1.428 |

The released project built in 112.674 s, with 4,935,884,800 bytes peak process-tree RSS; the 1× project
built in 69.419 s, with 2,759,110,656 bytes peak process-tree RSS. These are whole-build memory peaks,
not memory attributed to a particular native operation. A separate small metadata publication took
0.053 s / 0.016 s CPU and 0.048 s / below-resolution CPU, respectively; it is excluded from the cold
publication rows above and retained in the numeric artifact.

Reader thread counting requires care: eight measured extraction workers and one coordinator operate
concurrently. Before them, `resolve_roots_with_concurrency` creates eight distinct validation workers
for the 15,612 explicit input paths. The count of those eight follows from the actual request size,
concurrency, and scheduler code; their individual CPU counters were not captured. They have exited
by the final OS thread snapshot. Process CPU includes them. Writer counts use request-boundary live
thread CPU deltas: the coordinator plus sixteen Rayon workers all recorded positive CPU.

### Extraction

The released project read **15,612 packages, 8,431,479,437 bytes**, and wrote **505,438,831 bytes** of
staged NDJSON. There was no native package extraction for the 1× project: its saved records were
replayed by the host.

| Component                                                                        | Summed thread wall, s | Summed thread CPU, s |
| -------------------------------------------------------------------------------- | --------------------: | -------------------: |
| File reads                                                                       |                 5.196 |                3.094 |
| Package parse                                                                    |                 8.601 |                6.875 |
| Export decode                                                                    |               132.994 |              117.812 |
| Text projection, gather reconciliation and record construction, excluding decode |                58.208 |               47.125 |
| Other package work, including cleanup                                            |                 2.712 |                2.688 |
| Staging preparation and buffered writes                                          |                21.254 |               20.109 |
| Final staging flush                                                              |                 0.028 |                0.031 |
| Protocol result emission                                                         |                 0.257 |                0.188 |
| Workers waiting for jobs, including queue synchronization                        |                84.027 |                6.859 |
| Workers sending completed results                                                |                 0.029 |     below resolution |

The staging timer includes group lookup and JSON serialization as well as buffered file writes; it
is not a disk-write-only measurement. Parse plus decode consumed 124.688 s CPU. The eight extraction
workers consumed 184.531 s CPU over their lifetimes; their individual CPU seconds were
22.750, 22.562, 23.250, 23.469, 23.016, 23.250, 23.094, 23.141. The coordinator consumed 22.109 s. These are
nested summaries, not additional costs. Total process CPU also includes validation, discovery and
thread lifecycle work outside those worker spans.

Observed scheduling: eight workers, a sixteen-job bounded window, consuming completed results out
of order when staging is enabled. The coordinator stages and emits each result before scheduling a
replacement job. The 84.027 thread-seconds waiting for jobs, alongside 20.109 s coordinator staging
CPU, show an internal consumer bottleneck. Protocol output costs only 0.257 s wall; these samples do
not indicate substantial waiting for the host to drain output. File reads consume little of the
worker wall budget. The stage is primarily compute work, with serialized staging preparation limiting
worker occupancy, rather than a disk-bound read or a host-output wait. This is an inference from the
measured CPU, read, queue and emission times; no kernel wait-stack profiler was used.

The ten slowest packages all finished by about 8.1 s into the request. The final two completions were
only **51.843 ms** apart; the last package took 127.236 ms. Thus no multi-second final-package tail
held this run open.

| Slow rank |      Bytes | Kind      | Wall, ms |  CPU, ms |
| --------- | ---------: | --------- | -------: | -------: |
| 1         | 38,754,569 | Blueprint | 2628.238 | 1375.000 |
| 2         | 35,391,094 | Blueprint | 2560.424 | 1390.625 |
| 3         | 35,449,477 | Blueprint | 2532.465 | 1531.250 |
| 4         | 38,976,612 | Blueprint | 2493.301 | 1140.625 |
| 5         | 36,767,664 | Blueprint | 2473.661 | 1343.750 |
| 6         | 37,736,945 | Blueprint | 2469.726 | 1390.625 |
| 7         | 38,165,331 | Blueprint | 2414.018 | 1453.125 |
| 8         | 35,268,280 | Blueprint | 2410.666 | 1343.750 |
| 9         | 36,640,210 | Blueprint | 2328.443 | 1203.125 |
| 10        | 34,946,626 | Blueprint | 2299.035 | 1281.250 |

| Package wall-time interval | Count |
| -------------------------- | ----: |
| [0, 1) ms                  | 7,873 |
| [1, 5) ms                  | 3,324 |
| [5, 20) ms                 | 2,029 |
| [20, 100) ms               | 2,152 |
| [100, 500) ms              |   203 |
| [0.5, 2) s                 |    18 |
| [2, 10) s                  |    13 |
| 10 s or more               |     0 |

### Join

Each cell below is **elapsed wall / process CPU, seconds**. Rows are sequential and additive apart
from small unmarked setup/cleanup. `query.*` details below the table are subdivisions, not additional
join stages. Existing broad `lines` and `query` boundaries were split more finely without changing
what the join does.

| Native component                                  | The released project | The 1× project |
| ------------------------------------------------- | -------------------: | -------------: |
| Inputs and dependency key                         |        0.001 / 0.000 |  0.003 / 0.000 |
| Dictionary and localization columns               |        1.056 / 1.062 |  0.988 / 0.984 |
| Package columns                                   |        1.132 / 1.125 |  0.911 / 0.922 |
| Occurrence and unit order                         |        1.523 / 1.516 |  1.176 / 1.156 |
| Line groups                                       |        0.023 / 0.016 |  0.023 / 0.016 |
| Folder and file preparation                       |        0.059 / 0.062 |  0.048 / 0.047 |
| Line and culture values                           |        1.242 / 1.234 |  1.498 / 1.500 |
| Source/folder interning and split-unit completion |        0.086 / 0.078 |  0.073 / 0.078 |
| Marks and release of writer lookup                |        0.431 / 0.438 |  0.859 / 0.844 |
| Query columns                                     |       4.695 / 13.750 | 6.330 / 14.281 |
| Query places                                      |        1.819 / 1.812 |  1.497 / 1.500 |
| Summary state                                     |        0.131 / 0.141 |  0.116 / 0.109 |
| Dependency graph build                            |        0.935 / 0.922 |  0.765 / 0.766 |
| Columns, metadata and graph commit                |        0.695 / 0.688 |  0.716 / 0.719 |
| Joined publication                                |        1.719 / 3.281 |  1.289 / 2.422 |

Query-column detail, in the same wall / CPU units:

| Query component            | The released project | The 1× project |
| -------------------------- | -------------------: | -------------: |
| Raw/slice entries          |        1.092 / 1.078 |  2.304 / 2.297 |
| Raw IDs, sort and packing  |        0.453 / 4.859 |  0.394 / 4.125 |
| Line IDs, sort and packing |        1.016 / 5.703 |  0.979 / 5.203 |
| Package order              |        0.211 / 0.203 |  0.153 / 0.156 |
| Source search cache        |        0.211 / 0.219 |  0.721 / 0.719 |
| Translation search cache   |        1.625 / 1.609 |  1.707 / 1.703 |

Observed workload: 568,728 versus 583,507 lines, 1,314,813 versus 1,028,205 occurrences, ten cultures
on both projects, and 2,464,431 versus 4,559,992 shared strings. Snapshot raw-byte reads during the
join were 1,142,696,971 versus 1,127,291,287 bytes (including verification). Stored-byte reads differed
much more: 168,716,319 versus 33,845,685 bytes. Emitted snapshots were 106,995,944 versus 22,943,172
bytes. The logical row/column workloads and CPU costs are close; project size and compressed bytes
are poor predictors here. The 1× project's extra entry/source-cache/marks time offsets the released
project's extra occurrence ordering, places and output work. These measured offsets explain the
similar totals; there is no evidence of a fixed sixteen-second sleep or fsync delay. Fsync sums
inside join were only 0.055 s and 0.021 s including manifests.

### Package layer publication

Both requests published 256 layers through `Store::prepare_batch_cold`. The elapsed stages below
include their nested I/O and codec operations; each cell is **wall / process CPU, seconds**.

| Component                                        | The released project | The 1× project |
| ------------------------------------------------ | -------------------: | -------------: |
| Read staged string blocks, parallel              |        0.078 / 0.781 |  0.108 / 1.250 |
| Collect, deduplicate and intern domains          |        4.983 / 4.984 |  9.247 / 9.203 |
| Map each layer's strings to shared IDs           |        0.980 / 0.984 |  1.981 / 1.969 |
| Encode, write, fsync and verify layers, parallel |        1.704 / 4.344 |  1.537 / 3.656 |

The interning plus mapping stages occupy 5.963 s of 7.759 s (77%) and 11.228 s of 12.888 s (87%).
Their nearly equal wall and CPU times show serial compute. The higher final string count of the 1×
project is consistent with its larger interning cost; this run did not separately count distinct
package strings by domain, so that causal attribution remains a hypothesis.

The following **exclusive thread-wall / thread-CPU sums, seconds**, expose low-level components.
Parallel sums overlap; the 16.353 s compression sum is contained in a 1.704 s parallel elapsed stage,
not sixteen seconds added to publication. Snapshot reads include staged input and output verification.

| Low-level component                                             | The released project |           The 1× project |
| --------------------------------------------------------------- | -------------------: | -----------------------: |
| Snapshot open/header processing                                 |        0.133 / 0.047 |            0.152 / 0.031 |
| Snapshot section reads                                          |        0.209 / 0.016 | 0.196 / below resolution |
| Section decode, validation and other load work, excluding reads |        6.906 / 1.812 |            6.175 / 1.656 |
| Store interning, excluding instrumented nested codec/I/O        |        4.136 / 4.062 |            8.375 / 8.312 |
| ID remapping and column bytes                                   |        1.244 / 0.125 |            0.751 / 0.031 |
| Codec selection and column transforms, excluding compression    |        1.424 / 0.156 |            1.113 / 0.250 |
| Zstd compression, including codec samples                       |       16.353 / 2.906 |           15.927 / 3.016 |
| Payload and final snapshot writes                               |        0.405 / 0.078 |            0.358 / 0.016 |
| Snapshot and manifest fsync                                     |        0.186 / 0.172 |            0.190 / 0.141 |

Staged input sizes were **263,302,528 / 276,961,800 bytes**; emitted snapshot sizes were
**13,022,060 / 7,048,408 bytes** (the released project / the 1× project). Cumulative stored-section
reads were 303,143,633 / 282,568,006 bytes and decoded raw reads were 464,750,001 / 392,280,047 bytes.
There were 260 snapshot finishes/verifications per request, including dictionary and root snapshots.

### Localization layer publication

Both requests supplied 21 layers and used the empty-store external-merge dictionary builder.
Each cell is **elapsed wall / process CPU, seconds**; rows include their nested operations.

| Component                                     | The released project | The 1× project |
| --------------------------------------------- | -------------------: | -------------: |
| Read/collect strings and sort runs            |        5.103 / 7.734 |  3.789 / 7.906 |
| Merge sorted runs and assign dictionary IDs   |        2.929 / 2.922 |  2.375 / 2.312 |
| Front-code, compress and publish dictionaries |        1.095 / 1.062 |  0.494 / 0.469 |
| Remap/encode/publish layers and root          |        4.339 / 4.312 |  2.697 / 2.688 |

The sorting subset was 0.703 s wall / 3.359 s CPU over nineteen runs and 0.645 s / 4.781 s over
eighteen runs. This is inside the first row. Merge and subsequent encoding remain primarily serial.

Low-level **exclusive thread-wall / thread-CPU sums, seconds**:

| Low-level component                                             | The released project |           The 1× project |
| --------------------------------------------------------------- | -------------------: | -----------------------: |
| Snapshot open/header processing                                 |        0.022 / 0.031 |            0.021 / 0.047 |
| Snapshot section reads                                          |        0.154 / 0.047 |            0.061 / 0.078 |
| Section decode, validation and other load work, excluding reads |        4.584 / 4.375 |            2.519 / 2.422 |
| ID remapping and column bytes                                   |        0.112 / 0.141 |            0.096 / 0.094 |
| Codec selection and column transforms, excluding compression    |        0.121 / 0.094 |            0.064 / 0.062 |
| Zstd compression, including codec samples                       |        0.747 / 0.719 |            0.275 / 0.188 |
| Payload and final snapshot writes                               |        0.164 / 0.250 |            0.059 / 0.125 |
| Snapshot and manifest fsync                                     |        0.060 / 0.031 | 0.030 / below resolution |

Staged input sizes were **278,817,332 / 81,202,784 bytes**; emitted snapshots were
**60,591,660 / 8,336,740 bytes**. Cumulative stored-section reads were 584,379,222 / 138,541,964 bytes,
and decoded raw reads were 2,039,395,664 / 1,909,780,238 bytes. There were 37 / 38 snapshot
finishes/verifications. Reading in the broad sense includes decompression, CRC and string validation;
pure section read calls account for only 0.154 / 0.061 s. The measured difference is CPU work in
collection/merge and staged decoding, not fsync waiting.

### Limits and verification

One instrumented run per project is descriptive, not a distribution or a speed claim. No filesystem
cache flush, external sampling profiler, device I/O tracing, or per-stage memory attribution was
performed. Snapshot byte counters count repeated loads, output verification and finished snapshot
sizes; they do not measure physical device traffic or every temporary sort-run/dictionary-stream
byte. The staging timer does not separate JSON serialization, group lookup and buffered writes.
Low CPU/large thread-wall sums in parallel compression are observed; their scheduler/allocator/wait
cause was not sampled and is not established here.

Validation passed: 42 distinct targeted Rust tests covering process counters, probes, snapshots,
dictionaries, stores, builders, join collation/query helpers and project I/O; two native/TypeScript
join parity tests (including eight seeded cases plus the zero-key regression);
`cargo clippy --locked -p process-metrics -p game-text-index -p uasset-io --all-targets -- -D warnings`;
`pnpm -s run typecheck`; the UAsset architecture ownership check; and the locked release reader build. The portable full gate and Unreal
engine matrix were not run: this work changes no parsing or engine integration and the measurement
brief prohibited full suites and launching Unreal.
