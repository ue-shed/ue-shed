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

## Writer parallelization

Measured 2026-10-26 on `perf/p45-writer`, base `ea6b5cb0`. The unchanged base was
built first in the assigned worktree with `cargo build --locked --release -p uasset-io`
and preserved as `uasset-p45-base-writer.exe`. The three implementations are
`4b6f03a1` (join), `f96158fb` (package strings), and `b62df9f8` (localization layers).
[Numeric measurements](game-text-scan-writer-measurements.json) retain every native bounded
checkpoint, host stage totals, measured commit, memory peak and parity count.

### Measurement method

One fresh-cache cold build per project at the base and after each implementation; Node 26.12.0,
`RAYON_NUM_THREADS=16`, `CARGO_BUILD_JOBS=8`, `UE_SHED_GAME_TEXT_STAGES=1`, and
`UE_SHED_COLD_SCAN_MEASURE_DIR=<output>/native`. Builds and heavy runs were sequential under
`E:/es-id-repairs-scratch/unreal.lock`; the input projects were read-only. No OS cache flush,
Unreal Editor, Perforce writes or network services.

The benchmark command was `node .tmp/p45-benchmark.ts --project "$project" --stages build
--runs 1 --output "$out"`, adding `--generated --records <retained-records>` for the 1× project.
The ignored harness copy uses the checked-in harness, with measurement-only adjustments: warm
the project index outside the timer and construct the measured source with
`refreshProjectIndex: false`. The final released run also uses the specified 6 GiB RSS stop instead
of the default 20 GB cap. Product TypeScript is unchanged. Reader executables and
outputs are under `E:/ue-shed-engine-scratch`, named `uasset-p45-writer-{join,package,localization}.exe`
and `p45-writer-{base,join,package,localization}-{1x,released}`.

### Each implementation, against its preceding measurement

Cells are **native wall seconds / process CPU seconds / average occupied cores**.

| Implementation           | Project  |                 Before |                  After |
| ------------------------ | -------- | ---------------------: | ---------------------: |
| Join                     | 1×       | 18.661 / 27.359 / 1.47 | 16.376 / 29.156 / 1.78 |
| Join                     | released | 19.668 / 29.875 / 1.52 | 15.198 / 30.063 / 1.98 |
| Package publication      | 1×       | 13.913 / 17.094 / 1.23 |  8.574 / 16.922 / 1.97 |
| Package publication      | released |  8.528 / 11.719 / 1.37 |  6.559 / 12.547 / 1.91 |
| Localization publication | 1×       |  9.947 / 13.281 / 1.34 |  7.156 / 14.813 / 2.07 |
| Localization publication | released | 13.681 / 16.594 / 1.21 |  9.343 / 17.281 / 1.85 |

Join dependencies: finished marks feed query columns; translation search reads those same finished
inputs independently of the other query columns. Finished query columns then feed independent
places, summary and graph builders. Columns are appended in the original order and graph commit
waits for all branches. The dependency graph is documented beside the code.

Package collection deduplicates per layer, then sorts the domain unions in parallel. Only the
original first-seen domain traversal assigns shared IDs, using the same byte ordering. Mapping
reads the completed lookup per layer in parallel, including releasing each layer's local strings.
Localization leaves collection, sorted-run merge and dictionary ID assignment unchanged; each
encoder owns its reader, payload and output file, and records are folded in input order.

The original stage labels remain. New measured work includes
`publication.collect_strings_parallel`, per-thread `publication.collect_layer`,
`publication.sort_domain`, `publication.map_layer`, `join.query_parallel`, and
`dictionary.encode_layer_parallel`. Process CPU within overlapping branch intervals includes
the other branches: those intervals must not be added. Whole-request CPU remains additive.

| New or combined work                | Project  | Wall / CPU / cores, s |
| ----------------------------------- | -------- | --------------------: |
| Parallel query columns              | 1×       | 5.148 / 15.469 / 3.01 |
| Places + summary + graph            | 1×       |  2.171 / 3.422 / 1.58 |
| Collect and sort strings            | 1×       |  0.427 / 3.313 / 7.76 |
| Assign dictionary IDs               | 1×       |  5.902 / 5.875 / 1.00 |
| Map layer strings                   | 1×       |  0.235 / 2.063 / 8.78 |
| Encode localization layers and root | 1×       |  0.449 / 4.469 / 9.96 |
| Parallel query columns              | released | 4.105 / 16.266 / 3.96 |
| Places + summary + graph            | released |  2.332 / 3.703 / 1.59 |
| Collect and sort strings            | released |  0.238 / 2.094 / 8.81 |
| Assign dictionary IDs               | released |  3.483 / 3.469 / 1.00 |
| Map layer strings                   | released |  0.274 / 1.141 / 4.17 |
| Encode localization layers and root | released |  0.638 / 6.000 / 9.41 |

### Complete cold build

Stage walls in seconds, matching the specification's pipeline table. 1× package read is retained
record replay; its verification and inventory are not native package operations. Open/first page
is the sum of target-open and the first-page search/search-rows wrappers. Host setup, selection,
metadata publication, transport and cleanup account for the remaining wall; the rows are not a
replacement for the complete build timer.

| Stage                              | 1× base | 1× final | Released base | Released final |
| ---------------------------------- | ------: | -------: | ------------: | -------------: |
| Package inventory                  |       — |        — |         3.786 |          3.131 |
| Localization parse                 |  13.031 |   12.762 |        15.712 |         15.600 |
| Localization publish               |  10.093 |    7.156 |        14.691 |          9.343 |
| Package extraction / replay        |  10.650 |    9.961 |        41.008 |         36.685 |
| Bundle verification                |       — |        — |         5.890 |          6.129 |
| Package prepare                    |   4.529 |    4.006 |         5.625 |          5.104 |
| Package publish                    |  17.322 |    8.582 |         9.998 |          6.273 |
| Join                               |  18.661 |   15.455 |        19.668 |         15.008 |
| Open and first page                |   1.802 |    1.444 |         1.481 |          1.490 |
| Whole build                        |  79.164 |   61.812 |       120.301 |        100.896 |
| Peak process-tree working set, GiB |   2.694 |    3.132 |         4.277 |          4.037 |

One run per revision/project is descriptive. Filesystem cache, scheduling and allocation noise
remain; this is not the final three-run campaign. Native checkpoints show the intended overlap
and reduced serial publication work independently of whole-build variation.

### Byte identity

The base and each implementation's benchmark caches were paired by logical layer and dictionary
position, then compared with Git Bash `cmp -s`. The final implementation was also cold-built
and compared on both unchanged canonical UE 5.7 and UE 5.8 corpora.

| Revision     | Corpus   | Raw identical files | Files with only volatile metadata | Non-metadata stored sections compared | Unexplained differences |
| ------------ | -------- | ------------------: | --------------------------------: | ------------------------------------: | ----------------------: |
| join         | 1x       |                  22 |                               305 |                                 13017 |                       0 |
| join         | released |                  22 |                               305 |                                 13272 |                       0 |
| package      | 1x       |                  22 |                               305 |                                 13017 |                       0 |
| package      | released |                  22 |                               305 |                                 13272 |                       0 |
| localization | 1x       |                  22 |                               305 |                                 13017 |                       0 |
| localization | released |                  22 |                               305 |                                 13272 |                       0 |
| localization | ue57     |                  15 |                                69 |                                  2295 |                       0 |
| localization | ue58     |                  15 |                                69 |                                  2295 |                       0 |

Every differing physical filename is listed in each output's `parity.json`. Dictionaries match
byte for byte. Every other non-metadata stored section matches byte for byte, including compressed
payloads, codecs, counts and checksums. The comparison checks joined, package-text, localization,
dependency graph, current/previous root snapshots, root records and the publication manifest.

Allowed exclusions are the generation token and generated physical filenames embedded in
`shared.meta`, `join.meta`, `index.meta`, `graph.meta`, manifest references and graph state;
joined keys derived from that generation; and layer byte lengths affected by compressed metadata.
Dependency-state checksums are verified before normalizing their token-bearing state. Input
layer keys must match exactly. Metadata is compared after substituting only those known references;
no authored value, ID, row, policy, dictionary ordering or data column is excluded. Directory names
are paired by stable store identity. Other cache directories contain empty staging directories or
host/project-index bookkeeping rather than snapshots changed by the writer.

### Validation and limits

- `cargo test --locked -p game-text-index -- --test-threads=1`: 147 passed, 3 opt-in tests ignored (generated line-break vectors and two retained-cache timing probes).
- `cargo clippy --locked -p game-text-index --all-targets -- -D warnings`.
- Five targeted Vitest files, 18 tests: native/TS join parity, persisted differential fuzz seeds, native index builder integration and regressions, and native package delta integration. Every Vitest invocation set `UE_SHED_UASSET_EXECUTABLE` to the freshly built reader; final checks use `uasset-p45-writer-localization.exe`. An earlier join-only run also passed its 10 tests.
- `pnpm -s run typecheck`, `pnpm -s run check:static`, `cargo fmt -p game-text-index -- --check`, and `git diff --check`.

Checks used one Rust test thread and one Vitest worker, with their process tree restricted to sixteen logical processors, separately from the timed builds.

The one/four-worker dictionary regression compares every layer, dictionary, root snapshot and
index manifest byte for byte with fixed filenames and generation, across two sort-run budgets.
The default native join test retains its eight seeds and zero-key case. No full suite, Unreal
engine launch, export remeasurement, cancellation remeasurement or final three-run campaign was
performed; those are outside this writer implementation's assigned verification. No STOP condition was observed in the assigned measurements and checks.

## Reader implementation: staged byte identity STOP

Resolved by specification commit `ea021798` (cherry-picked here as `f85d59a4`): staging
compares sorted record lines per group, while package snapshots retain the byte gate with
explicitly identified publication-metadata exclusions. The evidence below records the original
ordering conflict.

Investigated 2026-10-26 on `perf/p45-reader`, unchanged base
`ea6b5cb024efe7960c6393d1959100826e066a9e`. No product code was changed. Decision 3's
requirement to preserve the base reader's exact order within every staging file cannot be
satisfied by retaining the current completion-order scheduler: the base itself does not
produce repeatable staging bytes for an identical request.

### Reproduction and evidence

Built the unchanged base with `cargo build --locked --release -p uasset-io`, holding the
shared heavy-job lock, with `CARGO_BUILD_JOBS=8` and `RAYON_NUM_THREADS=16`. Copied the result
to `E:\ue-shed-engine-scratch\uasset-p45-base-native.exe`; its SHA-256 is
`65841e228d02d07eac4011eaf38d6522fcba5ed1b75da946e8f102797fb414cd`.

Ran this binary's `protocol` command twice sequentially under the same lock, with the exact
same JSON request bytes: protocol v1.19, operation `extract_text_packages`, concurrency 8,
all 47 sorted explicit package paths from
`E:/ue-shed-fixture-scratch/p1-canonical-ue57-facts/Content`, and staging group 0 for every
path. After each request, renamed the staging directory so the next request could recreate
it at the identical path. The request SHA-256 is
`7eeb4901eaee2026368e1092a07e67c6f0e51af56cba0306c90639c3ab61130a`.

Both requests exited successfully and produced 158,577 bytes / 47 NDJSON lines:

- First file SHA-256: `c8eefc510b7128cb9b02ca44199e6f17aec07a2ca79e47e19fb7f602b985bbcd`.
- Second file SHA-256: `ae0b5096ac7fc726cb12c04e8689e4dd8ad8ba389b1c097ebb72409d3f09f2c0`.
- `cmp target/p45-reader/staging-1/0.ndjson target/p45-reader/staging-2/0.ndjson`
  returned 1: `differ: byte 44, line 1`.
- Sorting the complete record lines in memory yielded exactly equal arrays; no record
  contents differed. This diagnoses the ordering issue; it does not pass the byte gate.
- No timestamps, random filenames, or other bytes were excluded from this comparison.

The request, reproduction scripts, and both original staging files remain in the ignored
`target/p45-reader/` directory of this worktree. Neither benchmark project was accessed.

### Code cause and required decision

In `crates/uasset-io/src/direct_executor/project_io.rs:637`, staging sets `ordered` to false.
The unordered branch receives the next completed worker result at line 948, consumes and
stages it at line 949 (through line 647), and only then refills the window at line 951.
Consequently, group-file line order follows worker completion order. The existing staging
test explicitly acknowledges completion order at line 2662 and sorts both line collections
at lines 2679-2680 before asserting equality.

Moving serialization to workers and refilling before writing changes completion timing;
there is no stable base order for the implementation to reproduce. Introducing an ordered
staging contract, or allowing order-insensitive staging comparison while retaining strict
snapshot byte comparison, needs a specification decision. Neither alternative was implemented.

Stopped before optimization, worker-count selection, or performance measurements. No
before/after speed or snapshot-parity claim is made. Benchmark-project and UE 5.8 corpus
comparisons, snapshot comparisons, the worker sweep, and cancellation measurements were not
run because the exact-staging-order requirement already fails on the unchanged base.

### Verification of this report

- The unchanged release build and both canonical extraction requests succeeded.
- `pnpm -s run typecheck` passed using Node 26.12.0.
- `pnpm -s run check:static` failed at `format:check` on the pre-existing formatting of
  `crates/process-metrics/Cargo.toml`; that file has no diff on this branch. Later checks in
  that command did not run. The edited report passes its targeted formatter check.
- No crates were edited, so no Rust unit-test or clippy run was needed for this report.
  No vitest run, full suite, Unreal Editor, Perforce write, push, PR, or merge was performed.

## Reader implementation: coordinator scheduling and initial sweep

Implemented in `c58fe204` on `perf/p45-reader`, following the revised staging gate imported as
`f85d59a4`. Workers resolve their staging group, serialize the unchanged event plus newline,
apply the existing record-size bound, and replace the large event with its small staged-result
frame before delivery. The coordinator appends finished bytes and emits that frame. Both
ordered and completion-order delivery refill their bounded window before consuming a result.
The `extract.serialize` probe reports worker preparation separately from coordinator
`extract.staging`. Regression tests cover refill before consumption and exact-root precedence
in group lookup; existing staging, cancellation, ordering and consumer-failure tests still pass.

The sweep stopped at 16 workers: the sampled process tree reached **6.214 GiB**, exceeding the
specification's 6 GiB STOP threshold. The memory guard killed the complete harness process tree,
verified its ownership of the shared lock before removing it, and left no reader processes.
The reader itself reached **5.095 GiB**, also exceeding the 5 GiB eligibility limit. Default
selection was initially paused at eight workers. A subsequent owner decision classified
sixteen workers as ineligible, approved twelve as the fastest eligible count, and deferred
the combined-branch whole-tree gate to final measurements. Completion is recorded below.

### Measurements and method

One cold build per completed condition, Node 26.12.0, `CARGO_BUILD_JOBS=8`,
`RAYON_NUM_THREADS=16`, stage recorder and `UE_SHED_COLD_SCAN_MEASURE_DIR` enabled. Every build
and heavy check was sequential under the shared lock. The unchanged base was built first from
`ea6b5cb0`; the executable hashes and anonymous numeric results are in
[reader measurements](game-text-scan-reader-measurements.json). No OS filesystem cache flush
was performed. One sample per condition describes these runs rather than a timing distribution.

Runs used `scripts/benchmark-game-text-engine.ts --stages build --runs 1`, fresh external
outputs under `E:/ue-shed-engine-scratch/p45-reader-*`, and the same source inputs. Benchmark
project selection stayed in memory from the supplied environment file. The 1× project replayed
`phase4/records-1x`. A measurement-only Node preload set the existing protocol
`limits.concurrency` to 8, 12 or 16 for package extraction; other requests were unchanged.
The preload retained temporary package staging files with hard links at cleanup. It did not
change product code or snapshot contents. Reproduction, comparison and sampling scripts remain
in this worktree's ignored `target/p45-reader/` directory.

An external sampler classified process command lines in memory and retained only PID, parent
PID, role and working set, requesting a sample every 250 ms without overlapping enumerations.
Enumeration latency makes recorded peaks lower bounds. The whole-tree peak below is the
sampler's peak, which was higher than the harness's coarser measurement. Reader peak is the
largest one-shot native process working set; extraction dominates the released-project runs.
The 16-worker run was terminated at the first sampled whole-tree value over 6 GiB; its full
extraction wall, CPU and stage totals are unavailable.

The harness on this branch still pays a cold project-index refresh. The separate host benchmark
change from specification decision 1 was not part of this reader change. Inventory numbers
therefore include that refresh and should not be read as Workbench inventory cost.

All durations below are seconds. Worker wait and serialization are summed thread time, while
extraction is elapsed request wall / process CPU. Coordinator staging no longer includes JSON
serialization. Windows CPU counters are quantized, so the 8-worker append CPU of 0.000 means
below the measured resolution.

| Reader condition    | Extraction wall |     CPU | Average cores | Worker wait | Coordinator staging wall / CPU | Worker serialization wall / CPU | Reader peak, GiB | Tree peak, GiB |
| ------------------- | --------------: | ------: | ------------: | ----------: | -----------------------------: | ------------------------------: | ---------------: | -------------: |
| Base, 8 workers     |          39.191 | 214.125 |         5.464 |      88.061 |                22.357 / 21.156 |             Included in staging |            3.390 |          4.348 |
| Changed, 8 workers  |          31.718 | 218.469 |         6.888 |       0.911 |                  0.480 / 0.000 |                 24.697 / 22.844 |            3.683 |          4.889 |
| Changed, 12 workers |          26.087 | 231.688 |         8.881 |       1.243 |                  0.498 / 0.031 |                 26.509 / 22.516 |            4.875 |          5.984 |
| Changed, 16 workers |         Stopped |       — |             — |           — |                              — |                               — |            5.095 |          6.214 |

The separate serialization probe recorded work on eight and twelve worker threads, respectively.
At the unchanged count of eight, extraction wall fell 19.1%, worker wait fell from 88.061 to
0.911 thread-seconds, and coordinator staging fell from 22.357 to 0.480 seconds. Total CPU
rose from 214.125 to 218.469 seconds; the result is improved scheduling, not reduced decoder work.

Host stages corresponding to specification §1, in seconds:

| Stage                     | Released base | Released changed, 8 | Released changed, 12 |       1× base |
| ------------------------- | ------------: | ------------------: | -------------------: | ------------: |
| Package inventory         |         9.443 |               9.455 |                9.242 |             — |
| Localization parse        |        15.080 |              15.031 |               15.057 |        12.672 |
| Localization publish      |        14.160 |              14.064 |               13.880 |        10.169 |
| Package read / extraction |        39.382 |              31.925 |               26.281 | 10.369 replay |
| Bundle verification       |         6.076 |               5.964 |                5.955 |             — |
| Package prepare           |         5.150 |               5.367 |                5.173 |         4.007 |
| Package publish           |         9.040 |               9.988 |                8.624 |        13.868 |
| Join                      |        17.930 |              17.534 |               16.903 |        17.510 |
| Open and first page       |         1.936 |               1.950 |                1.954 |         2.063 |
| Whole measured build      |       119.317 |             112.405 |              104.164 |        72.355 |

Open/first-page time is the sum of the non-overlapping open-target, native-search and
native-search-rows spans. The stage table omits small selection, metadata publication and
coordination costs; its rows do not sum exactly to the whole build. Changes outside extraction
are single-run variation, not optimizations to those stages. No changed 1× build was run after
the STOP.

### Parity and explicit exclusions

Before changing the reader, two fresh-cache cold builds of the UE 5.7 canonical corpus used the
unchanged base executable. All 44 package layers had identical stored data-section bytes and
identical deterministic section metadata; all 15 shared dictionary segments were whole-file
byte-identical under `cmp` after matching them by segment position.

Physical published layer files contain generated metadata. In the unchanged store,
`crates/game-text-index/src/store.rs:15-24` builds tokens from time, PID and sequence;
`store.rs:615-617` writes the generated self-filename and store generation into `shared.meta`.
Consequently, none of the 44 whole layer containers was byte-identical between those baseline
builds. The comparison excluded exactly `shared.meta.file` and `shared.meta.storeGeneration`,
including their encoded metadata bytes/checksums, while comparing every stored package-data
section, its codec/count/checksum/domain metadata, section order and every other shared metadata
field. Root snapshots and manifests carry those generated file references and generation tokens
and were excluded from whole-file equality. This is a data-byte and deterministic-metadata
parity result with explicit publication-metadata exclusions.

Both completed changed-reader runs on the released project passed the same comparison against
the base: **256 package layers**, no data-section or deterministic-metadata differences, and
**22 whole-file-identical dictionary segments**. Their retained staging files matched all
**15,612 complete record lines in each corresponding group across 256 groups**, after sorting
lines per file. No records, fields, or bytes within a record line were normalized or omitted.
The staging order remains completion order, as required by the revised specification.

Detailed `cmp` reports list every differing physical layer filename and its logical package
layer in `E:/ue-shed-engine-scratch/p45-reader-parity-base-c57.json`,
`p45-reader-parity-sweep-8.json` and `p45-reader-parity-sweep-12.json`. All listed differences
were confined to the generated publication metadata above. The original caches, staged files,
host spans and native probe records remain under their `p45-reader-*` output directories.

Baseline cold builds of both canonical corpora and the 1× project completed. The STOP occurred
before changed-reader canonical snapshot builds, the changed 1× build, finalized default
selection or cancellation measurement. No joined/localization snapshot or export parity claim
is made here. Those outstanding comparisons and the final multi-run measurement remain undone.

### Verification after the memory STOP

Passed: the locked release build; `cargo test --locked -p uasset-io` (129 passed, one ignored
crash-writer helper); `cargo clippy --locked -p uasset-io --all-targets -- -D warnings`;
`cargo fmt --all -- --check`; UAsset architecture ownership; `pnpm -s run typecheck`; and
30 targeted Vitest tests in `scripts/package-text-reader.test.ts` and
`packages/game-text/src/package-text-cold.test.ts`, with `UE_SHED_UASSET_EXECUTABLE` set to the
freshly built implementation reader. Four lightweight native fixture requests additionally
compared base/head sorted staged lines on both canonical corpora: 47 records in one group on
each, exactly equal. These were record checks, not additional cold-build measurements.

`pnpm -s run check:static` ran once after the specification cherry-pick and failed at
`format:check`. It listed the unchanged `crates/process-metrics/Cargo.toml` and table alignment
in this report. The report formatting was corrected and verified afterward. A direct rerun
of the failing formatting command still reports the pre-existing Cargo manifest issue; later
commands in `check:static` did not run. The Cargo manifest has no diff on this branch.

The initial memory STOP left default selection and the remaining before/after snapshot builds
incomplete at this point. The subsequent owner-authorized completion is recorded below. No
cancellation experiment was run. Nothing was pushed, merged or opened as a PR; no Unreal
Editor, Perforce write or network service ran.

Exact output of the final direct formatting check:

```text
$ oxfmt --check .
Checking formatting...

crates/process-metrics/Cargo.toml (0ms)

Format issues found in above 1 files. Run without `--check` to fix.
Finished in 2769ms on 2465 files using 32 threads.
[ELIFECYCLE] Command failed with exit code 1.
```

## Reader implementation: selected default and completed parity

The owner decision treats sixteen workers as ineligible because its reader exceeded 5 GiB;
that run's whole-tree limit does not block this reader change. Twelve is the fastest eligible
count from the 8/12/16 sweep, and eight is outside 5% of its wall time. Commit `2f57f214` raises
the existing machine-derived default's upper bound to **12** and adds the requested one-sentence
measurement comment. Explicit `limits.concurrency` remains supported. The combined localization
and extraction whole-tree gate belongs to the owner's final measurements.

Rebuilt with `cargo build --locked --release -p uasset-io` under the shared lock, then ran one
fresh-cache cold build of the released project with the rebuilt reader and **no protocol
concurrency override**. The native probes recorded twelve extraction workers and twelve
serialization threads. The new executable's SHA-256 is
`996d5ed0adf1f82c9186e1d959c8b7ffcb1b22cd9597a3825d43094701ee3e56`.
The previous eight-worker implementation binary is retained as
`E:/ue-shed-engine-scratch/uasset-p45-reader-8.exe`. The unchanged base executable and caches
were reused; they were not rebuilt or overwritten.

Same harness, recorder, sampler and caps as above: Node 26.12.0, `CARGO_BUILD_JOBS=8`,
`RAYON_NUM_THREADS=16`, `UE_SHED_GAME_TEXT_STAGES=1`, native attribution enabled, one heavy job
at a time under the shared lock. The sampler recorded the whole-tree peak without applying its
previous 6 GiB stop guard, as directed. The localization branch is still sequential here.
These are single-run observations, and the memory peaks remain sampled lower bounds.

Released-project host stage table, seconds:

| Stage                                   | Unchanged base, 8 | Rebuilt default, 12 |
| --------------------------------------- | ----------------: | ------------------: |
| Package inventory                       |             9.443 |               9.615 |
| Localization parse                      |            15.080 |              15.098 |
| Localization publish                    |            14.160 |              15.045 |
| Package extraction, including transport |            39.382 |              26.215 |
| Bundle verification                     |             6.076 |               5.916 |
| Package prepare                         |             5.150 |               5.347 |
| Package publish                         |             9.040 |               8.756 |
| Join                                    |            17.930 |              16.875 |
| Open and first page                     |             1.936 |               1.919 |
| Whole measured build                    |           119.317 |             105.951 |

Native extraction wall was **26.023 s**, process CPU **230.984 s**, and average occupied cores
**8.876**, versus **39.191 s / 214.125 s / 5.464** in the base. Worker wait was **1.616 summed
thread-seconds**, versus **88.061**; coordinator staging was **0.503 s**, versus **22.357**.
Worker serialization consumed **26.492 summed thread-seconds / 23.469 CPU seconds**, separately
visible in the recorder. The rebuilt default's reader peak was **4.853 GiB** (5,211,193,344 bytes)
and its sampled process-tree peak **5.810 GiB** (6,238,941,184 bytes). The harness's coarser peak
and all anonymous counters are retained in [reader measurements](game-text-scan-reader-measurements.json).

### Completed comparisons

Each canonical corpus was cold-built once with the rebuilt default, in fresh caches, and
compared to its existing unchanged-base cache. The comparison method and generated-publication
metadata exclusions are exactly those established in the base-vs-base check above:

- **UE 5.7 canonical corpus:** 44 whole prepared package snapshots passed `cmp`; the 44 published
  package layers had identical stored data and deterministic metadata; all 15 dictionary
  segments were whole-file byte-identical.
- **UE 5.8 canonical corpus:** 44 whole prepared package snapshots passed `cmp`; the 44 published
  package layers had identical stored data and deterministic metadata; all 15 dictionary
  segments were whole-file byte-identical.
- **Released project, rebuilt default:** 256 published package layers had identical stored data
  and deterministic metadata; all 22 dictionary segments were whole-file byte-identical.
  Sorting complete record lines per staging group matched all 15,612 records across 256 groups.

No unexpected difference occurred. Published physical layer containers continue to differ only
in generated `shared.meta.file` and `shared.meta.storeGeneration`, including the dependent
metadata bytes/checksums. Whole prepared canonical snapshots and dictionaries need no content
exclusions. Root containers/manifests carry generated references and remain excluded as above.
The file-by-file reports list every differing physical layer filename:
`E:/ue-shed-engine-scratch/p45-reader-parity-default12-released.json`,
`p45-reader-parity-default12-c57.json`, and `p45-reader-parity-default12-c58.json`.

Fresh outputs, raw native probes, host spans, memory samples and retained staging files are in
`E:/ue-shed-engine-scratch/p45-reader-default12-released`, `p45-reader-default12-c57` and
`p45-reader-default12-c58`. There was no additional 1× run: it replays records and has no native
extraction, so it was skipped as directed. Earlier 1× baseline numbers remain historical data.

Final checks against the rebuilt default passed: `cargo test --locked -p uasset-io` (129 tests,
one ignored crash-writer helper), `cargo clippy --locked -p uasset-io --all-targets -- -D warnings`,
Rust formatting, 30 targeted Vitest tests with `UE_SHED_UASSET_EXECUTABLE` explicitly set to the
new executable, and `pnpm -s run typecheck`. Lightweight default-reader staged checks also
matched all 47 records against the base on each canonical corpus.

`pnpm -s run check:static` ran once at the end and stopped only on the unchanged
`crates/process-metrics/Cargo.toml` formatting issue. That file was intentionally left alone,
as directed. The exact remaining diagnostic was:

```text
crates/process-metrics/Cargo.toml (0ms)

Format issues found in above 1 files. Run without `--check` to fix.
```

The requested default change, rebuilt-reader released measurement and both canonical package
snapshot comparisons are complete. Sixteen workers remains ineligible; the combined-branch
whole-tree gate is deferred to final measurements. No additional 1× build, Unreal Editor,
Perforce write, push, PR or merge occurred.

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

The initial runner stopped immediately after reading this completed probe's result. No cancellation
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

### Follow-up: cancellation and canonical parity

The lead took ownership of the memory STOP and authorized completion of the two outstanding
gates without another memory probe or a product change. This follow-up tested the exact
`0b3cf301` implementation, rebuilt its TypeScript packages, and used the same Node 26.12.0,
fixed base reader/writer (SHA-256 unchanged), thread caps and external temporary directories.
Every heavy command acquired the shared lock; separate invocations were prepared to release
it between repetitions so the other agent's memory measurements could take turns.

**STOP: localization cancellation exceeded the 3 s child-exit limit in its first valid
repetition.** No product or tracked verification code was changed.

| Phase / repetition      |   Interrupt return | Descendants exited | Children remaining at final poll | Immediate second refresh |
| ----------------------- | -----------------: | -----------------: | -------------------------------: | ------------------------ |
| Localization parse, 1   |              24 ms |          59,202 ms |                                0 | Succeeded, 84.120 s      |
| Localization parse, 2–3 | Not run after STOP |                  — |                                — | —                        |
| Package extraction, 1–3 | Not run after STOP |                  — |                                — | —                        |
| Join, 1–3               | Not run after STOP |                  — |                                — | —                        |

The interrupt fired 1,000 ms after the first `localization` progress event. `interruptMs`
measures `Fiber.interrupt`; `idleMs` measures time from its completion until a process-tree
enumeration finds no remaining non-shell descendants. Despite the historical field name,
idle CPU does not satisfy this probe. Sampler shells are excluded. The result has
`interrupted: true`, `secondRefreshOk: true`, and no interrupt or second-refresh error.
The immediate retry used the same cache and process, after the exit check, with no manual
cache repair. Interrupt return passed 0.5 s; child exit failed 3 s by a wide margin.

The valid invocation was
`node scripts/game-text-cold-cancel-probe.ts --project "$project" --cache-root "$freshCache"
--phase localization --reps 1 --out "$result"`.
Its artifact is `$results\cancel-localization-native-r1.json`, and the fresh cache is
`$results\cancel-localization-native-r1\rep-1`. The intended matrix was three independent
invocations per phase, each with a fresh cache and its own immediate same-process retry;
the runner checked each result and stopped on this first failure.

One preceding `node --import tsx` invocation is retained separately at
`$results\cancel-localization-r1.json` and excluded from the acceptance results. It returned
from interrupt in 21 ms and retried successfully in 83.201 s, but exhausted the probe's
120 s child-wait bound with one descendant remaining. A read-only process-tree inspection
identified that descendant as the persistent `esbuild.exe` service started by `tsx`, with
no native child present at that inspection. Native Node TypeScript execution removes that
top-level loader service without changing the implementation or the probe. The valid rerun
still failed the exit gate, so that failure is not dismissed as the original loader artifact.

The native writer pool retains cleanly ended clients with a 30 s TTL
(`packages/game-text/src/native-index-builder.ts:491–510`), and session finalization decides
invalidation from whether native `end` completed (`:527–552`). This is an investigation anchor,
not an established explanation of the 59.202 s sample: the probe retains aggregate descendant
counts, not per-child lifetime evidence. No new heavy diagnostic run or product fix followed
the STOP.

Changed builds of both canonical corpora and their byte comparisons were not started after
this cancellation failure. Their retained baselines and the already passing benchmark-pair
comparisons remain unchanged; no new exclusions were introduced. The cancellation matrix and
four-input byte-identity gate remain incomplete. The lead's separate memory work is not
re-measured or resolved by this follow-up.

### Cancellation lifecycle fix

The reader-running-to-completion hypothesis was not borne out. Before the fix, a controlled
mid-read regression showed that the package and import finalizers did run before
`Fiber.interrupt` returned, but **after the writer session had already been released**.
Effect's `forkChild` supervision interrupts children when their parent fiber terminates;
that is later than unwinding the writer's nested resource scopes. The branches were not
detached, and no uninterruptible reader operation explained the long post-interrupt lifetime.

A bounded diagnostic reran localization cancellation against the pre-fix product code and
retained at most three process-tree observations (PID, role and cumulative CPU only; no command
lines, input identities or memory samples). At 447 ms and 3,153 ms after interrupt returned,
the sole surviving descendant was the same `native-session` process, PID 20988, with only
15.625 ms CPU at both observations. No native one-shot reader remained. That session exited
at 59.360 s; interrupt had returned in 23 ms and the retry succeeded in 83.309 s. The artifact
is `$results\cancel-localization-native-r10.json`.

The long-lived descendant was the idle writer. Its session finalizer sent native `end`
successfully while unwinding an interrupted parse, setting `endedCleanly = true`. The pool
invalidation finalizer checked only that flag, so it returned the interrupted operation's
client to the pool instead of closing it. The configured usage TTL is 30 s, and Effect 4.0.4's
usage strategy checks once per TTL: retirement can take almost 60 s. This explains the
observed 59 s lifetime without a reader continuing extraction. Finalizers run with Effect's
normal interruption masking; the problem was scope ordering and successful-end bookkeeping,
not a long uninterruptible read.

The fix retains one writer session and both concurrent branches inside `prepareTarget`:

- Fork both branches with `Effect.forkScoped` inside a nested `Effect.scoped`. Closing that
  scope interrupts the branches and awaits their finalizers before closing the writer lease.
- Reuse a native writer only if native `end` succeeded **and the enclosing session scope
  completed successfully**. Failed or interrupted sessions invalidate their clients, so a
  clean native `end` cannot leave a canceled operation's writer waiting for pool expiry.

The localization-error path still explicitly interrupts the package branch and returns the
same error; the source-view fallback remains outside the failed writer session. Memory
budgeting, publication ordering, the reader/writer binaries and snapshot algorithms are
unchanged. No memory probe is part of this fix's verification; the lead retains that STOP.

The product fix is commit `1e95a59e`. Two regression tests were demonstrated red before their
corresponding changes, then green:

- `index-concurrent.test.ts` holds the import and a fake package source mid-read, interrupts
  `prepareTarget`, and requires both finalizers before writer-session release and a bounded
  interrupt completion. The old code released the session before the read finalizer.
- `native-index-lifecycle.integration.test.ts` interrupts an idle native session while its
  enclosing builder layer stays open. It records the real writer PID with the protocol
  observer and requires it to have exited when interruption completes. The previous release
  logic left the PID alive; closing the whole builder layer cannot mask the failure in this test.

The targeted index/localization-import/package-text tests, stage-recorder tests and native
builder/lifecycle integration tests passed: **17 files, 88 tests**. The existing concurrent
localization-error and sequential-publication comparisons remain green. `pnpm -s run typecheck`
and `pnpm -s run check:static` passed, the latter including 336 architecture tests. Red/green
evidence is retained as `$results\cancel-fix-before-order.log`, `cancel-fix-before-writer.log`,
`cancel-fix-tests.log`, `cancel-fix-typecheck.log` and `cancel-fix-check-static.log`.

The first fixed extraction probe returned from interrupt in 289 ms, but the original probe
context retained one idle session through its 120.092 s exit-poll timeout. The same PID
recorded 2,250 ms CPU at 458 ms and 3,116 ms, and the retry succeeded in 78.169 s. This is
retained as `$results\cancel-packages-fixed-r1.json`, not counted as a passing result.
The remaining lifetime belonged to the host fixture: `ProjectIndexProcess.makeProcessService`
owns a long-lived query session in the enclosing service layer. Once inventory has completed,
canceling Game Text does not cancel that separate host service. Parse interruption had
previously canceled inventory before its session could become idle, hiding this ownership issue.

Probe commit `162e76f5` makes the inventory/scan boundary explicit. Each repetition reads the
production package inventory in a separately scoped service layer, closes that layer, and
asserts **zero descendants before starting the timed refresh**. The read-only inventory is
then supplied to the production source, retaining its real package reads, staging and bundle
verification. No live Project Index PID is excluded. The timed writer/builder stays open
across interruption, the complete child-exit check and the immediate same-process/same-cache
retry. All scan descendants, including idle writers, are still counted; the deadlines are
unchanged. This matches the Workbench's host-maintained inventory and avoids closing the
whole builder as a way to mask the native writer regression.

The earlier three passing localization samples (`cancel-localization-fixed-r1..3.json`) and
the extraction timeout remain diagnostic artifacts. The final matrix uses fresh
`cancel-{localization,packages,joining}-prepared-r{1,2,3}` cache roots and JSON files consistently
for all nine runs. The two targeted concurrency/lifecycle files also passed after the probe
change (9 tests), including an assertion that the interrupted prepare used exactly one writer
session. Native Node TypeScript execution is used throughout; no loader helper is excluded.

The first join setup stopped before any timed refresh because its immediate inventory-exit
check saw a descendant. The setup check now waits at most 3 s for its separately closed
inventory scope/process enumeration to settle, recording any remaining PID/role evidence and
failing if it does not reach zero. This wait precedes the timed refresh and changes neither
cancellation deadline. The accepted join repetitions used fresh `prepared2` cache roots;
the aborted setup cache was not reused and produced no cancellation result.

#### Completed cancellation matrix

All nine accepted repetitions passed. Values are in repetition order, not sorted. Child-exit
times are conservative process-enumeration bounds measured after interrupt returns, with no
idle-CPU allowance. Every run recorded `interrupted: true`, `childrenRemaining: 0`,
`inventoryChildrenRemaining: 0`, and `secondRefreshOk: true`, without interrupt/retry errors.

| Interrupted during | Interrupt return, ms | Child-exit poll, ms |     Immediate retry, s |
| ------------------ | -------------------: | ------------------: | ---------------------: |
| Localization parse |           33, 34, 36 |       410, 406, 408 | 73.684, 74.737, 75.038 |
| Package extraction |        221, 254, 205 |       417, 513, 416 | 74.006, 75.383, 75.968 |
| Join               |           72, 69, 63 |       425, 432, 424 | 15.882, 16.024, 15.928 |

Worst interrupt return was **254 ms ≤500 ms**; worst exit poll was **513 ms ≤3,000 ms**.
The interrupt delays remained 1 s after localization starts, 5 s after package reading starts,
and 0.5 s after joining starts. Each repetition used a fresh Game Text cache and an immediate
second refresh in the same process, same builder context and same cache, without repairs.
The shared lock was released between repetitions, with turns yielded to the reader-memory
agent. The final numeric aggregate is `$results\cancel-prepared-summary.json`.
Individual artifacts are `cancel-localization-prepared-r1..3.json`,
`cancel-packages-prepared-r1..3.json`, and `cancel-joining-prepared2-r1..3.json`.

#### Canonical byte comparisons after the fix

Both canonical corpora were cold-built once with the fixed product and the same benchmark
harness, warmed external project-index caches, stage recorder, Node/thread settings and
unchanged fixed base executable. Changed outputs are `$results\changed-ue57` and
`$results\changed-ue58`; their `caches\run-1` stores were compared against the retained
`baseline-ue57` / `baseline-ue58` stores using the unchanged comparator and **exactly the same
exclusions** as the benchmark pairs above.

| Corpus | Package layers | Localization + observation layers | Joined layers | Dictionaries | Stored data sections compared | Result                                  |
| ------ | -------------: | --------------------------------: | ------------: | -----------: | ----------------------------: | --------------------------------------- |
| UE 5.7 |             44 |                                19 |             1 |           15 |                         2,295 | Equal with existing identity exclusions |
| UE 5.8 |             44 |                                19 |             1 |           15 |                         2,295 | Equal with existing identity exclusions |

Each comparison accounted for all **84** shared-store files: 15 dictionary snapshots matched
whole-file bytes, while 69 files differed only in the already documented generation/name/key
metadata and its framing. Every non-metadata stored payload and descriptor, including
dependency-graph data, matched. Both roots, manifests and graph state were checked with the
same normalization/checksum validation; no exclusions were added. Full paired filenames are
retained in `$results\identity-ue57.json` and `identity-ue58.json`.
There were **no unexplained differences**. Canonical measured build walls were 1.868 s and
1.802 s (one run each; no repeated timing claim).

The two benchmark inputs were also cold-built once again with the lifecycle fix and fixed
base executable, using the same warmed-index harness. These new parity outputs are
`$results\fixed-released` and `fixed-1x`; all earlier outputs remain retained. Their
`caches\run-1` stores were compared directly against the original retained baseline stores.

| Fixed benchmark pair | Package layers | Localization + observation layers | Joined layers | Dictionaries | Stored data sections compared | Result                                  |
| -------------------- | -------------: | --------------------------------: | ------------: | -----------: | ----------------------------: | --------------------------------------- |
| Released project     |            256 |                                43 |             1 |           22 |                        13,272 | Equal with existing identity exclusions |
| 1× project           |            256 |                                43 |             1 |           22 |                        13,017 | Equal with existing identity exclusions |

Each fixed benchmark store again accounted for 327 files: 22 whole-file identical dictionary
snapshots and 305 files differing only in the existing normalized metadata/framing. Exact
paired filenames are retained in `$results\identity-fixed-released.json` and
`identity-fixed-1x.json`; stage spans remain under each parity output's `run-1\build` directory.
There were **no unexplained differences on any of the four inputs**. No additional exclusions
were needed, and the comparator was unchanged.

The requested cancellation matrix and four-input byte-identity gate are now **complete and
passing**. The previous memory STOP remains assigned to the lead; it was neither remeasured
nor claimed resolved here. No Unreal Editor, Perforce write, push, PR or merge was used.

## Reader memory timeline (standalone extraction)

Measured 2026-10-26, base `ab7e832b`, instrumentation `1e7cd07d`. This is measurement only:
worker scheduling, the 12-worker default, serialization and decoding behavior are unchanged.
The [numeric observations](game-text-reader-memory-measurements.json) retain every native
100 ms sample with its window, input, staged-result and writer counters, anonymous slow/large
package summaries, binary/trace hashes and the budget replay. The
[interactive timeline](game-text-reader-memory.html) aligns both runs at the first worker read.

### Capture, isolation and calibration

One standalone extraction of the released project's complete inventory at each of 8 and 12
workers, plus one ordinary-reader control at each count. All 15,612 package records were read
again (8,431,479,437 input bytes), into fresh staging directories; no localization import,
Node host, index writer, inventory refresh or package prepare ran alongside extraction. The
OS filesystem cache was not flushed. These are extraction measurements, not full cold-build
or combined-branch measurements, and do not replace the earlier eligibility sweep.

The control was rebuilt from unchanged `ab7e832b`. The probe was built from that base plus
`1e7cd07d`, using `cargo build --locked --release -p uasset-io --features reader-memory-probes`.
Normal builds compile empty hooks and keep the ordinary system allocator. Probe builds install
a system-allocator wrapper with per-thread allocation balances on separate cache lines; the
timeline additionally requires `UE_SHED_READER_MEMORY_DIR`. Pointers, layouts and allocation
strategy are unchanged. Existing internal `process-metrics` is reused; no registry dependency
was added. The initially tried shared atomic allocation counter distorted CPU substantially
(541.5 s versus the control's 208.2 s) and was discarded; none of the results below uses it.

The native sampler records working set, private committed bytes, live requested Rust heap
bytes, process CPU, scheduled/active/ready/consuming jobs and input bytes, exact read-Vec
capacities, staged payload lengths/capacities, and buffered writer count/length/capacity.
Stage states distinguish read, package-header parse, export decode, projection, package
release and record serialization. Anonymous job IDs retain input size, service/coordinator
times and bounded allocation checkpoint envelopes; no input identities are recorded. Capture
is capped at 200,000 jobs, 20,000 periodic samples and 128 coarsened points per job. Neither run
dropped a job or sample. Maximum native sample gaps were 100.82 ms (8) and 100.87 ms (12), below
250 ms; the independent Windows process observer's maximum gaps were 111.89 and 111.99 ms.
Counters are near-contemporaneous relaxed reads, not a stop-the-world heap census.

The probe holds an explicitly marked 2 s idle interval after drain to observe released
memory, then writes its trace. Worker extraction wall below excludes setup and this interval.
The inventory-weight metadata pass took about 1.21–1.23 s before workers started.

| Workers / reader     | Process elapsed |      CPU | Working-set high water | Private high water | Worker extraction wall |
| -------------------- | --------------: | -------: | ---------------------: | -----------------: | ---------------------: |
| 8, ordinary control  |         28.59 s | 197.34 s |              3.579 GiB |          3.627 GiB |   not internally timed |
| 8, probe             |         32.32 s | 208.20 s |              3.638 GiB |          3.689 GiB |                28.99 s |
| 12, ordinary control |         23.80 s | 208.22 s |              5.312 GiB |          5.388 GiB |   not internally timed |
| 12, probe            |         26.82 s | 217.88 s |              5.251 GiB |          5.320 GiB |                23.42 s |

Probe CPU overhead versus the same-count control was 5.5% and 4.6%; working-set differences
were +1.6% and -1.1%. One run per configuration cannot distinguish measurement effects from
run variance. The ordinary 12-worker run also exceeded the earlier 4.85 GiB full-build
observation; the new standalone high water is reported as observed, with no default change.

Reproduce under the shared heavy-job lock, with `CARGO_BUILD_JOBS=8`,
`RAYON_NUM_THREADS=16`, and a fresh external output directory:

```bash
python tools/benchmarks/measure_reader_memory.py --label "$label" \
  --executable "$reader" --workers "$workers" --output "$out" \
  --environment-file "$environment_file" --records "$retained_staging"
# Add --control for the unchanged reader; the project root is read only into memory.
python tools/benchmarks/simulate_reader_memory.py "$out" --output "$analysis"
```

Raw artifacts are in `E:/ue-shed-engine-scratch/p45-reader-memory-timeline-8`,
`p45-reader-memory-timeline-12`, `p45-reader-memory-control-8`, and
`p45-reader-memory-control-12`. The driver hashes every complete raw line after sorting within
its group; all four runs match across all 256 groups, 15,612 records and 505,438,831 staged
bytes. A final direct comparison of the sorted complete line byte arrays also passed for all
three released comparisons against the 8-worker control, and for all 47 records on each
UE 5.7 and UE 5.8 canonical corpus. No staged field is excluded. No new index-cache snapshots were built for this
measurement: the earlier canonical/released package-text snapshot comparisons above remain
separate evidence, and the other agent's canonical cold builds are separate work.

### Timeline and ownership of the peak

Both runs have an early hump, not a growing tail. Times here start at the first worker job:

| At the sampled working-set peak             |                  8 workers |                 12 workers |
| ------------------------------------------- | -------------------------: | -------------------------: |
| Time into extraction                        |                    2.105 s |                    3.597 s |
| Working set / private / live requested heap |  3.638 / 3.689 / 3.421 GiB |  5.251 / 5.319 / 4.765 GiB |
| Completed packages                          |                         79 |                         84 |
| Scheduled window count / input sizes        |             16 / 530.6 MiB |             24 / 496.6 MiB |
| Actively processing count / input sizes     |              8 / 267.5 MiB |             12 / 395.8 MiB |
| Waiting count / input sizes                 |              8 / 263.1 MiB |             12 / 100.8 MiB |
| Decode / projection workers                 |                      1 / 7 |                      4 / 8 |
| Ready result count / staged bytes           |                      0 / 0 |                      0 / 0 |
| Consuming result count / staged capacity    |                      0 / 0 |                      0 / 0 |
| Open buffered writers / filled / capacity   | 66 / 150.3 KiB / 1.031 MiB | 69 / 149.4 KiB / 1.078 MiB |

The exact process high water and highest sampled working set differ by less than 1 MiB.
The live-heap peaks occur at different samples: 3.453 GiB at 4.517 s (8 workers) and 4.934 GiB
at 3.496 s (12). At those samples active read buffers are 280.2 and 391.3 MiB, while ready
results remain empty. The ten slowest jobs finish by 7.01 s and 8.12 s respectively; the
12-worker slowest inputs are 33.0–38.8 decimal MB. At 10 s the working sets have fallen to
approximately 0.084 and 0.282 GiB. Small later bumps occur, but there is no cumulative
multi-GiB growth. Correlation of active input bytes with live heap over sampled timelines is
0.927 (8) and 0.926 (12). Input size explains the broad hump, not an exact per-byte cost.

**Decoded export models dominate.** At the 12-worker working-set peak, live requested Rust
heap is 4.765 GiB and exact owned file buffers account for 0.387 GiB. Header allocations for
the active packages total only 5.82 MiB; capacity estimates for the request paths, roots,
discovered inventory and staging-group paths total 10.14 MiB, stable after discovery. The
remaining roughly 4.3 GiB is principally live export decode/projection ownership, supported
by the stage states and per-job counters. A 38.98 MB input reaches 603.98 MB requested heap
while decoding/projecting; after projecting its exports it holds 39.55 MB including the
38.98 MB read buffer, and after releasing the package/read buffer it holds 0.133 MB before
serialization. Similar large jobs reach about 0.58–0.60 GB. This is allocation ownership
attribution, not a typed deep-size census; the residual also includes output records and
small probe/runtime allocations.

**Staging and tables are small.** Event-time staged capacity, including coordinator
consumption through its end, peaks at 16.04 MiB (8) and 16.50 MiB (12) over the entire run;
periodic samples see at most one ready result. Writer buffers eventually reach 256 writers,
4 MiB capacity and at most 2.11/2.17 MiB filled. These quantities do not explain the early
peak. Scheduled-but-waiting jobs own input paths/IDs, not decoded packages or file buffers.

**Working set is not all live Rust heap.** At the sampled working-set peak, private committed
bytes exceed requested live heap by 274.5 MiB (8) and 567.2 MiB (12). This residual includes
allocator slack/retention, OS/runtime allocations and stacks; these counters cannot separate
those exactly. Requested bytes omit allocator usable-size rounding and temporary internal
reallocation copies. No memory mapping is used on this extraction path: inputs are owned
`fs::read` buffers. Filesystem cache outside the process is not measured. After all work and
buffered writers drain, live heap is 18.97/18.99 MiB, working set 55.00/66.32 MiB, and private
bytes 56.16/69.74 MiB. Thus multi-GiB allocator retention is not held after the work; the
remaining private-minus-live residual is 37.2/50.8 MiB. Probe trace metadata is included in
live heap and remains allocated during these idle samples.

### Hypothetical active-input byte budgets at 12 workers

This is an offline replay, not an implemented scheduling change. It retains the existing
24-job delivery window, 12 worker limit, FIFO admission and one coordinator. Byte credits
are acquired immediately before file read and returned when staged output becomes ready;
waiting jobs do not consume credits. An oversized package may run alone. Each package keeps
its **measured 12-worker** service time, staged capacity and allocation envelope; coordinator
service time also stays fixed. This deliberately does not predict faster decoding from less
CPU/memory contention, different cache effects or new admission overhead.

| Active input budget | Replayed extraction wall | Requested live-heap peak envelope | Max active input sizes |
| ------------------- | -----------------------: | --------------------------------: | ---------------------: |
| Unlimited           |                  23.41 s |                         6.206 GiB |             410.64 MiB |
| 384 MiB             |                  23.73 s |                         5.704 GiB |             383.82 MiB |
| 256 MiB             |                  27.24 s |                         3.659 GiB |             250.41 MiB |
| 192 MiB             |                  31.83 s |                         2.717 GiB |             189.89 MiB |
| 128 MiB             |                  40.79 s |                         1.922 GiB |             127.97 MiB |
| 96 MiB              |                  53.56 s |                         1.395 GiB |              95.99 MiB |
| 64 MiB              |                  85.77 s |                         0.885 GiB |              64.00 MiB |

Unlimited replay is 23.407 s against 23.416 s measured worker extraction (0.035% difference).
Memory is a conservative interval-peak envelope, carrying each observed allocation peak over
its checkpoint interval, plus a 26.92 MiB fixed live floor and the maximum 4 MiB writer
capacity. Unlimited replay's 6.206 GiB envelope is 25.8% above the sampled live peak of
4.934 GiB: large decode checkpoints span material fractions of a second, so envelopes can
overlap even when their real allocation maxima do not. It is not predicted working set or
a resident-memory guarantee; allocator slack, native runtime memory, system file cache and
localization memory are excluded. It is conservative for these fixed measured job curves,
not a proven upper bound for a future execution. Applying the measured non-Rust residual as
a universal additive constant would be unsupported.

For example, 192 MiB reduces the replayed live envelope by 56% versus unlimited at 36% more
wall, while 256 MiB reduces it by 41% at 16% more wall. All budgets still permit 12 simultaneous
small packages; they throttle the initial large-package cluster. The 8-worker service times
are often shorter for those large packages (about 2.2–2.7 s versus 3.7–4.5 s for the slowest
12-worker jobs), supporting contention as a reason these fixed-duration budget walls may be
pessimistic. No budget was selected or added to the product, and no combined-tree 6 GiB gate
is claimed by this standalone experiment.

Validation for the memory instrumentation: feature-enabled crate tests passed (134 tests,
one ignored helper), as did feature-enabled clippy with all targets and warnings denied.
Default-feature crate tests passed (132 tests, one ignored helper); default-feature clippy
passed after allowing the intentionally probe-only `Read` variant to be unused in the empty
hooks (`7c88b44f`; it does not alter the feature-enabled measured executable). Rust formatting, the three replay unit tests, 30 targeted Vitest tests with the fresh
probe executable, and `pnpm -s run typecheck` passed. The standalone/canonical record comparisons
above check output neutrality; no parser, extraction policy or protocol field was changed.

`pnpm -s run check:static` was run once; its formatting subcommand caught the report data
while it was being formatted. After formatting the new files, `pnpm -s run format:check`
still stops only on the previously reported, unchanged manifest below, left alone as directed.
All subsequent static subcommands (lint, Effect architecture, license, StyleX, architecture
regressions) were run individually and passed. The remaining exact diagnostic is:

```text
crates/process-metrics/Cargo.toml (0ms)

Format issues found in above 1 files. Run without `--check` to fix.
```

Heavy release builds and runs took turns under the shared lock; tests/checks were also
serialized under it. No Unreal Editor, Perforce write, localization concurrency, 1× replay,
network service, push or PR was used. The only branch update was the authorized fast-forward
to `ab7e832b` before building the ordinary control.

## Reader input-byte admission

Implemented at `27c2ba4a`, with conservative unknown-size charging at `982e865b`, after merging
specification amendment `d1495741` (merge `5f24a897`). The provisional default is **256 MiB with
12 workers**. The lead selects the final budget from the separate combined-branch measurement;
no localization overlap or combined-tree eligibility is claimed here. The
[numeric observations](game-text-reader-budget-measurements.json) retain native aggregate spans,
credit high waters, process memory samples, output hashes and parity results.

### Admission and contract

`limits.maximumInFlightPackageBytes` is an additive optional positive integer byte limit. Existing
requests omit it and use 268,435,456 bytes. The host does not set it yet. Resource-limit schemas,
shared JSON Schema and native validation accept the field and reject zero; existing requests and
result shapes stay valid. Twelve workers and their existing configuration remain unchanged.

Workers share a mutex/condition-variable pending queue inside the existing two-jobs-per-worker
window (24 at the measured worker count). They take the earliest pending input that fits the
remaining byte credits, so fitting small packages can pass a waiting larger one. An input larger
than the entire budget starts only when no input is active, and excludes other inputs until it
finishes, including zero-byte inputs. Credits cover package read, parse, decode, projection and
worker serialization; an RAII permit returns them before sending the completed result. The
coordinator still refills before appending staged bytes. Ordered consumers retain their ordering;
staged groups retain completion order. Buffered and streamed projection share this scheduler.

The pre-admission file-size inventory has its own `extract.budget_inventory` span. A missing size
reserves `u64::MAX` rather than zero, preserving the worker's existing read result/diagnostic while
avoiding undercharging. Measurements had zero unknown sizes. These are observed input file sizes,
not a live-heap or working-set limit; the host's existing verification still checks input changes.

Budget waits and coordinator receive waits check cancellation at intervals of at most 20 ms.
Closing the queue wakes waiters and clears pending work before scoped joins; dropping result
reception releases blocked senders. Probes separate `extract.budget_wait` from ordinary
`extract.job_wait`; `extract.budget_admission` measures both waits inclusively and admission work
exclusively. Numeric counters retain the requested limit, peak charged bytes, peak active jobs,
unknown sizes and budget-wait wake cycles. All native aggregation remains opt-in through
`UE_SHED_COLD_SCAN_MEASURE_DIR`, with no per-package identities in measurements.

### Released-project measurements

One standalone full extraction at each budget, using the ordinary allocator in a release build,
with native aggregate timings enabled and the external Windows process observer sampling every
100 ms. No localization importer, Node host or index writer ran alongside extraction. Fresh
staging outputs were used; OS filesystem caches were not flushed. Both read the same 15,612
packages / 8,431,479,437 bytes and staged 505,438,831 bytes. Builds and runs took turns under the
shared heavy-job lock with `CARGO_BUILD_JOBS=8` and `RAYON_NUM_THREADS=16`.

The measured executable SHA-256 is
`289f6d78a014aa5e566e89a58531fc61b5c4c840be2017290bd195f0408071be`.
The table uses native operation wall and whole-process CPU between native operation boundaries;
CPU divided by wall is average occupied cores. Memory columns are exact process-lifetime Windows
high waters, observed before exit. They are measured values, not allocation-envelope estimates.

| Input budget | Extraction wall |       CPU | Average cores | Working-set peak | Private peak |
| ------------ | --------------: | --------: | ------------: | ---------------: | -----------: |
| 256 MiB      |        22.975 s | 217.891 s |         9.484 |        3.103 GiB |    3.144 GiB |
| 192 MiB      |        22.858 s | 215.953 s |         9.447 |        2.681 GiB |    2.713 GiB |

Process-lifetime elapsed / CPU were 23.152 / 218.094 s and 23.043 / 216.125 s respectively.
Maximum external sample gaps were 113.03 and 112.86 ms. Both reached 12 active workers.
Peak charged input bytes were 268,435,234 (222 bytes below 256 MiB) and 201,324,534
(2,058 bytes below 192 MiB); neither exceeded its limit.

| Budget-specific work                                |         256 MiB |          192 MiB |
| --------------------------------------------------- | --------------: | ---------------: |
| File-size inventory, elapsed wall / CPU             | 0.433 / 0.438 s |  0.436 / 0.438 s |
| Budget wait, summed worker wall / CPU               | 7.449 / 0.313 s | 14.239 / 1.031 s |
| Admission excluding waits, summed worker wall / CPU | 0.028 / 0.016 s |  0.041 / 0.016 s |
| Ordinary empty-queue wait, summed worker wall       |         1.213 s |          1.279 s |
| Budget-wait wake cycles                             |           2,876 |            6,814 |

Worker wall sums overlap and must not be added to extraction elapsed time. Tiny CPU spans are
quantized at 15.625 ms; the admission CPU figures are at that resolution. The prior standalone
unbudgeted 12-worker ordinary-reader control peaked at 5.312 GiB working set and 5.388 GiB private
bytes (23.796 s process elapsed). Its boundary differs slightly from the native extraction rows.
The lower budget reduced working set by another 0.422 GiB in these final runs, with extraction
walls within 0.6% of one another. One run per configuration does not establish a speed difference.

The earlier offline replay used strict FIFO admission and fixed measured package service times;
this implementation backfills fitting jobs and real service times change with overlap. Its
27.24 / 31.83 s replay walls therefore are not predictions of this scheduler. The two preliminary
runs before conservative unknown-size charging remain scratch artifacts; the table above uses
only the final binary, with no allocation-counting feature enabled.

Reproduce the standalone operation under the shared lock, selecting the private project root
only in memory through the supplied environment file:

```bash
python tools/benchmarks/measure_reader_memory.py --label "$label" \
  --executable "$reader" --workers 12 --budget-bytes "$budget_bytes" \
  --output "$out" --environment-file "$environment_file" \
  --records "$retained_staging" --control --timings
```

`--control` disables the optional heap-timeline capture; this executable was built without
`reader-memory-probes`. Native spans and ordinary-allocator process counters are still recorded.
Definitive raw outputs are `E:/ue-shed-engine-scratch/p45-reader-budget-final-256` and
`p45-reader-budget-final-192`. No full released-project cold index build or 1× replay was needed
for these reader-only measurements.

### Identity gates and validation

Direct comparison of sorted complete raw line byte arrays passed for both budgets on the
released project (256 groups / 15,612 records) and on both canonical corpora (47 records each).
No field or byte was excluded from the staged-record comparison. The unchanged ordinary-reader
outputs from the preceding round are the baseline; each baseline was built/run by this agent.

Both budgets were also used in fresh canonical cold builds on UE 5.7 and UE 5.8, four builds in
all. For **each** corpus/budget pair, all 44 whole prepared package snapshots passed `cmp` with
no exclusions, all 44 published package layers had identical stored data and deterministic
metadata, and all 15 dictionary segments passed whole-file `cmp`. As established by the earlier
base-vs-base check, published physical containers differ only in generated `shared.meta.file`
and `shared.meta.storeGeneration` and dependent metadata checksums; root containers/manifests
carry generated references and are excluded from whole-file identity. No new exclusion or
unexplained difference occurred. The numeric observations retain all differing physical layer
filenames from the four file-by-file reports:
`E:/ue-shed-engine-scratch/p45-reader-budget-parity-256-c57.json`,
`p45-reader-budget-parity-256-c58.json`, `p45-reader-budget-parity-192-c57.json`, and
`p45-reader-budget-parity-192-c58.json`.

The [measurement tables](game-text-reader-budget.html) summarize the final ordinary-allocator
runs. Targeted verification passed: default-feature Rust tests (134, one ignored helper),
feature-enabled Rust tests (136, one ignored helper), clippy with all targets and warnings denied
in both configurations, Rust formatting, 33 targeted Vitest tests using the freshly built reader,
protocol contract checks and `pnpm -s run typecheck`. Scheduler tests cover oversized-input
exclusivity, fitting small inputs passing a waiting large input, budget-wait cancellation
without freeing active credits, full scheduler cancellation within 250 ms, and refill before
consumption. Protocol tests cover omitted, positive and zero budgets.

`pnpm -s run check:static` ran once at the end and stopped only on the unchanged manifest
formatting issue, left alone as directed. The exact diagnostic remains:

```text
crates/process-metrics/Cargo.toml (0ms)

Format issues found in above 1 files. Run without `--check` to fix.
```

All remaining static subcommands were then run individually and passed: lint, Effect architecture,
license, StyleX and all 336 architecture regression tests. No unexplained identity difference,
fixture disagreement or cancellation regression occurred. No Unreal Editor, Perforce write,
network service, push or PR was used. The only merge was the explicitly authorized specification
amendment. The working default remains 256 MiB pending the lead's combined-tree measurement.

## Native localization import

Implemented on `perf/p45-native-localization` from `9cb6ecaa`, in `bf0b9548` (Rust parsers
and differential oracle), `a705018c` (writer command and direct column publication),
`5e3b34a5` (target and standalone imports, warm hints, cancellation and worker removal),
and `8a562d25` (first-failure ordering when later syntax or encoding is invalid).
[Numeric measurements](game-text-native-localization-measurements.json) retain the binary
hashes, anonymous stage totals, all comparison counts and memory samples' summary.

The writer reads, hashes and decodes authored files, with UTF-16LE BOM support for JSON and
UTF-8 for PO, following the existing importer. Up to eight file workers share a **256 MiB
input-byte bound**; an oversized file runs alone. Completed files retain request order. The
parsers produce the original local columns and string-block boundaries in memory, feeding
the existing external merge and layer encoders directly. The same command handles file
refreshes, including content-hash reuse and nonempty-store cold publication. File progress
stays in `localization`. Generated Rust contract types describe the request and result.

Deleted `localization-import-worker.ts`, the cold worker pool, its staged snapshots and
string runs, and both worker exceptions in the Effect architecture checker. The cold host
adapter now submits paths and retains stat hints; it neither reads authored bytes nor
prepares string runs. `prepareLocalizationFile` remains exported and deprecated for explicit
snapshot/reference consumers. Repository-wide caller search, including apps and extensions,
found only its exports and the removed worker. The independent localization package's
parsers and PO writing are unchanged.

### Method and retained artifacts

The unchanged `9cb6ecaa` reader was built first in this worktree and preserved as
`target/p45-localization-baseline.exe`. Baseline and changed TypeScript packages were built
before their runs. Two initial setup attempts were discarded: loading the supplied environment
file also overwrote the selected executable. Accepted runs extract only the two project
variables from that file in memory. No private input identity is retained in this report.

All builds and heavy runs were sequential under `E:/es-id-repairs-scratch/unreal.lock`, with
`CARGO_BUILD_JOBS=8`, `RAYON_NUM_THREADS=16` and Node 26.12.0. Inputs remained read-only;
no Unreal Editor, Perforce write, network service, push, PR or merge was used. Each timing
condition uses one fresh Game Text cache, not a flushed OS cache. The harness warms its
external project index outside the build timer; the 1× project replays retained records.

Accepted baseline outputs are `E:/ue-shed-engine-scratch/p45-loc-base-{1x,released}-r3` and
`p45-loc-base-ue{57,58}-r1`. Changed timing outputs are `p45-loc-after-{1x,released}-r4`;
changed canonical outputs are `p45-loc-after-ue{57,58}-r3`. Host spans are each output's
`run-1/build/stages.json`; caches are `caches/run-1`. Reproduction helpers remain in this
worktree's ignored `target/p45-localization-repro/` directory.

Both accepted timing conditions enable `UE_SHED_GAME_TEXT_STAGES=1` and leave
`UE_SHED_COLD_SCAN_MEASURE_DIR` unset. Earlier changed `r2` runs enabled native attribution;
their numbers from `5e3b34a5` are retained separately rather than compared against an
uninstrumented baseline. The provisional 128 MiB implementation's `r1` outputs are also retained; they
are neither a final timing result nor an isolated budget sweep.

### Cold-build stage tables

Times are seconds, except the GiB row. "Published before" is the final median in the
"Phase 4.5 results" section of `game-text-engine-measurements.md`, as requested; "Fresh
before" is this task's unchanged-base run. "After" uses matching instrumentation flags.
Independent branches overlap, so rows must not be summed. Inventory for the 1× project is
refresh setup residual; open/page includes the workspace residual outside preparation.
Selection, the publication gate and other bookkeeping remain in whole-build wall.

| Stage, the released project   | Published before | Fresh before |  After |
| ----------------------------- | ---------------: | -----------: | -----: |
| Package inventory             |            3.715 |        3.728 |  3.245 |
| Localization parse            |           22.796 |       23.167 | 15.606 |
| Localization publish          |           12.473 |       12.563 | 10.778 |
| Package extraction            |           23.154 |       24.189 | 22.924 |
| Bundle verification           |            5.574 |        5.470 |  5.459 |
| Package prepare               |            4.759 |        4.822 |  4.483 |
| Package publish               |            6.023 |        5.779 |  7.078 |
| Join                          |           13.748 |       13.641 | 13.751 |
| Open + first page / workspace |            1.999 |        1.900 |  1.945 |
| Whole measured build          |           62.247 |       62.301 | 59.619 |
| Peak tree working set, GiB    |            4.855 |        4.927 |  5.418 |

| Stage, the 1× project             | Published before | Fresh before |  After |
| --------------------------------- | ---------------: | -----------: | -----: |
| Records inventory / refresh setup |            0.840 |        0.817 |  0.846 |
| Localization parse                |           20.604 |       21.905 | 16.589 |
| Localization publish              |            6.974 |        6.950 |  6.195 |
| Retained-record replay            |           13.208 |       13.749 | 10.499 |
| Bundle verification               |            0.000 |        0.000 |  0.000 |
| Package prepare                   |            4.305 |        4.219 |  4.066 |
| Package publish                   |            7.912 |        8.601 |  8.379 |
| Join                              |           14.306 |       14.630 | 13.998 |
| Open + first page / workspace     |            1.942 |        1.936 |  2.019 |
| Whole measured build              |           56.705 |       58.815 | 51.962 |
| Peak tree working set, GiB        |            2.841 |        2.737 |  2.938 |

Native localization preparation consumed **52.938 s process CPU / 15.606 s wall** on the
released project and **51.172 s CPU / 16.589 s wall** on the 1× project. This interval includes
file reads, hashing, decoding, parsing, local column construction and ordering, before shared
dictionary publication. CPU is summed across native threads using `GetProcessTimes`.
The TypeScript baseline did not record equivalent CPU: the earlier attribution's 97.3 s
(released) and 79.4 s (1×) are worker-busy wall sums, not CPU measurements.

Against the fresh baselines, whole wall fell by **2.682 s (4.3%)** on the released project
and **6.853 s (11.7%)** on the 1× project. Parsing fell by 7.561 s and 5.316 s. Package
publication and join were slower on the released project, offsetting part of the savings.
One run per condition describes these observations, not a distribution or an isolated
causal attribution. This is not the lead's final three-run campaign. All timed runs remained
below the memory ceiling, though the released build's coarse peak increased.

### Byte identity

The unchanged `scripts/p45-host-layers.ts` compared caches file by file using `cmp -s`, then
checked every stored non-metadata section and descriptor where generated metadata prevented
whole-file equality. It also verified current/previous roots, active pointers, layer keys,
dictionary records, manifests and dependency state/checksums, and rejected unaccounted files.

| Input                   | Package layers | Localization + observation layers | Joined layers | Dictionaries, whole-file equal | Stored data sections compared | Metadata-only files |
| ----------------------- | -------------: | --------------------------------: | ------------: | -----------------------------: | ----------------------------: | ------------------: |
| 1× project              |            256 |                                43 |             1 |                             22 |                        13,017 |                 305 |
| Released project        |            256 |                                43 |             1 |                             22 |                        13,272 |                 305 |
| UE 5.7 canonical corpus |             44 |                                19 |             1 |                             15 |                         2,295 |                  69 |
| UE 5.8 canonical corpus |             44 |                                19 |             1 |                             15 |                         2,295 |                  69 |

All comparisons passed. Each changed output's `parity.json` lists every differing physical
filename. Every dictionary is whole-file identical, and every non-metadata stored payload
matches, including compressed bytes, codecs, counts, checksums and `reuse.meta` hashes.
Only the established exclusions apply: generated generation tokens, physical filenames and
references, generation-derived joined keys, metadata-dependent layer byte lengths and
framing/offsets. Dependency-envelope checksums are verified before normalizing generated
references. No authored value, input hash/key, file timestamp, ID, dictionary boundary or
data column is excluded. External stat hints, project-index caches, empty staging
bookkeeping and measurement logs are outside the published-snapshot comparison.

Differential coverage includes 38 authored localization files (20 fixture files and nine
per canonical corpus) plus 124 generated cases. It compares every raw local column, string
block and diagnostic with the TypeScript importer: BOM variants, invalid encodings, physical
line endings, PO escape replacement order, continuations, contexts, comments, previous msgids,
plurals and large indices, explicit/auto Crowdin modes, empty/duplicate rows, malformed input,
earlier column-limit/syntax failures followed by later syntax/encoding failures,
reserved Unicode scalars and string-block boundaries. The public-parser import oracle also
checks every committed fixture localization file, including expected UE 5.7/5.8 outputs.

### Released-project memory gate

The unchanged memory probe used a fresh cache and its default cold project-index refresh,
with `node --import tsx`, native attribution disabled and 250 ms requested sampling. It
retained 101 samples, mean gap 653.220 ms and maximum gap 926 ms. Its process-tree peak was
**5,134,487,552 bytes (4.782 GiB)** at 18.267 s, below the 6 GiB ceiling. The last progress
label was `packages`; concurrent labels do not identify exclusive ownership of a sample.

| Role at the tree peak                   |         Bytes |   GiB | Processes |
| --------------------------------------- | ------------: | ----: | --------: |
| Node coordinator and its worker threads |   984,858,624 | 0.917 |         1 |
| Native sessions                         | 1,294,503,936 | 1.206 |         3 |
| Native one-shot reader                  | 2,823,528,448 | 2.630 |         1 |
| Sampler/loader/other                    |    31,596,544 | 0.029 |         4 |
| Total                                   | 5,134,487,552 | 4.782 |         9 |

Node's separate sampled high was **2,594,844,672 bytes (2.417 GiB)**; 0.917 GiB is its share
at the tree peak, not its lifetime high. The artifact is
`E:/ue-shed-engine-scratch/p45-loc-memory-r3/memory.json`. These are sampled lower bounds,
not continuous high-water guarantees. The final released timing build's coarse sample was
**5.418 GiB**. An earlier matched run before the error-ordering follow-up reached
**5.552 GiB**; every retained timing run stayed below 6 GiB. The separate probe's
4.782 GiB is not a claim that every run peaked at that lower value.

### Verification

Targeted Vitest coverage passed across 32 files and 240 tests, with a freshly built reader explicitly
selected for every invocation. The initial broad run passed 31 files; the failing import file
and native command integration file then passed their 50-test rerun. After the error-ordering
follow-up, those 50 tests, both complete crate suites, clippy and typecheck passed again
with the final executable and regenerated contract. Updated assertions
measure native changed-block probes rather than the former TypeScript identity-diff lookup
count, and cancel on native file progress instead of polling deleted staging files. Tests
retain parsed-row equality, bounded reuse, failed cold-publication atomicity, stat/content
reuse, interruption cleanup and immediate same-cache retry.

`cargo test --locked -p game-text-index -- --test-threads=1` passed **148 tests**, with three
existing opt-in tests ignored. `cargo test --locked -p uasset-io -- --test-threads=1` passed
**134 tests**, with one existing helper ignored. Clippy passed for both crates, all targets,
with warnings denied. `pnpm -s run typecheck` passed. Generated-contract checks and locked
release builds passed. Final static validation is retained in
`target/p45-localization-static-final.log`. The full suite and `pnpm check` were not run.

## Native package-text shard preparation

Implemented on `perf/p45-reader-layers`, from unchanged `ee33f930`, in `9ed7b851`
(column conversion and raw snapshot oracle), `25e77dc6` (reader shard builders, replay and
Rust-owned preparation types), `476d432f` (host publication and worker removal),
`e85c7074` (paired executable configuration, oversized-record regression and native-Node
probe imports), and `270d814f` (audience suffix edge cases, layer wiring and final checks).
[Numeric results](game-text-native-package-measurements.json) retain the
reader hashes, complete stage totals, file-by-file comparison lists and probe summaries.

Workers mount each package's paths, fold representation copies and convert its typed record
into local column rows. The coordinator retains converted packages in their shard, merges
string IDs in package byte order, and writes an uncompressed, unsynced snapshot when the last
selected package arrives. Excluded inventory entries are encoded at shard completion without
allocating a separate column builder per excluded package. Complete shards stay in one
request; the host batches their signature inventories below the protocol frame limit.
The existing twelve-worker default and **256 MiB input-byte admission** remain in effect.

Retained-record files and explicit stored records use the same converter. Incremental
replacement keeps its identity-only reuse and remaps negative replacement rows to the native
snapshot's package order. Empty inventories also use native columns. Explicit conversion uses
the writer's configured executable even when the ambient reader differs. Audience policy is
supplied by the host as ordered matches and persisted codes; Rust does not duplicate its table.
JSON-valued error and Blueprint metadata cells preserve input member order and UTF-16 units.

Cold publication consumes the reader's snapshot files directly. Deleted the TypeScript prepare
worker, `package-text-worker-protocol.ts`, worker startup/count/pool code, its Workbench entry,
two Effect architecture exceptions, and the index's NDJSON spooling/conversion path.
`package-text-ndjson.ts` moved out of the product package to `scripts/retained-package-lines.ts`
for retained benchmark/fixture inputs. The existing v1.19 external raw-record staging contract
remains compatible; the index uses v1.20 snapshot preparation. `packageTextColumns` has no
index-write caller: it remains the decoder's reference counterpart for differential, coverage
and synthetic-fixture tests. The decoder still reads stored columns during affected-shard reuse.

### Method and cold-build stages

Built the unchanged base first in this worktree with
`cargo build --locked --release -p uasset-io`, retaining `target/p45-layers/base.exe`.
Rebuilt the changed reader as `target/p45-layers/changed.exe`; their hashes are in the numeric
report. TypeScript packages were built before each condition. Node 26.12.0,
`CARGO_BUILD_JOBS=8`, `RAYON_NUM_THREADS=16`, and `UE_SHED_GAME_TEXT_STAGES=1` were used throughout.
All heavy work was sequential under `E:/es-id-repairs-scratch/unreal.lock`.
No Unreal Editor, Perforce write, network service, push, PR or merge ran.

Each condition used one fresh-cache build per benchmark project, through the unchanged
`scripts/benchmark-game-text-engine.ts --stages build --runs 1`. Native attribution was disabled
for both timing conditions. The harness warmed its external project index outside the timer;
the 1× project supplied retained records. Inputs were read-only, with no OS cache flush.
Accepted outputs are `E:/ue-shed-engine-scratch/p45-layers-base-{1x,released}-r1` and
`p45-layers-after-{1x,released}-r2`; canonical outputs use `ue57` and `ue58` instead.
The final changed build is `270d814f`. Earlier development-revision runs remain separate;
the table and acceptance results below use the final suffix-corrected reader.

Seconds except the last row. Concurrent branches overlap: do not sum the rows. The 1× inventory
row is refresh setup outside package refresh. Open/page includes workspace residual outside
`prepareTarget`. Extraction now includes worker conversion and coordinator snapshot writing.

| Stage                                | Released before | Released after | 1× before | 1× after |
| ------------------------------------ | --------------: | -------------: | --------: | -------: |
| Inventory / refresh setup            |           3.410 |          3.475 |     0.796 |    0.745 |
| Localization parse                   |          15.760 |         15.432 |    16.941 |   16.663 |
| Localization publish                 |          10.999 |          9.352 |     6.217 |    6.583 |
| Package extraction / retained replay |          23.221 |         20.510 |    11.177 |    5.915 |
| Bundle verification                  |           5.589 |          5.210 |     0.000 |    0.000 |
| Separate package prepare             |           4.482 |          0.000 |     4.003 |    0.000 |
| Package publish                      |           7.129 |          7.158 |     8.479 |    8.727 |
| Join                                 |          13.723 |         14.011 |    15.451 |   15.252 |
| Open + first page / workspace        |           1.965 |          1.929 |     1.943 |    1.968 |
| Whole measured build                 |          60.296 |         53.048 |    53.699 |   49.786 |
| Coarse peak tree working set, GiB    |           5.292 |          3.737 |     3.173 |    2.425 |

The released build fell **7.248 s (12.0%)** and the 1× build **3.913 s (7.3%)**. The separate
4.482/4.003 s prepare pool is gone from the critical path. Released extraction, including the
new native work, stayed below the base extraction span; native retained replay also
removed host record decoding and spooling. Localization, publication and join variation are
reported, not attributed to this change. One run per condition is descriptive, not a distribution
or the owner's final three-run campaign.

### Byte identity

The unchanged `scripts/p45-host-layers.ts` ran `cmp -s` on corresponding published files and,
where generated metadata differed, compared every other stored section and descriptor. It
checked current and previous roots, active pointers, layer keys and records, dictionary segments,
manifests and dependency state/checksums, rejecting unaccounted store files.

| Input                   | Package layers | Localization + observation layers | Joined | Whole-file equal dictionaries | Stored data sections compared | Metadata-only files |
| ----------------------- | -------------: | --------------------------------: | -----: | ----------------------------: | ----------------------------: | ------------------: |
| Released project        |            256 |                                43 |      1 |                            22 |                        13,272 |                 305 |
| 1× project              |            256 |                                43 |      1 |                            22 |                        13,017 |                 305 |
| UE 5.7 canonical corpus |             44 |                                19 |      1 |                            15 |                         2,295 |                  69 |
| UE 5.8 canonical corpus |             44 |                                19 |      1 |                            15 |                         2,295 |                  69 |

All four comparisons passed. Full physical filenames of metadata-only differences are retained
in the numeric report and `target/p45-layers/parity-{released,1x,ue57,ue58}.json`. Only established
exclusions apply: generated generation tokens and physical filenames/references, generation-derived
joined keys, metadata-dependent byte lengths, checksums and framing/offsets. Dependency envelope
checksums were verified before normalization. No authored value, file timestamp, input key, ID,
dictionary boundary, codec, count or non-metadata payload is excluded. External stat hints,
project-index caches, staging bookkeeping and measurement logs remain outside published-cache parity.
There was no unexplained difference and no new exclusion.

The differential oracle compares raw columns and **complete staged snapshot bytes**, without
exclusions, for all twelve committed package fixture projects, both canonical corpora and generated
cases. Coverage includes 120 generated records across every identity/location/copy kind, all gap
reasons, gather coverage, empty strings, Unicode and lone surrogates, string-block boundaries,
raw and already-folded Blueprints with and without authored sites, and error/Blueprint JSON member
order, plus nested/unbalanced array and map suffixes used in audience classification. A native
fixture regression also compares extraction, ordered package-local merges and
retained replay byte for byte, and requires the shard file to exist when its last completion emits.

### Memory, native work and cancellation

The dedicated released-project probe used a new external cache and its normal cold project-index
refresh, with native attribution enabled. It retained 97 samples: mean gap **675.146 ms**, maximum
**980 ms**, against 250 ms requested sampling. Peak tree working set was **4,962,713,600 bytes
(4.622 GiB)** at 15.337 s, last progress label `packages`, below 6 GiB. Labels interleave and do
not identify exclusive ownership. The artifact is
`E:/ue-shed-engine-scratch/p45-layers-memory-r3/memory.json`.

| Role at tree peak      |         Bytes |   GiB |
| ---------------------- | ------------: | ----: |
| Node coordinator       |   319,389,696 | 0.297 |
| Native sessions        | 2,101,280,768 | 1.957 |
| Native one-shot reader | 2,510,364,672 | 2.338 |
| Sampler / other        |    31,678,464 | 0.030 |
| Total                  | 4,962,713,600 | 4.622 |

Node's separate sampled high was **349,786,112 bytes (0.326 GiB)**. The reader reported at most
**23 shard builders** and **48,455,782 bytes (46.211 MiB)** of retained converted-column capacity
in one request. This is an ownership estimate, excluding inventory metadata and temporary merge
buffers, not a heap census. The same counters are exposed to the optional reader-memory probe.
In this instrumented run, `extract.columns` recorded 167,401 calls, **7.743 summed thread-seconds /
6.500 CPU seconds**; `extract.shard_snapshot` recorded 256 calls, **4.081 summed wall seconds /
4.031 CPU seconds**. They nest and overlap extraction and must not be added to build wall.
Native artifacts are in `target/p45-layers/memory-native-r3/`. All sampled peaks are lower bounds.

One earlier memory invocation failed during module loading, before acquiring the lock or creating
a scan cache: native Node cannot resolve source `.js` specifiers through `.ts` imports. Retained
helpers now import built package modules; the accepted memory and cancellation probes run on
native Node without a loader process. That setup attempt is not a measured scan.

The extraction cancellation probe ran once, 5 s after `packages` progress began. Interrupt returned
in **89 ms**, every scan child was gone at the **434 ms** poll, and the immediate same-process,
same-cache retry succeeded in **49.031 s**. Inventory descendants were zero before the timed scan;
remaining descendants were zero afterward. Both deadlines passed. The artifact is
`E:/ue-shed-engine-scratch/p45-layers-cancel-r2/cancellation.json`.

### Verification

Passed with the freshly built reader selected for every Vitest invocation:

- Nineteen requested package-text, index, saved-fixture and native-delta files: **148 tests**.
- Six follow-up configuration, large-record, concurrency and native-lifecycle files: **19 tests**
  (some repeat the earlier files). A different ambient reader cannot override the configured
  executable; a record beyond the request envelope uses bounded file input and matches the oracle.
  The final reader also passed the configuration/lifecycle subset again: three files, 12 tests.
- `cargo test --locked -p uasset-io -- --test-threads=1`: **136 passed**, one existing helper ignored.
- `cargo test --locked -p game-text-index -- --test-threads=1`: **148 passed**, three opt-in tests ignored.
- Clippy for both crates, all targets with warnings denied; Rust formatting; generated native
  contract validation; the repository's contract checks; locked release builds.

`pnpm -s run typecheck` and `pnpm -s run check:static` passed (336 architecture tests,
existing lint warnings only). The full suite, `pnpm check`,
Unreal Editor, the owner's final fuzz/export acceptance matrix and three-run timing campaign were
not run. No byte-identity, fixture, memory or cancellation STOP condition was triggered.

## Hardcoded text volume probe

The question: how many user-visible strings does a project store in `FString` and `FName`
properties instead of `FText`? Unreal never gathers those, so they can never be translated. The
answer decides whether a Game Text section that lists them for review is feasible as a plain list,
needs grouping, or should not be built.

The research ran on 2026-10-26 on branch `scratch/hardcoded-text-probe`, based exactly on
`perf/game-text-scan-stages` (`39b1748f`). Every number below was measured with a reader built from
`22b3f8cf` on that branch. The branch was later ported onto `main` at `2585d62b` (UE Shed 0.23.0) so
the probe and its record are kept. The port leaves the probe module as it was and only threads its
argument through the current `project_io.rs`. The reader around it has changed since `39b1748f`,
and the numbers were not re-measured after the port. The opt-in collector is in
`crates/uasset-io/src/direct_executor/project_io/hardcoded_probe.rs`; the private streaming runner
is `scripts/hardcoded-text-probe.mjs`. Neither runs unless its environment variables are set.

### Method and scope

The released project is the only benchmark input. Explicit selection `paths: ["Content"]`
disables the normal FText name-map prefilter: otherwise packages with only FString/FName would
be skipped. The same release executable, 12 reader workers and 256 MiB input-byte budget serve
both runs. Package discovery, decoding, existing FText projection and streaming output run in
both. `UE_SHED_HARDCODED_METRICS` enables request wall/CPU and lifetime peak memory counters;
`UE_SHED_HARDCODED_PROBE=1` additionally visits already-decoded string/name values. Normal requests
have neither variable set. There are no new dependencies or decoder changes.

The runner reads the input path only into memory from the supplied environment file and sends
the request through stdin. It incrementally parses stdout, retains numeric summary fields and
a SHA-256 stream digest, and discards every package record. Stderr is discarded. No extracted
value or input path is logged or saved. Output contains property/class metadata, counts, and
anonymous example shapes only. Root and project descriptor names are redacted from metadata.

Coverage includes tagged properties, nested structs and instanced structs, native property
trees already exposed by the decoder, arrays/sets, map keys and values, DataTable row properties,
struct defaults, CDOs and nested default subobjects, and string/name-category graph pin defaults
including user-defined pin defaults. FText and localizable StringTable entries, enum symbols,
row/bone/pin identifiers that are native metadata rather than properties, and graph tooltips
are outside this count. Compiled FString/FName bytecode literals and unparsed native tails are
not newly decoded. Serialization copies, including Blueprint skeleton/default representations,
are counted as saved occurrences; exact distinct values collapse equal strings across types
and assets. This is a census of what the current decoder exposes, not a completeness claim for
every string stored anywhere in the project.

Exclusions are ordered and mutually exclusive: empty; whitespace-only; case-insensitive None;
object/soft paths; GUID; number; other hex; file path/extension; dotted tag-like token. GUID and
hex share one reported category. Classification trims for exclusion but interns the original
value, so whitespace variants remain distinct. Hex is explicitly prefixed or at least eight hex
characters; file extensions use the visible list in the probe. Remaining space counts use a
literal space. Sentence-like means whitespace plus `. ! ?` (also their CJK equivalents), or at
least four whitespace-separated words. Single-token classes are lowercase, Capitalized,
CamelCase/snake_case (also acronyms), and other. These are research heuristics, not a guarantee
that a survivor is player-visible or that every exclusion is safe for a shipping review tool.

For locations, DataTable/CDO/graph provenance takes precedence; elsewhere the innermost
struct/container determines the bucket. Property breakdown uses the leaf member name (container
scalars keep the containing property name); pin literals use `Pin.DefaultValue` or
`UserPin.DefaultValue`. Class is the owning asset class, not each export's class. Groups overlap
in distinct values, so distinct counts must not be summed across groups. Example shapes describe
up to three distinct values per property; repeated shapes can represent different values. No
content examples are retained. Interning is capped at 8 million values / 512 MiB raw value bytes,
and each property/class grouping at 200,000 labels; a cap invalidates completeness and is reported.

Commands from Git Bash (Node 26.12.0 first on PATH):

```bash
export PATH="/c/Users/denny/AppData/Local/vite-plus/data/js_runtime/node/26.12.0:$PATH"
node scripts/hardcoded-text-probe.mjs check
node scripts/hardcoded-text-probe.mjs build
node scripts/hardcoded-text-probe.mjs fixture target/hardcoded-fixture
node scripts/hardcoded-text-probe.mjs off
node scripts/hardcoded-text-probe.mjs on
```

Every command acquires the shared heavy-job lock and releases it before the next command.
The first on-run waiter was stopped before acquiring the lock or starting a reader after
30-second polling repeatedly missed short handoffs. Runner-only commit `f0c67be6` uses the
same create-exclusive/owner-PID lease with one-second polling and 30-second wait messages.
The completed off run and the native executable use `22b3f8cf`; extraction code is identical.
The runner sets `CARGO_BUILD_JOBS=8`, `RAYON_NUM_THREADS=16` and the supplied TEMP/TMP directory.
Native elapsed wall uses `Instant`; CPU is whole-process kernel plus user CPU summed across
threads. Windows lifetime peak working set and peak private bytes come from process counters,
not a sampled host tree. Native timing ends before aggregate report construction/cleanup;
transport wall includes startup, streaming, reporting and exit. One released-project run per
mode, off then on, is sufficient for this volume probe but cannot establish repeatability or
separate cache warming from instrumentation cost. The OS file cache is not flushed. This does
not measure a cold Game Text index build, localization import, joins, UI, or review accuracy.

### Observed counts (2026-10-26)

Reader source/build commit: `22b3f8cf`. Aggregate artifacts:
[off](hardcoded-text-probe-off.json), [on](hardcoded-text-probe-on.json), and
[compact tables](hardcoded-text-probe.html). Counts include saved copies and pin literals.
All distinct counts are exact within the stated decoded scope. The survivor set is not a
count of verified user-visible text. Property and class names that the project defined itself are
replaced by anonymous placeholders numbered by rank (`ProjectPropertyNN`, `ProjectClassNN`), the
same in every artifact; stock Unreal Engine identifiers are kept.

| Measure                         | Occurrences | Distinct  |
| ------------------------------- | ----------- | --------- |
| all                             | 23,801,518  | 1,345,045 |
| remaining                       | 13,942,584  | 624,177   |
| FName                           | 15,758,329  | 224,114   |
| FString                         | 7,906,078   | 1,143,158 |
| FName pin literal               | 91,061      | 658       |
| user pin literal                | 41,774      | 4         |
| FString pin literal             | 4,276       | 449       |
| contains space                  | 2,392,637   | 217,877   |
| sentence-like                   | 1,789,591   | 183,940   |
| CamelCase/snake_case identifier | 8,420,276   | 358,759   |
| Capitalized                     | 2,513,514   | 6,971     |
| multiple words                  | 2,397,261   | 218,780   |
| other single token              | 407,128     | 38,079    |
| lowercase                       | 204,405     | 1,588     |

### Ordered exclusions

| Measure                    | Occurrences | Distinct |
| -------------------------- | ----------- | -------- |
| dotted tag-like name       | 3,733,214   | 533,336  |
| None                       | 3,475,994   | 4        |
| file path/extension        | 1,756,163   | 142,931  |
| empty                      | 412,560     | 1        |
| number                     | 188,467     | 897      |
| GUID/hex                   | 163,838     | 40,853   |
| object path/soft reference | 128,659     | 2,843    |
| whitespace-only            | 39          | 3        |

### Locations after exclusions

| Measure               | Occurrences | Distinct |
| --------------------- | ----------- | -------- |
| struct member         | 4,584,704   | 155,309  |
| CDO                   | 4,198,081   | 20,391   |
| DataTable cell        | 2,301,060   | 140,889  |
| array/map/set element | 1,680,283   | 159,236  |
| plain property        | 1,175,309   | 268,679  |
| graph pin             | 3,147       | 1,040    |

### Top 40 properties after exclusions

Example shapes for the top 20 use `characters c / words w / p`; `p` means sentence
punctuation occurs somewhere, not necessarily at the end. Each shape describes a distinct
example value. Where fewer than three distinct values exist, fewer examples are reported.

| Property                       | Occurrences | Distinct | Three examples as anonymous shapes |
| ------------------------------ | ----------- | -------- | ---------------------------------- |
| Name                           | 1,588,170   | 75,352   | 8c/1w, 16c/1w, 16c/2w              |
| ProjectProperty01              | 888,681     | 2,216    | 12c/1w, 12c/1w, 12c/1w             |
| ProjectProperty02              | 804,211     | 1,034    | 9c/1w, 14c/1w, 13c/1w              |
| ProjectProperty03              | 746,537     | 3,531    | 10c/1w, 10c/1w, 10c/1w             |
| ProjectProperty04              | 729,732     | 105,450  | 63c/11w, 6c/1w/p, 12c/2w           |
| ProjectProperty05              | 716,700     | 19,846   | 62c/14w, 7c/1w/p, 13c/2w           |
| Channel                        | 595,724     | 38       | 11c/1w, 12c/1w, 11c/1w             |
| PayloadVariables               | 510,765     | 160      | 12c/1w, 6c/1w, 11c/1w              |
| ExpansionStates                | 453,685     | 89,048   | 10c/1w, 30c/1w, 26c/1w             |
| ProjectProperty06              | 417,679     | 162      | 27c/1w, 27c/1w, 21c/1w             |
| MemberName                     | 399,824     | 18,311   | 8c/1w, 21c/1w, 22c/1w              |
| ActorLabel                     | 340,030     | 176,123  | 13c/1w, 14c/1w, 25c/1w             |
| FuncMap                        | 327,476     | 34,130   | 20c/1w, 19c/1w, 9c/1w              |
| ProjectProperty07              | 285,052     | 394      | 11c/1w, 11c/1w, 16c/1w             |
| BoundObjectPinName             | 278,925     | 3,181    | 12c/1w, 25c/1w, 8c/1w              |
| RowName                        | 215,551     | 12,813   | 4c/1w, 9c/1w, 4c/1w                |
| Value                          | 193,258     | 13,346   | 8c/1w, 5c/1w, 29c/1w/p             |
| StaticMeshDerivedDataKey       | 188,282     | 19,718   | 382c/1w, 382c/1w, 382c/1w          |
| ProjectProperty08              | 157,735     | 8,675    | 10c/1w, 10c/1w, 10c/1w             |
| PropertyName                   | 155,315     | 1,518    | 54c/1w, 54c/1w, 54c/1w             |
| BindingName                    | 150,330     | 9,045    |                                    |
| CustomFunctionName             | 149,654     | 22,683   |                                    |
| ProjectProperty09              | 140,141     | 213      |                                    |
| CollisionProfileName           | 131,356     | 27       |                                    |
| ProjectProperty10              | 113,482     | 5,425    |                                    |
| SectionOriginalMaterialName    | 93,360      | 9,522    |                                    |
| FriendlyName                   | 91,328      | 6,752    |                                    |
| PropertyPath                   | 88,218      | 91       |                                    |
| UniqueTrackName                | 88,191      | 90       |                                    |
| Type                           | 87,745      | 17       |                                    |
| ProjectProperty11              | 85,770      | 4,664    |                                    |
| FullName                       | 81,427      | 2,302    |                                    |
| ProjectProperty12              | 80,351      | 1,989    |                                    |
| Tags                           | 80,184      | 139      |                                    |
| ProjectProperty13              | 79,981      | 620      |                                    |
| ProjectProperty14              | 79,981      | 539      |                                    |
| ProjectProperty15              | 77,423      | 4,964    |                                    |
| FunctionDisplayName            | 69,872      | 290      |                                    |
| ImportMaterialOriginalNameData | 65,560      | 11,526   |                                    |
| CategoryName                   | 64,698      | 242      |                                    |

### Top 20 owning asset classes after exclusions

| Class                    | Occurrences | Distinct |
| ------------------------ | ----------- | -------- |
| Blueprint                | 4,606,101   | 49,175   |
| LevelSequence            | 2,816,734   | 138,817  |
| DataTable                | 2,303,324   | 141,247  |
| NiagaraSystem            | 1,296,697   | 34,088   |
| World                    | 1,142,232   | 180,281  |
| WidgetBlueprint          | 352,132     | 30,449   |
| StaticMesh               | 320,188     | 10,877   |
| AnimBlueprint            | 239,492     | 4,945    |
| BlueprintGeneratedClass  | 210,298     | 27,528   |
| MaterialInstanceConstant | 194,366     | 17,658   |
| ProjectClass01           | 91,865      | 3,977    |
| PhysicsAsset             | 78,948      | 1,904    |
| ProjectClass02           | 47,184      | 3,829    |
| Material                 | 38,756      | 4,635    |
| PaperSprite              | 32,598      | 2        |
| AnimMontage              | 28,429      | 5,682    |
| ProjectClass03           | 21,666      | 616      |
| AnimSequence             | 20,103      | 11,126   |
| ProjectClass04           | 17,938      | 9,058    |
| SkeletalMesh             | 17,820      | 3,148    |

### Extraction cost and coverage

| Pass | Native wall s | CPU s   | Peak WS GiB | Peak private GiB | Transport wall s |
| ---- | ------------- | ------- | ----------- | ---------------- | ---------------- |
| off  | 94.530        | 460.469 | 3.266       | 3.313            | 94.641           |
| on   | 138.144       | 533.969 | 3.599       | 3.655            | 138.871          |

Observed on-minus-off: wall 43.614 s (46.1%), CPU 73.500 s (16.0%), peak working set 0.333 GiB. One run each; no variance estimate or cache control.

167,401 packages; 6,917,776 successful decoded exports; 139,919 export decode errors; 2,129 partial packages; 653,331 Raw property/container nodes; 0 unresolved names; cap reached: false. No package read failures. Off/on streams are byte-identical: 635,975,448 bytes, SHA-256 020a80b295bf722a0654b583ccffc261853681376306a53f5a91cdffefb6614a.

Top 20 properties cover 71.7% of remaining occurrences; top 40 cover 85.3%; top 20 classes cover 99.5%. Sentence-like values cover 12.8%. These are occurrence proportions, not distinct-value unions.

The CDO bucket alone repeats 20,391 distinct values across 4,198,081 occurrences (205.9 occurrences
per distinct value). Two project-defined properties whose names mark them as localization source
and translation strings (`ProjectProperty05` and `ProjectProperty04`) together contribute 1,446,432
occurrences (10.4% of survivors). Inference from those names: some FString data may already
participate in localization; property type alone cannot establish that text is untranslated.
LevelSequence contributes 2,816,734 occurrences, another indication that the list needs domain
context.

The collector locks once per decoded export and interns strings into one shared table; its
measured overhead includes this instrumentation strategy. It is not a lower bound on the
overhead of a future production implementation.

### Interpretation and verification

A flat list of survivors is not a reliable review inventory. Group by property and owning
asset class, collapse equal values and serialization copies, and let reviewers select relevant
groups before opening individual occurrences. Sentence-like text can form a smaller triage
queue, but editor comments/metadata can also look like prose. Conversely, short labels may be
valid user-visible text. Decoder errors and Raw nodes leave possible text uncounted; false
positives also prevent interpreting survivors as a lower bound on actual user-visible text.

Passed: 32 targeted `uasset-io` project-IO tests (including four probe tests),
`cargo clippy --locked -p uasset-io -- -D warnings`, Rust formatting, runner syntax/lint/format,
`pnpm -s run typecheck`,
the release fixture streaming check (115 packages, zero decode errors, cap not reached),
and aggregate consistency / byte-identity assertions over the two released-project runs.
The fixture reported one partial package. No full suites, Unreal
Editor, Perforce writes, push, PR, or merge ran.

The final audit checked that all changed artifacts omit the input path and project/descriptor
names, that prior attribution sections are byte-for-byte unchanged apart from line-ending
normalization, and that each top-20 property has three distinct example shapes (or all examples
when fewer than three distinct values exist). The compact tables also passed HTML preview with
no console errors.

### Outcome

Status: parked. The hard problem is limiting the scan to strings a player actually sees. Nothing in
a saved package says whether an `FString` or `FName` is shown to players or used as an identifier,
so any scan finds mostly identifiers. The volume figures above show that cost; they are a symptom
of the problem, not the reason for parking. No filter was found: value-shape exclusions and the
sentence-like slice still leave mostly identifiers, and editor comments read like prose while real
labels can be one word. Grouping by property and class makes review possible but still needs a
person to judge each group. Revisit when there is a reliable signal for user-facing text. Two
untested candidates: a string flowing into a widget text setter, which would catch only text set
through those graph pins, and project annotations that mark display fields.

On 2026-10-26 the numbers settled three things. Hardcoded text is not added to the default cold
scan. The scan opens only packages marked as holding gatherable text, and a census must open every
package: 94.5 s of extraction against about 21 s at the time. A flat review list in Game Text is not
built: even the sentence-like slice is 183,940 distinct values, and identifiers lead every group.
`FString` storage does not by itself mean untranslated text: the two project-defined localization
source and translation properties show localization stored in strings. Two candidates were parked
for later. One is an opt-in audit that shows property × asset-class groups and lets a reviewer
accept or dismiss a whole group. The other is narrow, high-signal checks, such as string pins on
widget text setters, which need no census. Neither is planned.

The branch was ported onto `main` at `2585d62b` with one conflict. `main` now verifies staged
packages before and after `project_one_path`, and the probe argument is passed inside that
verification. The runner's request (`uasset-io` v1.8, unstaged `extract_text_packages`) is still
accepted by the current reader. Verification after the port is in the pull request.
