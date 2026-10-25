# Game Text cold scan attribution

Where a cold Game Text scan spends its time and memory, measured on the generated 1× project and
the released project before Plan 059 Phase 4.5 changed anything. The native side covers the
reader and the native writer; the host side covers the TypeScript stages, inventory, memory and
cancellation.

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

Separating verification from reads: non-verification snapshot loads took 1.757 / 0.844 thread-seconds
wall / CPU on the released project and 1.604 / 0.953 on the 1× project. This includes staged inputs
and existing dictionary segments. Output verification itself took 5.900 / 1.062 and 5.179 / 0.734
thread-seconds, overlapping across workers. Non-verification load time is total `snapshot.load`
minus the child-span time of `snapshot.verify`; it therefore includes decode and validation, not
only the read system calls.

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
pure section read calls account for only 0.154 / 0.061 s. Staged-input loads, excluding output
verification, took 4.440 s wall / 4.172 s CPU and 2.464 s / 2.438 s, respectively. Output verification
was separately 0.299 s / 0.250 s and 0.118 s / 0.062 s. These are subdivisions of the tables above. The measured difference is CPU work in
collection/merge and staged decoding, not fsync waiting.

### Instrumentation-off control

One later fresh-cache build of the released project used the same `d12f4da7` release binary, host
stage recorder, flags and caps, with `UE_SHED_COLD_SCAN_MEASURE_DIR` unset. Output was
`E:\ue-shed-engine-scratch\p45-native-released-control-r2`. Reproduce with the command above in a new
output directory after `unset UE_SHED_COLD_SCAN_MEASURE_DIR` (omit creating that native directory).
The native side channel is disabled, so this control supplies host wall times, not native CPU
attribution.

| Host measurement         | Instrumented, s | Control, s | Observed difference |
| ------------------------ | --------------: | ---------: | ------------------: |
| Whole build              |         112.674 |    110.647 |              +1.83% |
| Extraction               |          37.576 |     35.689 |              +5.29% |
| Package publication      |           7.929 |      7.891 |              +0.48% |
| Localization publication |          13.619 |     12.726 |              +7.01% |
| Join                     |          15.774 |     15.411 |              +2.35% |

Peak process-tree RSS was 4,935,884,800 bytes instrumented versus 3,958,091,776 bytes in this control.
The measured numbers above describe the **instrumented** workload. One sequential pair cannot isolate
probe overhead from cache, scheduling and allocation/RSS variability, or establish a memory cause.
No causal overhead estimate or CPU correction is applied. There is no instrumentation-off 1× control.

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

## Host side

Measured on branch `perf/p45-host-probes`, instrumentation commit `7bb7b627` on top of
`a9a8fa95`, reader `uasset-p4-head.exe`, Node 26.12.0, `RAYON_NUM_THREADS=16`. Cold builds are
one run each through `scripts/benchmark-game-text-engine.ts --stages build --runs 1` with
`UE_SHED_GAME_TEXT_STAGES=1` (new output directory per run); probe scripts are committed beside
the harness. Another agent was measuring on the same machine, so absolute walls carry load
noise; splits inside one run are the reliable part. Facts observed are stated as such;
interpretations are marked as hypotheses.

### 1. Localization import split

`LocalizationSnapshot.importColdTarget` now annotates its span with
`localization.import.stage_ms.parse` (coordinator wall for the TS worker pool, including
`stat` of every input and worker startup/termination), `stage_ms.readers` (opening the staged
snapshot readers), `stage_ms.publish` (`writer.publishCold`), worker-busy sums
`stage_ms.worker_*Ms` (summed across files, so they exceed wall time), per-format file counts
and bytes, and the three slowest files (format, bytes, ms; no paths). The per-file stages come
from `prepareLocalizationFile`: positioned reads, SHA-256, `TextDecoder` decode (UTF-16LE when
the BOM says so, else UTF-8), `builder.feed` parsing, `builder.finish`, string-run preparation
(`prepareColdStringRuns`), and the staged snapshot write.

Released project, cold build 121.6 s total, import span 31.65 s:

| Measure                       |                                                              Value |
| ----------------------------- | -----------------------------------------------------------------: |
| Parse (wall, coordinator)     |                                                            15.50 s |
| Open staged readers           |                                                             0.02 s |
| `publishCold` (native writer) |                                                            16.12 s |
| Workers used / memory budget  |                                    8 / 21,958,305,792 B (20.4 GiB) |
| Files                         |                           1 manifest, 10 archive, 10 PO (21 total) |
| Input bytes                   | manifest 77.9 MB, archive 679.5 MB, PO 670.0 MB (1,427.4 MB total) |
| Slowest files                 |   PO 65.7 MB in 6.46 s; PO 66.5 MB in 6.39 s; PO 65.4 MB in 6.36 s |

Worker-busy split of the parse (97.3 s summed over 8 workers; wall 15.5 s, so mean
concurrency ≈ 6.3): parsing (`builder.feed`) 50.6 s, string-run preparation 28.3 s, staged
snapshot write 8.6 s, column finish 5.0 s, reading 2.1 s, decoding 1.9 s, hashing 0.9 s.
Reading, decoding and hashing together are about 5% of worker-busy time; the parse is not
I/O- or decode-bound on the host side.

Generated 1× project, cold build 70.7 s total, import span 22.19 s: parse 12.69 s, publish
9.48 s, readers 0.02 s; 8 workers, budget 22,638,108,672 B (21.1 GiB). Files: 1 manifest
(89.3 MB), 10 archive (891.4 MB), 10 PO (600.0 MB), 1,580.7 MB total. Slowest: three PO files
of 59.7 MB in 4.64 s, 4.59 s and 4.43 s. Worker-busy 79.4 s: parsing 44.9 s, string runs
20.3 s, snapshot write 5.3 s, finish 4.2 s, reading 1.9 s, decoding 1.8 s, hashing 1.0 s.

Not measured: per-culture breakdown beyond the slowest three (the recorder keeps only three,
by design), and worker startup cost separate from the first file each worker parses.

### 2. Package text, host side (released project)

`PackageText.refresh` 58.47 s = selection 0.52 s + read 44.03 s + import 13.92 s.

Read 44.03 s, decomposed from the same run's spans: the reader's
`unreal_assets.protocol_extract_text_packages` covered 37.82 s; `GameTextIndexSource.verify`
covered 6.12 s over 2 calls; host receive bookkeeping (`package-text.stage_ms.read_receive`,
the per-event shard-set insert and duplicate check on the coordinator) 0.29 s. The residual
is within rounding/overlap of covered-wall arithmetic (≈ −0.2 s). So of the ≈ 6.2 s the host
adds beyond the reader, about 6.1 s is bundle signature verification — `stat` of every
package plus its `uexp`/`ubulk`/`uptnl` sidecars, run before and after the single staged
reader batch (`index-source-node.ts`, `verify` at concurrency 16) — and about 0.3 s is
coordinator bookkeeping. On this path the reader stages records itself, so the host does no
record staging, sorting or hashing inside read. Selection (0.52 s, its own span) is the
SHA-256 shard-key hashing of all 167,401 inventory entries into 256 shards.

Import 13.92 s = TS worker prepare 5.46 s (`package-text.cold.stage_ms.prepare`: workers
convert the reader-staged groups, validate them against the inventory, sort and write shard
snapshots) + native `publishColdFiles` 8.46 s (`stage_ms.publish`). The coordinator residual
is 0.00 s at this precision: the previously unattributed ≈ 5.4 s of "host" time in import is
worker-thread CPU, not coordinator waiting.

On the generated 1× project the picture differs, as expected: read 9.75 s is records replay,
of which host staging (`read_stage`: `JSON.stringify` plus buffered NDJSON appends on the
coordinator) is 3.11 s; import 16.96 s = worker prepare 4.09 s + `publishColdFiles` 12.88 s.

### 3. Inventory: benchmark artefact, mostly

Released project, 167,401 packages. In the cold harness build, `GameTextIndexSource.inventory`
took 10.07 s: project-index refresh 6.06 s, status 0.33 s, inventory pages 3.69 s (the new
`inventory.stage_ms.*` marks; the earlier traced run showed 12.7 s with refresh at 9.4 s, so
the refresh itself varies). The warm probe (`scripts/game-text-warm-inventory-probe.ts`, one
pass per condition, same project-index cache directory reused with a fresh inventory cache in
the host) measured:

| Condition                            | Inventory | Refresh | Status |  Pages |
| ------------------------------------ | --------: | ------: | -----: | -----: |
| Cold project index                   |    9.73 s |  6.05 s | 0.36 s | 3.32 s |
| Warm, default (refresh still called) |    4.14 s |  0.57 s | 0.34 s | 3.23 s |
| Warm, `refreshProjectIndex: false`   |    3.70 s |  0.00 s | 0.34 s | 3.36 s |

The 12.7 s figure is therefore mostly a benchmark artefact. The harness builds its source as
`gameTextIndexSourceNodeLayer(cache)` with a brand-new cache per build and the default
`refreshProjectIndex` behaviour, so every cold build pays a cold native project-index refresh
(6–9.4 s observed). The Workbench pays neither that nor a per-scan refresh: it constructs the
source with `refreshProjectIndex: false` over a project-index layer shared with the rest of
the app (`apps/workbench/src/main/workbench-live.ts:154-161,191-193`), whose index is
maintained outside the Game Text scan. What a Workbench user does pay on a first scan in a
process is status + pages, ≈ 3.7 s at this project size: 164 project-index query pages plus
the host-side byte-order sort of 167,401 entries (`inventoryPages`). Within one process the
result is cached by project-index generation (`index-source-node.ts`, `Cache.makeWith`,
capacity 2, no expiry on success), so repeat scans at the same generation skip even that. The
CLI workflow (`apps/cli/src/workflows/game-text-index.ts:23`) uses the default source with a
stable cache root, so it pays the cold refresh only on its first-ever run against a project.

### 4. Why the stages are sequential

`GameTextIndex.prepareTarget` (`packages/game-text/src/index-steps.ts:697-732`) runs, inside
one `withSession` (lines 709-720): `importTarget` (712), then `refreshProject` (715), then
`buildTarget` (716). The join genuinely needs both inputs: `buildTarget` checks the package
generation/key against the manifest (`checkProject`, 641) and every imported file key against
the manifest (642-647) before joining. The localization import and the package refresh,
however, read disjoint inputs (authored localization files versus package inventory) and
publish disjoint layer names (file paths versus `package-text.*`); no value flows from one to
the other. What forces them to run one after another today:

1. One writer lease per project directory. Both publish into the same shared index directory:
   any explicit project view maps to the target key `shared-project-text-v1`
   (`packages/game-text/src/shared-index.ts:89-96`). `prepareTarget`'s outer `withSession`
   holds a per-directory semaphore of 1 (`index-steps.ts:317-320`, taken at 345-358), and the
   nested `withSession` calls in `importTarget`/`refreshProject`/`buildTarget` deliberately
   reuse that active session instead of acquiring another (331-343).
2. One native writer session behind the lease. The native builder's `withSession` checks out
   one pooled client, runs `begin` once, and hands every step the same leased writer
   (`packages/game-text/src/native-index-builder.ts:523-581`; session `end` at 468-483). A
   process returns to the pool only after a clean `end`; any failure or interruption
   invalidates it (499-501, 527-530). The localization cold import states the same ownership
   in its own comment: "The target owns the writer lock and parser pool until all staged
   layers are published" (`localization-cold-import.ts:82-92`, publish at 196), and the
   package layer likewise owns the writer across comparison, reads and publication
   (`package-text-layer.ts:178-183`).
3. Serialized native commands and shared mutable session state. Every native command goes
   through a semaphore-1 client (`packages/unreal-assets/src/game-text-index-client.ts:35,67`),
   and the session's manifest snapshot is a single mutable binding updated per command
   (`native-index-builder.ts:148-171`). The package refresh reads `writer.manifest()` once at
   its start (package-text-layer.ts:213) and later decides between `publishCold` and
   `publishBatch` from layer state (670-672); a concurrent localization publish interleaved
   between those points would make that snapshot stale.
4. Error handling and fallback. An import failure returns before any package is read
   (`index-steps.ts:712-714`), which also avoids the 58 s package stage for a bad target. The
   source-view fallback must run after the failed target session is fully released: "Native
   failures close their session; they must never be swallowed inside a still-leased writer"
   (726-731).
5. Memory budgeting assumes one cold pool at a time. Each pool sizes itself against half of
   `process.availableMemory()` (`cold-task-pool.ts:58`, used at
   `localization-cold-import.ts:114-120`); the package side starts up to 8 more workers
   (`package-text-cold.ts:48-58`), deliberately while the reader extracts
   (`package-text-layer.ts:402-404`). Running both pools at once would double-book the same
   memory budget — the released build already peaks at 4.4 GiB (below).
6. Progress and cancellation are single-scope. Both steps report through the one
   operation-scoped reporter with strictly ordered phases (`index-progress.ts:40-50`), and
   both live in the caller's one Effect scope, so one interruption tears down the whole
   prepare (each pool does handle its own abort: `localization-cold-import.ts:100-103`,
   `package-text-cold.ts:156-159`).

Conclusion: running the import and the package refresh concurrently is not safe as the code
stands, and the blocker is the shared writer session, not a data dependency. What would have
to change, in order: give each branch its own builder session (which today would contend for
the same native writer lease on one directory, so the native side would need either
per-branch writer processes with a merge, or a session that tolerates interleaved publishes
for disjoint layer names); stop the package refresh from deciding publish mode off a
start-of-step manifest snapshot; split the cold memory budget explicitly between the pools;
define which branch's failure wins and keep the release-before-fallback property; and keep
the join's stale checks after both branches complete. Progress reporting would survive
unchanged (the reporter accepts events in any order; hosts already render per-phase counts).

### 5. Memory (released project)

One cold refresh in-process (`scripts/game-text-cold-memory-probe.ts`), process tree sampled
with `Get-CimInstance Win32_Process` every 250 ms requested, ≈ 0.77 s achieved (each
enumeration costs most of the interval; a busy sampler skips rather than queues, so peaks are
lower bounds). Command lines were classified in the sampler and never recorded. Worker
threads (localization parsers, package converters) are threads of the Node process, so they
appear under Node main; native children split into one-shot `protocol` processes (reader,
project index) and `protocol-session` processes (writer, later the query engine).

Peak tree working set sampled: 4.40 GiB (the harness's own 1 s tree sampling of the cold
build run above recorded 4.38 GiB; the earlier traced run reported 4.5 GiB). The peak fell at
52.7 s, in the `packages` phase:

| Process at the peak                                | Working set | Processes |
| -------------------------------------------------- | ----------: | --------: |
| Native one-shot reader (extraction)                |    3.28 GiB |         1 |
| Node main (coordinator + package workers starting) |    0.88 GiB |         1 |
| Native session (writer, idle between publishes)    |    0.18 GiB |         3 |
| Other (sampler shells)                             |    0.04 GiB |         5 |

Per-role peaks over the whole build: the reader's 3.28 GiB during extraction is the global
peak's driver. Node main peaked earlier at 2.17 GiB during localization parsing (10.8 s; the
8 parser workers and their staged string runs live in this process), reached 1.95 GiB again
during `package_text` conversion and 1.61 GiB during `localization_publish`. The native
session (writer) peaked at 2.15 GiB late in `joining` (117 s). Phase maxima for the tree:
localization 2.29 GiB, packages 4.40 GiB, package_publish 2.47 GiB, joining 2.79 GiB,
opening 0.66 GiB. Hypothesis, not measured: the reader peak is its per-batch package working
set, since the host holds no record data on the staged path; confirming that is native-side
work. Not measured: the 1× project's per-process split (its tree peak was 2.67 GiB in the
harness run; the earlier traced run reported 2.6 GiB).

### 6. Cancellation

`scripts/game-text-cold-cancel-probe.ts`: a cold `GameTextIndexRefresh.refresh` on a fresh
cache per repetition, interrupted with `Fiber.interrupt` at a delay after the named progress
phase is first reported (localization parse: 1 s after `localization`; extraction: 5 s after
`packages`; join: 0.5 s after `joining`), three repetitions each, released project. "Interrupt
returns" is the wall time of `Fiber.interrupt`; "children idle" is measured from then until
no native child processes remain (the poll that found none also bounds the error to ≈ 1 s,
the cost of one process-tree enumeration); the second refresh runs immediately after, on the
same cache, in the same process.

| Interrupted during | Interrupt returns | Children exited/idle | Second refresh                  |
| ------------------ | ----------------: | -------------------: | ------------------------------- |
| Localization parse |       17, 5, 6 ms |   1.05, 1.05, 1.06 s | succeeds, 112.1, 114.1, 113.5 s |
| Package extraction |  287, 233, 196 ms |   1.10, 1.12, 2.19 s | succeeds, 85.3, 79.1, 73.2 s    |
| Join               |     71, 68, 74 ms |   2.75, 1.05, 1.03 s | succeeds, 19.8, 19.6, 19.7 s    |

Every interrupt returned in under 0.3 s and every child process was gone or idle within
about 1–2.8 s; no repetition left a wedged writer, and the immediate second refresh always
succeeded. Its duration tracks what the interrupted run had already published: after a join
interrupt both layer sets are published, so the second refresh only re-joins (≈ 20 s); after
an extraction interrupt the localization layers survive but packages are re-read; after a
parse interrupt nothing is published and the second refresh is a full cold build. Worker
threads are terminated by the pools' own abort handlers (section 4, item 6); the probe
observes them only through the Node process, which stayed responsive throughout — it fielded
the interrupt and the tree polls itself.

## Phase 4.5: host changes

### Method and retained baselines

Verified decisions 1 and 2 on `perf/p45-host-impl`, starting from `66e4b7e2`
(`c9082b05`, `c770bb40`, `66e4b7e2`). Verification corrected the new test's invalid
`buildTarget` argument and chained-Effect lint error, and formatting in four implementation
files. The accepted product design was unchanged. The stage recorder now retains span start/end
offsets; the cancellation probe requires child exit rather than idle CPU, excludes its sampler
shells, and propagates sampling failures. The memory probe closes its scope and omits the target
name from its report.

Baseline product sources were exactly `ea6b5cb0:packages/game-text/src`, restored in a temporary
detached worktree of `66e4b7e2`; the benchmark harness was this branch's decision-1 harness.
`git diff ea6b5cb0 -- packages/game-text/src` was empty there. Both worktrees rebuilt their
TypeScript packages before measurement. Both used Node 26.12.0, `RAYON_NUM_THREADS=16`,
`CARGO_BUILD_JOBS=8`, and the fixed `uasset-p45-base-native.exe` reader/writer, SHA-256
`65841e228d02d07eac4011eaf38d6522fcba5ed1b75da946e8f102797fb414cd`.
No Rust build or alternate reader/writer was used.

Each build ran once, with a new Game Text cache, through
`node scripts/benchmark-game-text-engine.ts --project "$project" --stages build --runs 1
--output "$out" --project-index-cache "$persistentIndex"`, with
`UE_SHED_GAME_TEXT_STAGES=1`. The 1× project additionally used
`--generated --records E:\ue-shed-engine-scratch\phase4\records-1x`.
The harness warmed the persistent project index outside the measured build; neither released
build recorded a native project-index refresh. Inventory's `refresh` mark was only 0.024 ms
of branch overhead in each. The generated source replays retained records instead of reading
packages. Fresh Game Text caches do not imply flushed OS filesystem caches.

All artifacts below are retained under
`E:\ue-shed-engine-scratch\p45-host-verify-20261026` (call this directory `$results`).
Baseline caches are exactly:

- `$results\baseline-released\caches\run-1`
- `$results\baseline-1x\caches\run-1`
- `$results\baseline-ue57\caches\run-1`
- `$results\baseline-ue58\caches\run-1`

Changed caches use the same suffixes with `changed-` instead of `baseline-`.
Persistent inventories are `$results\project-index-{released,1x,ue57,ue58}`.
Per-build spans are `<output>\run-1\build\stages.json`; numeric summaries are
`$results\summary.json`. Input paths and names are not included in this report.
The projects remained read-only. All heavy work ran sequentially under the shared
`E:\es-id-repairs-scratch\unreal.lock`; harnesses/probes acquired it themselves, and package
builds and targeted verification acquired it externally. No Unreal Editor, Perforce writes,
network service, push, PR or merge was involved.

### Cold-build stage tables

All values are seconds, one run per condition. Stages on different branches overlap, so columns
must not be summed to estimate total elapsed time. Localization parse/publication are the
coordinator's wall marks; package preparation is its worker-pool wall mark; native operations
are their host spans. Selection and the small read residual are shown to avoid hiding host work.

| Stage, the released project             | Baseline | Changed |
| --------------------------------------- | -------: | ------: |
| Package inventory (warm status + pages) |    3.184 |   3.683 |
| Localization parse                      |   14.679 |  22.712 |
| Localization publish                    |   12.943 |  17.524 |
| Package selection                       |    0.361 |   0.521 |
| Package extraction                      |   36.211 |  39.145 |
| Bundle verification (two calls)         |    6.070 |   6.007 |
| Other package read/staging              |    0.077 |   0.081 |
| Package prepare                         |    5.068 |   4.743 |
| Package publish                         |    7.778 |   7.832 |
| Join                                    |   15.391 |  15.157 |
| Open + first page / workspace residual  |    1.870 |   1.891 |
| Whole measured build                    |  104.160 |  79.350 |

| Stage, the 1× project                      | Baseline | Changed |
| ------------------------------------------ | -------: | ------: |
| Records inventory / refresh setup residual |    0.900 |   0.811 |
| Localization parse                         |   12.647 |  20.987 |
| Localization publish                       |    9.156 |   9.362 |
| Package selection                          |    0.270 |   0.250 |
| Package replay, including host staging     |    9.877 |  12.886 |
| Bundle verification                        |        0 |       0 |
| Package prepare                            |    4.045 |   4.125 |
| Package publish                            |   12.513 |  12.419 |
| Join                                       |   15.911 |  15.777 |
| Open + first page / workspace residual     |    1.946 |   1.939 |
| Whole measured build                       |   67.476 |  65.169 |

The open/page row is measured build time minus `GameTextIndex.prepareTarget` wall, so includes
workspace orchestration outside preparation. The generated inventory row is `refreshProject`
wall minus `PackageText.refresh` wall: retained-record inventory has no dedicated span, so its
small refresh bookkeeping is included. Remaining small setup/metadata publication costs are
inside the total, rather than assigned to a misleading inferred engine stage.

The changed released run's localization branch covered trace offsets 0.149–40.414 s; package
selection began at 3.892 s, and package read covered 4.413–49.647 s, including verification.
Thus 36.000 s of localization import overlapped package read. Its extraction span and localization
parse/publication retained independent spans. On the 1× project, localization covered
0.255–30.680 s and package replay 1.002–13.888 s: all 12.886 s of replay overlapped it.
The package publication gate then waited approximately 16.909 s (refresh span minus its charged
selection/read/import marks); released-project gate/bookkeeping residual was 0.001 s.
Package import/publication followed both reads in each trace.

Observed total reductions were 24.809 s (23.8%) and 2.307 s (3.4%). Localization parse was slower
under concurrency in both runs, and publication was slower on the released project. Overlap
still shortened total wall time; the generated project's localization branch remained critical.
These single pairs do not estimate a distribution, isolate contention causes, or establish a
repeatable speedup. No native reader/writer optimization is being measured here.

### Memory STOP and cancellation status

**STOP: the released project's process-tree peak exceeded the 6 GiB acceptance ceiling.**
The requested `scripts/game-text-cold-memory-probe.ts` measured **6,457,823,232 bytes
(6.014317 GiB)** at 19.141 s, last reported progress phase `packages`, while localization and
package extraction were both active. This exceeds 6,442,450,944 bytes by 15,372,288 bytes.
The probe included sampler-shell working sets, as the existing attribution does; subtracting
that overhead to turn a failing process-tree measurement into a pass would change the gate.

| Role at the peak              | Working set, bytes | Processes |
| ----------------------------- | -----------------: | --------: |
| Node coordinator + TS workers |      2,664,501,248 |         1 |
| Native one-shot reader        |      3,559,571,456 |         1 |
| Native sessions               |        186,200,064 |         3 |
| Sampler shells / other        |         47,550,464 |         5 |
| Total                         |      6,457,823,232 |        10 |

One refresh used a fresh external cache, `$results\memory-cache`; its artifact is
`$results\memory.json`. The probe used its existing default source, including a cold
project-index refresh, rather than the benchmark's separately warmed project index.
It requested 250 ms sampling and retained 134 samples at a mean interval of 647 ms; the sampled
peak is a lower bound. Progress labels interleave under concurrency, so `packages` is the last
reported phase, not a claim that localization was inactive. No claim is made about memory
distribution or repeatability from this single run.

The runner stopped immediately after reading this completed probe's result. No cancellation
probe was run, so interrupt return ≤0.5 s, child exit ≤3 s, and immediate successful refresh are
**unverified for this implementation**. No changed canonical-corpus build was started. The
completed measurement caches were inspected read-only afterward; no further cold measurement
or product optimization was attempted. The accepted design was not altered to work around
the STOP.

### Byte comparison of completed builds

`scripts/p45-host-layers.ts` replaces the unfinished identity-printing helper with an actual
comparison. It runs `cmp -s` on each corresponding shared-store file; for snapshots whose
embedded identity metadata differs, it compares every other section's descriptor and stored
compressed bytes directly. It also compares normalized current and previous roots, active
layer names/keys, complete layer records, dictionary descriptors, the store manifest, and
dependency-graph state, validates the graph checksum, and rejects unaccounted store files.
It does not print input identities. Reproduce against the retained completed caches with
`CMP_EXECUTABLE` pointing to `cmp`, then
`node --import tsx scripts/p45-host-layers.ts "$baselineCache" "$changedCache"`.

| Completed pair          |    Package layers | Localization + observation layers | Joined layers | Dictionaries | Stored data sections compared after whole-file differences | Result                         |
| ----------------------- | ----------------: | --------------------------------: | ------------: | -----------: | ---------------------------------------------------------: | ------------------------------ |
| Released project        |               256 | 43 (21 authored + 22 observation) |             1 |           22 |                                                     13,272 | Equal with exclusions below    |
| 1× project              |               256 | 43 (21 authored + 22 observation) |             1 |           22 |                                                     13,017 | Equal with exclusions below    |
| UE 5.7 canonical corpus | Baseline retained |                 Changed not built |             — |            — |                                                          — | Not verified after memory STOP |
| UE 5.8 canonical corpus | Baseline retained |                 Changed not built |             — |            — |                                                          — | Not verified after memory STOP |

Each completed pair accounted for all 327 shared-store files: 22 dictionary snapshots were
whole-file byte-identical; 305 files differed only in the explicitly normalized identity
metadata/framing. Every package, localization and joined data column, and every dependency-graph
data page, had identical stored bytes. Full paired physical filenames for all 305 metadata-only
differences are retained in `$results\identity-released.json` and `identity-1x.json`.
There were **no unexplained data differences** in the completed pairs.

Exact exclusions, all arising from fresh-store identity rather than authored content:

- Store/root `generation`, layer `storeGeneration`, `join.meta.generation` and
  `graph.meta.generation`. These are native timestamp/PID/sequence tokens (`store.rs:token`).
- Physical root/layer/dictionary/base filenames and references: manifest `physicalSnapshot` /
  `previousSnapshot`, layer `file`, dictionary segment `file`, graph-state `base`.
  Both referenced roots and every referenced payload were still compared.
- The generation-derived `joined-native-v8:*` key, consistently in active pointers, the layer-map
  key, its record, and graph-state `revision`. Native `join.rs` includes generation in this hash;
  all actual join inputs/dependencies/metadata were retained in comparison.
- Layer-record `bytes` (physical file size), metadata-section compressed payloads and their
  length/checksum/framing, whole-snapshot header/directory checksums/lengths, and section offsets.
  These reflect token/file-name lengths and their compression. All non-metadata section fields
  except relocated offsets, and all their stored payload bytes, were compared exactly.
- The dependency-state envelope checksum was validated separately in each cache; it hashes
  generation, revision and base filename, so was not compared across caches.

No authored file timestamps, source strings, string IDs, column values, layer input keys other
than the generation-derived joined key, dictionary boundaries, or graph moves were excluded.
The shared-store comparison does not cover external stat-cache/staging bookkeeping, project-index
caches, benchmark timing logs or memory samples: those are disposable host/measurement artifacts,
not the requested published package/localization/joined snapshots and dictionaries.

The four-input byte-identity gate is therefore **incomplete**, and the memory gate **failed**.
This branch is not accepted by this verification run.

### Verification and disposition

Passed with the fixed base reader set for every Vitest invocation:
`index-*.test.ts`, `localization-*import*.test.ts`, `package-text-*.test.ts`, including
`index-concurrent.test.ts`, plus `scripts/game-text-stage-timings.test.ts`: **17 files,
86 tests**. `pnpm -s run typecheck` passed after rebuilding the TypeScript packages.
`pnpm -s run check:static` passed, including its 336 architecture tests; existing lint
warnings remain. `git diff --check` passed. The full suite, Rust builds/tests, Unreal Editor,
fixture/fuzz/export acceptance runs, and Phase 4.5's final three-run measurement matrix were
not run: this task changes only TypeScript host code and verification tooling, and the memory
STOP prevents claiming complete acceptance. The temporary detached baseline worktree was removed;
all baseline measurement caches remain available at the paths above.
