# Game Text engine baseline and transport experiment

Plan 059 Phase 0, measured on 2026-10-23 at `8b4ce3a4` with the uncommitted measurement
harness. This is a new record because it fixes the host request sequences and measures the
current native engine's public APIs. Earlier pipeline experiments remain in
[shared-index measurements](game-text-shared-index-measurements.md).

## Reproduction

Use Node 26.12.0, `RAYON_NUM_THREADS=16`, `CARGO_BUILD_JOBS=8` and
`UE_SHED_UNREAL_LOCK` pointing to the machine's shared heavy-job lock. The command takes that
lock exclusively and records its owner and UTC acquisition time. It waits in 30-second steps,
stops after two hours, and releases its own lock in `finally`. Each stage has a fresh process,
a 16,384 MiB V8 heap ceiling, a 20,000,000,000-byte process-tree working-set ceiling and a
1,200-second deadline. No Unreal or Perforce process is involved.

`$env:BENCH_1X_PROJECT` identifies the retained generated 1× project;
`$env:BENCH_RELEASED_PROJECT` identifies the released project's directory. Their resolved
values belong in the local command manifest, never in this repository. `$env:BENCH_SCRATCH`
is the caller's writable scratch directory, including `TEMP` and `TMP`. Set
`UE_SHED_UASSET_EXECUTABLE` to the release reader being measured. The explicit lock and resource
variables are required, rather than silently inferred from this machine.

The read-only audit follows `index-steps.ts` preparation into native builder/store publication,
the localization evidence reader and the Quality worker.
Index, Catalog, writer staging and `native-read-*` directories use the supplied cache root;
worker input/output uses the benchmark output root. Node temporary files use
the caller's external `TEMP`/`TMP`. Review and rule files are read as inputs; the harness previews
the captured rules and never calls save, starter-rule creation, review or edit operations.
Its workspace file hook rejects writes, and no Perforce hook is provided. None of
these measured operations writes `Saved/` or invokes Unreal. The top-level driver rejects cache
and output directories inside the project, including linked writable ancestors.

```powershell
$env:RAYON_NUM_THREADS = "16"
$env:CARGO_BUILD_JOBS = "8"
$env:TEMP = "$env:BENCH_SCRATCH/temp"
$env:TMP = $env:TEMP
pnpm install --frozen-lockfile --ignore-scripts
pnpm run build:typescript-packages
# Run the release build while holding the same exclusive machine lock.
cargo build --locked --release -p uasset-io
pnpm benchmark:game-text-engine --project $env:BENCH_1X_PROJECT --generated `
  --output test-results/game-text-engine/baseline-1x
pnpm benchmark:game-text-engine --project $env:BENCH_RELEASED_PROJECT `
  --output "$env:BENCH_SCRATCH/baseline-released"
```

Hold the same exclusive lock around release builds. `--generated` validates the retained
recipe and saved-text census and converts the saved reader events once, using the existing
scale harness adapter. Conversion has its own reported stage; cold-build time starts after
conversion. A preconverted directory can instead be supplied with `--records`.

**What a default run includes.**

- The stages are `build,open,cached-reopen,quality,typing,selection`, so a later phase can
  re-measure in about 15 minutes per project.
- Interactive stages run `--runs` times (default 3).
- Build and Quality run `--long-runs` times (default 1): their spread across three runs was about
  2%. Interactive repetitions past the last build reuse that build's cache.
- `quality-default` (the host's implicit checks) and `overhead` (the per-request breakdown, with
  `--instrument`) run only when `--stages` names them.
- Pass `--long-runs 3` when a long-stage result is close.
- A stage that answers with a failure stops the run.

`--stages` selects comma-separated stages. `--cache` reuses an existing cache root (`run-1` …)
for additional stages. Build refuses an existing cache. Results and per-worker logs are under the
output directory; the result schema includes machine, commit, caps, replay data, fixed Quality
rules, per-answer SHA-256 and per-request quantiles. The first differing answer or request
sequence stops the comparison. Existing stage output directories are refused, so reruns cannot
silently mix old timing side files into fresh results. Choose a new output directory per command.

## What is timed

The replay data is [`game-text-engine-mix.json`](../../scripts/game-text-engine-mix.json).
It cites the host route and helper lines that define each sequence. Measurements call the
workspace, `NativeTextQuery` and the workspace Quality operation. They exclude renderer paint,
host RPC routing, user think time and the renderer's 120 ms trailing debounce. Each typed
prefix is a keystroke admitted by that debounce, including the one- and two-character
prefixes, longer words, CJK and a no-match query.

- Build refreshes an empty cache through index readiness and the first default visible page.
- Open pins a built snapshot in a fresh process and loads the grouped header plus the default
  open group's rows. Cached reopen also verifies unchanged project signatures.
- Quality runs all default checks. `quality-default` uses the host's implicit defaults;
  `quality` previews the captured v3 defaults without saving project rules. Both are retained:
  later defaults may change, while the captured checks provide a fixed comparison workload.
- Typing records each request and the entire header-plus-open-groups fan-out. Default-open and
  all-open Workbench states and Electroswag's editor-excluding state use separate fresh processes.
- Ordinary selection runs focus and detail concurrently. The saturated Electroswag load probe
  sends `4 + 20 + 20 × (1 + 20) = 444` requests with the host's concurrency bounds. It repeats
  valid IDs if fewer related partners exist; this does not assert 20 × 20 conflicts in the input.
- Overhead opens both native lanes before timing requests; a one-line projection prepares the
  bulk lane. A medium request measures one projection; process spawn
  and index open finish before its timer starts. Startup is measured separately by the spike.

Latency ends before answer hashing. Nested request hashes are deferred until the whole fan-out
finishes. Canonical hashes preserve row order and UTF-16, including lone surrogates. OS working-set
samples include child readers; V8 GC logs cover worker isolates whose synchronous work blocks JS sampling. Sampling
is suspended during verification hashes. Working set is sampled, rather than an exact OS peak.
Quantiles use nearest rank; three independent stage repetitions give a median and an observed
maximum as p95. Request tables pool the specified repeated requests and state their sample count.
Answer hashes check repeatability; the planted fixture corpus remains the correctness gate.

Event-loop observations are callback gaps from a 10 ms interval, including the unfinished gap
when a request completes. Normal Windows timer gaps here are about 15–16 ms. This catches
synchronous work that finishes before the first callback, and includes that timer floor.

## Baseline results

The machine is Windows 11 build 26200, a Ryzen 9 5950X (32 logical processors) and
63.9 GiB physical RAM. Node is 26.12.0; Rust is
`1.93.0-nightly (b6d7ff3aa 2025-11-14)`. Native thread caps are 16 Rayon threads and eight
Cargo jobs. Builds use the normal optimized release profile. Cold means a new cache, rather
than an emptied Windows filesystem cache.

The validated 1× recipe has 132,606 keys, ten cultures, 166,518 packages, 16,500 text packages,
1,028,205 occurrences and 4,800,000 planted gaps. Its saved inputs contain 3,598,115,431 bytes
across 22 census files. The default joined list has 583,507 rows; keys, units and localization
rows are different counts. Do not compare the joined row count directly with the recipe's keys.

| 1× path                                    | Repetitions |    Median |       p95 | Sampled tree RSS maximum | V8 heap maximum |
| ------------------------------------------ | ----------: | --------: | --------: | -----------------------: | --------------: |
| Cold build to visible page                 |           3 |  66.999 s |  67.035 s |                 2.69 GiB |         249 MiB |
| Open to visible page                       |           3 |   1.897 s |   1.908 s |                 0.73 GiB |          86 MiB |
| Cached reopen to visible page              |           3 |   2.957 s |   2.965 s |                 0.78 GiB |         131 MiB |
| Quality, implicit default checks           |           3 |   84.66 s |   84.83 s |                 2.25 GiB |         307 MiB |
| Quality, captured default checks           |           3 |  94.110 s |  94.214 s |                 2.42 GiB |         307 MiB |
| Workbench selection, two requests          |           3 |  55.72 ms |  55.82 ms |        See sampling note |         130 MiB |
| Electroswag selection, two requests        |           3 |  56.34 ms |  56.49 ms |        See sampling note |         128 MiB |
| Saturated related-line probe, 444 requests |           3 | 784.24 ms | 790.74 ms |                 0.90 GiB |         128 MiB |

Both Quality paths return **222,872 findings**, SHA-256
`af0302fb2e3c6a0fc4c268cd7e312c5e65c18334b0b6c25acda8bb6716947838`.
The captured profile costs about 11% more despite the same findings. The cause of that difference
has not been profiled; these are distinct public Quality configurations.
The implicit-default control is in `quality-1x`; its historical stage name is `quality`, before
the fixed-profile lane was added. The explicit-profile and remaining numbers are in
`baseline-final-1x`. Build, open and cached reopen agree on
`18c9f5ac648e662592ed7279705af0f30dcd042e96644a54a889a36e9234a3a6`.

The two-request probes can finish between OS samples. Their Node RSS alone is not a process-tree
peak; no such number is claimed here. The harness now retains the nearest prepared-reader
sample for short stages. GC heap readings are maximum observed isolate usage, not a sum of
simultaneous heaps. Hashing and setup are excluded from the timing interval.

| 1× keystroke category           | Samples per host | Workbench default p50 / p95 | Workbench all-open p50 / p95 | Electroswag default p50 / p95 |
| ------------------------------- | ---------------: | --------------------------: | ---------------------------: | ----------------------------: |
| Matching 1–2 character prefixes |                9 |          563.85 / 598.98 ms |           775.93 / 812.91 ms |            588.01 / 612.52 ms |
| Matching 3+ character prefixes  |               12 |          557.96 / 583.34 ms |           768.17 / 788.04 ms |            581.99 / 597.92 ms |
| CJK                             |                6 |            16.23 / 19.75 ms |             17.82 / 25.29 ms |              17.71 / 19.47 ms |
| No-match query and its prefixes |               51 |            15.74 / 21.03 ms |             15.52 / 19.62 ms |              17.82 / 28.82 ms |

Matching default-open keystrokes send two requests; all-open sends six. Empty results send one.
The two longer prefixes of `the` also return no rows and remain individually recorded in the raw
results; they are excluded from the matching categories above.
The CJK query has no matches in this particular generated project, so it tests Unicode request
handling and the empty-result path rather than claiming a matching-CJK search measurement.
Individual request timings and hashes are retained beside each whole-keystroke sample. Pooling
the many no-match prefixes with matching words would conceal the roughly half-second matching
keystrokes, so the table keeps the categories separate.

The released 10-culture project's default joined list has **264,585 rows** across all audiences
and target/outside-target states. This is a broader view than the approximately 172,000-line
localization deliverable described in the plan. Its corpus units and its joined list rows are
different populations, as on 1×. The same unchanged input and index are used throughout these runs.

| Released-project path                      | Repetitions |    Median |       p95 | Sampled tree RSS maximum | V8 heap maximum |
| ------------------------------------------ | ----------: | --------: | --------: | -----------------------: | --------------: |
| Cold build to visible page                 |           3 | 108.189 s | 110.271 s |                 4.34 GiB |         323 MiB |
| Open to visible page                       |           3 |   1.812 s |   1.814 s |                 0.70 GiB |          75 MiB |
| Cached reopen to visible page              |           3 |   6.068 s |   6.077 s |                 0.81 GiB |         191 MiB |
| Quality, implicit default checks           |           3 | 168.927 s | 169.459 s |                 2.56 GiB |         324 MiB |
| Quality, captured default checks           |           3 | 176.291 s | 195.468 s |                 2.76 GiB |         347 MiB |
| Workbench selection, two requests          |           3 |  83.29 ms |  85.15 ms |        See sampling note |         133 MiB |
| Electroswag selection, two requests        |           3 |  83.38 ms |  83.49 ms |        See sampling note |         133 MiB |
| Saturated related-line probe, 444 requests |           3 | 638.17 ms | 649.95 ms |                 1.11 GiB |         197 MiB |

Both Quality configurations return **276,122 findings**, SHA-256
`5c000972194fdc9922ed3b3328c645bf3d29bf6e0f848e48f9f4fb63ab551ce3`.
All build/open/reopen answers agree on
`956cebdc8c733cfdf2c548ee89abe1e4c947d1aaf6e6e9b6dc60d53f0b00ae20`.
The captured-profile pass has a wider spread than the implicit-default pass, despite identical
findings; retain all three raw samples rather than treating its slowest pass as a new median.

| Released-project keystroke category | Samples per host | Workbench default p50 / p95 | Workbench all-open p50 / p95 | Electroswag default p50 / p95 |
| ----------------------------------- | ---------------: | --------------------------: | ---------------------------: | ----------------------------: |
| Matching 1–2 character prefixes     |               24 |          204.88 / 389.44 ms |         862.86 / 1,143.93 ms |            215.62 / 389.35 ms |
| Matching 3+ character prefixes      |                9 |          196.54 / 229.78 ms |         758.86 / 1,019.08 ms |            184.18 / 254.98 ms |
| CJK, no matching rows               |                6 |            11.55 / 12.09 ms |             12.18 / 16.66 ms |              12.87 / 13.36 ms |
| No-match query and its prefixes     |               51 |            9.24 / 206.72 ms |             7.81 / 827.53 ms |              9.45 / 213.16 ms |

The initial prefix of the eventual no-match query does match rows here. Its high p95 is therefore
a real admitted keystroke with results, rather than the latency of the final empty query. Default
open sends one to three requests and all-open one to nine, depending on the result groups.

These per-request numbers include client queueing when the host issues parallel group reads.
They use only requests whose result total is nonzero; they must not be added to reconstruct a
whole-keystroke percentile.

| Project and host state       | Header requests: n, p50 / p95 | Group requests: n, p50 / p95 |
| ---------------------------- | ----------------------------: | ---------------------------: |
| 1× Workbench default         |        21, 494.41 / 518.29 ms |         21, 59.69 / 77.18 ms |
| 1× Workbench all-open        |        21, 477.83 / 504.43 ms |      105, 186.87 / 303.96 ms |
| 1× Electroswag default       |        21, 523.26 / 538.24 ms |         21, 60.28 / 72.39 ms |
| Released Workbench default   |        33, 185.85 / 343.78 ms |         36, 12.02 / 44.92 ms |
| Released Workbench all-open  |        33, 189.01 / 344.77 ms |      186, 239.11 / 792.41 ms |
| Released Electroswag default |        33, 203.03 / 346.90 ms |          36, 9.91 / 48.16 ms |

## Instrumentation details

Rust timings require the `benchmark-timings` Cargo feature and
`UE_SHED_GAME_TEXT_MEASURE_DIR`. Default builds compile those calls out. TypeScript publishes
on `ue-shed.game-text-benchmark` only when a subscriber exists; without one it performs no
per-request measurement clock reads or timing-object allocations. `--instrument` subscribes
and writes a separate TS NDJSON file after the timed stage. Rust writes a per-process side file
keyed by protocol request ID. The public request and response contract is unchanged.

```powershell
cargo build --locked --release -p uasset-io --features benchmark-timings
pnpm benchmark:game-text-engine --project $env:BENCH_1X_PROJECT `
  --records "$env:BENCH_SCRATCH/scale-records" `
  --cache test-results/game-text-engine/baseline-1x/caches `
  --output test-results/game-text-engine/overhead-1x --stages overhead --instrument
```

Spans report exclusive Rust durations for frame decode/validation, engine request validation,
payload decode/validation, compute, payload encoding and frame encoding. TS reports domain
schema/stringify, client schema, outer stringify, frame parsing/schema, bulk-file read and
payload parsing/schema. Rust's pipe-write duration and TS's write callback are observed
separately. Process clock origins are not aligned: combined pipe transfer, queueing and
scheduling time is the round trip minus the non-overlapping measured parts. The two pipe
directions cannot be separated by these clocks. A write callback overlaps child work and must
not be subtracted a second time. Bulk JSON currently travels through a temporary file; its
native encode/write and TS file-read/decode costs are explicitly separate.

The corrected instrumented reader has SHA-256
`cfdd665305fdac1651b213153ec3999147b187642635a6b29a609d22e7ea048d`.
An inherited executable had the older combined `bulkEncodeAndWrite` span. Those diagnostic
runs are excluded; the harness now rejects that obsolete span instead of attributing it to
pipe time. The corrected reader separates JSON encoding, buffered writes and flushes.

The overhead runs have 90 small observations and three at 5,000 rows per project.
Round-trip p50 / p95 / p99 is **34.50 / 46.56 / 310.65 ms** and **2,131.34 / 2,175.85 /
2,175.85 ms** on the generated project. The small series includes the first metadata request
in each fresh process. Larger p95 and p99 values are the observed maximum of three.

| Generated request part, median milliseconds  | 50 rows with counts/facets | 5,000 rows |
| -------------------------------------------- | -------------------------: | ---------: |
| TS schema validation and encoding            |                      0.077 |      1.580 |
| Rust decode and validation                   |                      0.079 |     31.447 |
| Engine compute                               |                     16.311 |  1,282.841 |
| Rust JSON encoding                           |                     10.311 |    481.082 |
| Bulk buffered writes and flush               |                          0 |     46.649 |
| TS frame parse and validation                |                      0.887 |      0.220 |
| TS payload parse and decode                  |                      4.197 |    252.939 |
| TS bulk-file read                            |                          0 |     27.754 |
| Pipe, queue, scheduling and cleanup residual |                      1.697 |      4.817 |

These are medians of individually derived parts; their sum need not equal the median round
trip. Write-callback medians are 0.113 / 0.421 ms and native pipe-write medians 0.472 / 0.050 ms;
they overlap other work and are not additional elapsed stages. The 5,000-row JSON request has
a median maximum event-loop gap of **258.54 ms**, alongside 252.94 ms of payload decoding.

The released project's corresponding round-trip p50 / p95 / p99 values are **56.03 / 85.87 /
294.61 ms** and **9,390.41 / 9,397.43 / 9,397.43 ms**. The same sample counts and tail
qualifications apply.

| Released request part, median milliseconds   | 50 rows with counts/facets | 5,000 rows |
| -------------------------------------------- | -------------------------: | ---------: |
| TS schema validation and encoding            |                      0.107 |      1.328 |
| Rust decode and validation                   |                      0.084 |     28.968 |
| Engine compute                               |                     38.299 |  8,729.063 |
| Rust JSON encoding                           |                      8.630 |    363.336 |
| Bulk buffered writes and flush               |                          0 |     32.267 |
| TS frame parse and validation                |                      0.870 |      0.229 |
| TS payload parse and decode                  |                      3.316 |    197.160 |
| TS bulk-file read                            |                          0 |     16.250 |
| Pipe, queue, scheduling and cleanup residual |                      1.631 |      6.148 |

Its write-callback medians are 0.111 / 0.380 ms and native pipe-write medians 0.465 / 0.042 ms.
The 5,000-row request's median maximum event-loop gap is **203.32 ms**. All instrumented
requests correlate with exactly one native request; no negative residual or timing overlap
was observed in either project's corrected runs.

The command correlates TS samples with native request IDs and adds the breakdown to each
overhead sample's metrics. `pipeQueueResidualMs` is the round trip minus the observed encode,
decode, compute and bulk-file costs. Accepted-frame parsing can overlap native compute;
`measurementOverlapMs` retains any excess instead of reporting negative transfer time. These
are elapsed observations and a residual, not aligned one-way pipe clocks. Write callback and
native pipe-write durations remain separate observations and are not subtracted twice.

Measurement work is disabled by construction. Rust timing calls and their module are compiled
out without the `benchmark-timings` feature. TypeScript checks `hasSubscribers` before taking
measurement clocks, allocating timing objects or publishing; without a subscriber it publishes
nothing. The owner ended collection after choosing the pipe, so the instrumentation-off timing
comparison was not run.

## Transport experiment

The disposable experiment uses the same `EngineSession`, pinned reader and query implementation
for every transport. The 50-row request contains the counts and facets from the replay data;
5,000 and all-row requests project identity, source, origin, audience, manifest, marks and places. Every prototype returns
four `u32` tree columns and a deduplicated WTF-8 arena. Object keys use canonical JavaScript order;
arrays retain native row order. Hashing reads those columns without constructing a second bulk
JS object graph. Engine compute excludes measured column encoding; transport overhead is
round trip minus compute, so it includes column construction and transfer.

This is a generic tree-column encoding of the existing answers, not the future relation-specific
batch layout. It retains field names, parent coordinates and type tags to prove full answer
equality. Its bulk size and packing cost must not be presented as a forecast for the new
engine. `encodeMs` reports that shared packing cost; `deliveryMs` additionally subtracts it
from the round trip, leaving framing, transfer and delivery to Node. The decision must consider
both the full overhead and this narrower observation.

The modes are a length-prefixed pipe in the existing `uasset protocol-session` executable,
immutable mapped files plus `fs.read` into a reusable buffer, immutable mapped files exposed
through a native view, and an asynchronous Node-API reader. Each mapping has one published
immutable lifetime; the native view retains it until Buffer GC. The filesystem variant flushes
before `ReadFile` and unlinks after reading. Native-view files are removed after the worker exits.
The native module uses Node-API 8 with napi-rs.

The spike lives in a separately saved patch, outside the intended baseline commit. Apply it to
reproduce its driver, then use a scratch JSON manifest containing `output`, `binary`, `addon`,
and `projects` (`name`, `project`, `cache`, `runs`). Set `runs` to three for the generated
project and two for the released project. The recorded matrix has three alternating rounds on the generated project and two on the
released project. Every answer hash is checked before proceeding. Each process sends 30 small
requests and one request at each larger size: 90 / 60 small observations and three / two at
each larger size, respectively. The owner ended collection after released round two. For larger
sizes, p95 and p99 are the observed maximum. Nearest-rank p50 of two observations is the lower
one; none of these larger-size tails is a well-sampled percentile estimate. The outer watchdog holds the shared lock
and samples the full process tree. The script consumes the baseline replay file; the column
microbenchmark does not replace the workspace selection and Quality measurements.

```powershell
node scripts/transport-spike/matrix.ts "$env:BENCH_SCRATCH/transport-manifest.json"
```

The matrix builds the pipe and addon separately under the exclusive lock: enabling the addon
feature in the executable's Cargo
dependency graph would introduce module registration into an ordinary child executable.
Copy the produced DLL to a `.node` filename for Node's loader. The matrix loads that binary in Node 26. Electron 43 compatibility was not probed.

The filesystem variant reuses its read buffer for the size probes. A typing fan-out retains
several answers, so it copies each retained answer before admitting the next read into that
buffer. That ownership cost belongs to the fan-out; hashes are still computed after its timer.

The replay also exercises ordinary focus/detail selection and the saturated 444-request
sequence, with a serialized native admission lane and the host's concurrent callers. The JSON
control's small and medium answers seed the cross-mode hash checks. All-row answer equality
is checked between all column transports and rounds.
Windows CPU counters measure the child process, the Node main thread and, for Node-API, the
native worker thread separately. Windows CPU counters have coarse resolution; zero for a
short request is not evidence of no CPU work. Node process CPU already includes native worker
CPU in the in-process mode, so those values must not be added together.

The spike watchdog's tree RSS peak includes verification hashing. Size and typing latency and
event-loop observations end before verification hashing. The separate selection replay
materializes columns and computes their canonical digests while driving dependent reads;
its whole-sequence time includes that work and is not a pure transport measurement.

## Transport results: generated 1× project

| Mode       | Rows     | Round trip p50 / p95 / p99, ms | Overhead median, ms | Delivery median, ms | MB/s: answer / overhead |
| ---------- | -------- | ------------------------------ | ------------------: | ------------------: | ----------------------- |
| pipe       | 50       | 20.22 / 33.27 / 278.44         |                2.97 |                0.52 | 17.44 / 117.43          |
| pipe       | 5000     | 1449.52 / 1593.93 / 1593.93    |              169.32 |               24.33 | 13.15 / 112.59          |
| pipe       | All rows | 92672.10 / 93398.34 / 93398.34 |            16265.60 |             2162.72 | 17.51 / 99.76           |
| shm-fs     | 50       | 22.16 / 36.01 / 279.66         |                4.86 |                2.28 | 15.92 / 72.11           |
| shm-fs     | 5000     | 1502.04 / 1532.39 / 1532.39    |              181.87 |               31.94 | 12.69 / 104.82          |
| shm-fs     | All rows | 93122.66 / 96546.12 / 96546.12 |            17255.95 |             2905.41 | 17.42 / 94.03           |
| shm-native | 50       | 19.18 / 27.37 / 293.01         |                3.18 |                0.79 | 18.38 / 111.01          |
| shm-native | 5000     | 1440.51 / 1476.30 / 1476.30    |              163.14 |               16.86 | 13.23 / 116.85          |
| shm-native | All rows | 93022.92 / 93828.12 / 93828.12 |            15532.49 |             1189.56 | 17.44 / 104.47          |
| napi       | 50       | 19.40 / 32.24 / 283.03         |                2.61 |                0.13 | 18.14 / 134.80          |
| napi       | 5000     | 1504.76 / 1506.46 / 1506.46    |              156.09 |                5.79 | 12.67 / 122.14          |
| napi       | All rows | 96361.14 / 97860.43 / 97860.43 |            15015.75 |              328.89 | 16.84 / 108.06          |

| Mode       | Rows     | Node main / native CPU median, ms | Callback gap median / worst, ms |
| ---------- | -------- | --------------------------------- | ------------------------------- |
| pipe       | 50       | 0.00 / 15.63                      | 17.33 / 24.50                   |
| pipe       | 5000     | 15.00 / 1437.50                   | 23.67 / 25.02                   |
| pipe       | All rows | 1578.00 / 90906.25                | 1851.81 / 2069.08               |
| shm-fs     | 50       | 0.00 / 15.63                      | 15.83 / 24.40                   |
| shm-fs     | 5000     | 0.00 / 1437.50                    | 20.26 / 22.59                   |
| shm-fs     | All rows | 218.00 / 91953.13                 | 23.47 / 23.88                   |
| shm-native | 50       | 0.00 / 15.63                      | 17.09 / 23.48                   |
| shm-native | 5000     | 0.00 / 1437.50                    | 16.36 / 17.80                   |
| shm-native | All rows | 203.00 / 92828.13                 | 20.79 / 25.50                   |
| napi       | 50       | 0.00 / 15.63                      | 17.33 / 24.23                   |
| napi       | 5000     | 0.00 / 1500.00                    | 17.74 / 18.94                   |
| napi       | All rows | 187.00 / 96171.88                 | 24.11 / 25.47                   |

| Mode       | Startup median / maximum, ms | Sampled tree RSS maximum, GiB |
| ---------- | ---------------------------- | ----------------------------: |
| pipe       | 849.99 / 854.05              |                          3.67 |
| shm-fs     | 840.48 / 863.06              |                          3.82 |
| shm-native | 848.35 / 848.79              |                          3.28 |
| napi       | 835.14 / 849.01              |                          3.24 |

All modes return 352,912 bytes for 50 rows, 19,063,641 bytes for 5,000 rows and
1,622,604,734 bytes for all rows. Answer throughput divides column bytes by round trip;
overhead throughput divides them by round trip minus engine compute. Both include work
beyond link transfer. Overhead includes column packing; delivery subtracts packing as well.

## Transport results: released 10-culture project

Two rounds per mode: 60 small requests and two observations at each larger size.

| Mode       | Rows     | Round trip p50 / p95 / p99, ms    | Overhead p50, ms | Delivery p50, ms | MB/s: answer / overhead |
| ---------- | -------- | --------------------------------- | ---------------: | ---------------: | ----------------------- |
| pipe       | 50       | 51.02 / 97.42 / 369.42            |             2.93 |             0.60 | 4.97 / 101.26           |
| pipe       | 5000     | 8748.47 / 9286.48 / 9286.48       |           133.53 |            14.09 | 1.39 / 93.87            |
| pipe       | All rows | 396055.50 / 408498.62 / 408498.62 |          8752.25 |           926.87 | 1.83 / 85.20            |
| shm-fs     | 50       | 54.65 / 82.22 / 299.45            |             4.69 |             2.33 | 4.88 / 63.22            |
| shm-fs     | 5000     | 8784.02 / 9461.50 / 9461.50       |           142.75 |            21.92 | 1.36 / 88.32            |
| shm-fs     | All rows | 411340.32 / 415196.80 / 415196.80 |          8926.08 |          1118.73 | 1.80 / 74.78            |
| shm-native | 50       | 42.62 / 74.64 / 286.75            |             3.05 |             0.88 | 4.88 / 97.41            |
| shm-native | 5000     | 9001.81 / 9185.62 / 9185.62       |           130.15 |            11.77 | 1.40 / 93.25            |
| shm-native | All rows | 420827.54 / 444355.17 / 444355.17 |          8597.99 |           531.93 | 1.69 / 73.15            |
| napi       | 50       | 61.09 / 94.08 / 355.64            |             2.49 |             0.19 | 4.87 / 119.19           |
| napi       | 5000     | 9226.41 / 10685.70 / 10685.70     |           130.49 |             4.58 | 1.21 / 81.29            |
| napi       | All rows | 428211.83 / 435162.36 / 435162.36 |          8453.84 |           136.83 | 1.72 / 81.02            |

| Mode       | Rows     | Node main / native CPU p50, ms | Callback gap p50 / worst, ms |
| ---------- | -------- | ------------------------------ | ---------------------------- |
| pipe       | 50       | 0.00 / 62.50                   | 17.51 / 24.69                |
| pipe       | 5000     | 31.00 / 8734.38                | 18.41 / 20.42                |
| pipe       | All rows | 1375.00 / 394125.00            | 800.94 / 838.50              |
| shm-fs     | 50       | 0.00 / 46.88                   | 17.61 / 24.82                |
| shm-fs     | 5000     | 0.00 / 8734.38                 | 16.53 / 18.84                |
| shm-fs     | All rows | 750.00 / 409718.75             | 22.64 / 36.32                |
| shm-native | 50       | 0.00 / 46.88                   | 17.29 / 25.68                |
| shm-native | 5000     | 0.00 / 8937.50                 | 16.70 / 24.95                |
| shm-native | All rows | 828.00 / 419781.25             | 25.20 / 35.09                |
| napi       | 50       | 0.00 / 46.88                   | 17.83 / 50.18                |
| napi       | 5000     | 16.00 / 9218.75                | 38.44 / 44.99                |
| napi       | All rows | 1048.00 / 426906.25            | 27.55 / 39.67                |

| Mode       | Startup p50 / maximum, ms | Sampled tree RSS maximum, GiB |
| ---------- | ------------------------- | ----------------------------: |
| pipe       | 860.19 / 880.97           |                          1.93 |
| shm-fs     | 860.37 / 913.82           |                          1.99 |
| shm-native | 862.99 / 864.82           |                          2.02 |
| napi       | 852.23 / 884.61           |                          1.96 |

All modes return 297,633 bytes for 50 rows, 12,880,349 bytes for 5,000 rows and
749,134,065 bytes for all rows. Parts are quantiled independently; use individual raw records
for an additive breakdown.

## Decision

Choose **(a), length-prefixed binary frames over the existing child-process pipe**. The owner
accepted this decision after three generated-project rounds and two released-project rounds.
Pipe delivery p50 is 0.52 ms of a 20.22 ms small round trip on the generated project and
0.60 ms of 51.02 ms on the released project. Native views and in-process calls save fractions
of a millisecond there. The filesystem path costs about 2.3 ms of delivery on both projects.
The measured overhead does not dominate engine compute, so keep the process boundary.

The main costs are **engine compute and column construction**, especially for all rows.
These belong to Phase 3 and 4. In the pipe:

| Project and rows       | Engine compute p50 | Column construction p50 | Delivery p50 |
| ---------------------- | -----------------: | ----------------------: | -----------: |
| Generated 1×, 50       |           17.13 ms |                 2.40 ms |      0.52 ms |
| Generated 1×, 5000     |         1280.20 ms |               145.77 ms |     24.33 ms |
| Generated 1×, all rows |        76476.20 ms |             14033.18 ms |   2162.72 ms |
| Released, 50           |           46.76 ms |                 2.26 ms |      0.60 ms |
| Released, 5000         |         8614.94 ms |               119.44 ms |     14.09 ms |
| Released, all rows     |       387263.15 ms |              7824.41 ms |    926.87 ms |

The all-row pipe round trip is 92.67 s p50 on the generated project and 396.06–408.50 s
over the two released-project rounds. Moving those same answers through another transport
leaves the expensive hydration and generic column construction in place. The future
relation-specific engine should produce the bounded column batches already required by
Plan 059. The monolithic prototype also has large pipe callback gaps: up to 2.07 s on the
generated project and 0.84 s on the released project. Batch construction and consumption
must remain part of the Phase 3/4 measurements. No receiver-worker project benchmark ran.

## Probe coverage and artifacts

| Probe                                                              | Recorded coverage                                                        |
| ------------------------------------------------------------------ | ------------------------------------------------------------------------ |
| Node 26 pipe, filesystem, native view and N-API                    | All sizes, typing and selection; matching hashes in three / two rounds   |
| Receiver-worker ownership smoke                                    | Synthetic 8 MiB frame passed; no native-engine or project timing run     |
| Electron 43 main and utility-process ABI                           | Not run                                                                  |
| Intentional Rust panic, damaged index and cancellation comparisons | Not run                                                                  |
| Instrumentation-off timing against origin/main                     | Not run; measurement work is disabled by construction as described above |

The owner stopped collection after the active released round-two mode finished. Outstanding
ABI, failure, cancellation and off-timing comparisons were moot under the pipe decision.
No Electron compatibility or comparative failure behavior is claimed.

All 180 distinct size, typing and selection answer keys agree across modes and rounds.
The JSON control also agrees for the 50-row and 5,000-row projections. Five early selection
records retained an extra untimed seed focus in their request-array metadata. Their saved
times and hashes were calculated before that seed. Derived summaries verify each hash
against the first two requests and retain the original raw files. All saturated probes
contain exactly 444 requests.

Raw generated baseline runs are in ignored `test-results/game-text-engine/baseline-final-1x`,
with the implicit-default Quality control in `quality-1x`. Released baseline and corrected
overhead records are under `$env:BENCH_SCRATCH`. The transport matrix is in
`$env:BENCH_SCRATCH/transport-final`; its validated summary and answer hashes are
`transport-summary.json` and `transport-answer-hashes.json`.

The saved `transport-spike.patch` contains the experimental crate, direct-reader visitor,
transport scripts and their feature/dependency wiring. Those paths are removed from the
worktree. The retained changes are the baseline, its tests, opt-in measurement instrumentation
and this record. `git apply --check` verifies the patch on top of that retained diff.

## Verification

The retained default release reader builds without the spike. Its SHA-256 is
`98dad26316a6444bc4b3e61e96165149df12227eb5ccbd220369497c559a3f72`.
Seven standalone harness tests, 324 architecture tests and 37 targeted Vitest tests pass.
Typecheck, lint, formatting, Rust tests with and without timing instrumentation, and both
Clippy configurations pass. Lint retains existing repository warnings. Builds and heavy
checks use the shared lock and the recorded thread caps; Rust tests use eight test threads.

```powershell
cargo build --locked --offline --release -p uasset-io
node --test scripts/game-text-engine-results.test.ts
pnpm run test:architecture
pnpm run typecheck
pnpm run lint --threads 16
pnpm exec oxfmt --check . --threads 16
node scripts/test.ts --config vitest.node.config.ts `
  packages/game-text/src/native-query.integration.test.ts `
  packages/game-text/src/native-query-unicode.integration.test.ts `
  packages/game-text/src/native-query-lifetime.test.ts `
  packages/unreal-assets/src/protocol-transport.test.ts `
  scripts/game-text-scale.test.ts scripts/game-text-scale-safety.test.ts --maxWorkers 1
cargo test --locked -p game-text-index -p uasset-io --all-targets
cargo test --locked -p game-text-index -p uasset-io --all-targets `
  --features uasset-io/benchmark-timings
cargo clippy --locked -p game-text-index -p uasset-io --all-targets -- -D warnings
cargo clippy --locked -p game-text-index -p uasset-io --all-targets `
  --features uasset-io/benchmark-timings -- -D warnings
cargo fmt --all -- --check
git apply --check "$env:BENCH_SCRATCH/transport-spike.patch"
```
