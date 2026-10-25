# Game Text engine measurements

Plan 059 Phase 0, measured on 2026-10-23 at `8b4ce3a4` with the uncommitted measurement
harness. This is a new record because it fixes the host request sequences and measures the
current native engine's public APIs. Earlier pipeline experiments remain in
[shared-index measurements](game-text-shared-index-measurements.md). Each later phase is measured
against this baseline: see [Phase 1 results](#phase-1-results).

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
- So do `engine-load` (a keystroke while rules evaluate, cancel latency, a 5,000-row findings page
  and the engine's working set), `loc-check` and `lines-export` (the all-languages CSV). They run
  `--long-runs` times.
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
| CJK                                 |                6 |            11.55 / 12.09 ms |             12.18 / 16.66 ms |              12.87 / 13.36 ms |
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

## Phase 1 results

Plan 059 Phase 1, measured on 2026-10-24 at `0bd6dbf6`, the head of #167. The harness, commands,
machine and caps are the baseline's. Build and Quality ran once each (`--long-runs 1`), where the
baseline ran them three times; the interactive stages ran three times, as before. The same
scripts reproduce every baseline number above exactly from the baseline's results files, so
the two columns are computed the same way.

| 1× path                                    | Runs | Baseline median | Phase 1 median | Change | Phase 1 p95 | Sampled tree RSS maximum | V8 heap maximum |
| ------------------------------------------ | ---: | --------------: | -------------: | -----: | ----------: | -----------------------: | --------------: |
| Cold build to visible page                 |    1 |        66.999 s |       68.395 s |  +2.1% |    68.395 s |                 2.59 GiB |         244 MiB |
| Open to visible page                       |    3 |         1.897 s |        1.923 s |  +1.4% |     1.954 s |                 0.70 GiB |          75 MiB |
| Cached reopen to visible page              |    3 |         2.957 s |        2.962 s |  +0.2% |     2.968 s |                 0.77 GiB |         131 MiB |
| Quality, captured default checks           |    1 |        94.110 s |      153.005 s | +62.6% |   153.005 s |                 3.40 GiB |         321 MiB |
| Workbench selection, two requests          |    3 |        55.72 ms |       57.37 ms |  +3.0% |    57.38 ms |                 0.77 GiB |         131 MiB |
| Electroswag selection, two requests        |    3 |        56.34 ms |       55.47 ms |  −1.5% |    56.49 ms |                 0.77 GiB |         131 MiB |
| Saturated related-line probe, 444 requests |    3 |       784.24 ms |      789.03 ms |  +0.6% |   847.78 ms |                 0.89 GiB |         130 MiB |

| Released-project path                      | Runs | Baseline median | Phase 1 median | Change | Phase 1 p95 | Sampled tree RSS maximum | V8 heap maximum |
| ------------------------------------------ | ---: | --------------: | -------------: | -----: | ----------: | -----------------------: | --------------: |
| Cold build to visible page                 |    1 |       108.189 s |      112.164 s |  +3.7% |   112.164 s |                 3.94 GiB |         273 MiB |
| Open to visible page                       |    3 |         1.812 s |        1.816 s |  +0.2% |     1.824 s |                 0.66 GiB |          78 MiB |
| Cached reopen to visible page              |    3 |         6.068 s |        6.115 s |  +0.8% |     6.172 s |                 0.80 GiB |         186 MiB |
| Quality, captured default checks           |    1 |       176.291 s |      336.059 s | +90.6% |   336.059 s |                 3.76 GiB |         300 MiB |
| Workbench selection, two requests          |    3 |        83.29 ms |       81.94 ms |  −1.6% |    82.45 ms |                 0.85 GiB |         173 MiB |
| Electroswag selection, two requests        |    3 |        83.38 ms |       83.37 ms |   0.0% |    83.45 ms |                 0.81 GiB |         145 MiB |
| Saturated related-line probe, 444 requests |    3 |       638.17 ms |      600.51 ms |  −5.9% |   613.28 ms |                 1.11 GiB |         149 MiB |

Quality's sampled tree RSS maximum rose from 2.42 to 3.40 GiB on 1× and from 2.76 to 3.76 GiB on
the released project. The cold build's fell from 2.69 to 2.59 GiB and from 4.34 to 3.94 GiB. The
selection rows now include the prepared reader's nearest sample, which the baseline didn't keep,
so their RSS has no baseline to compare. The implicit-default Quality lane wasn't run.

Keystroke categories pool the same prefixes as the baseline tables. On the released project those
tables count every prefix that returns rows as matching, including the two CJK prefixes and the
no-match query's first three. The CJK query sends two requests per keystroke there, so it does
return rows: the baseline table's "no matching rows" label was wrong and is corrected above.

| 1× keystroke category           | Samples per host | Workbench default p50 / p95 | Workbench all-open p50 / p95 | Electroswag default p50 / p95 |
| ------------------------------- | ---------------: | --------------------------: | ---------------------------: | ----------------------------: |
| Matching 1–2 characters, before |                9 |          563.85 / 598.98 ms |           775.93 / 812.91 ms |            588.01 / 612.52 ms |
| Matching 1–2 characters, now    |                9 |          558.64 / 583.45 ms |           821.66 / 853.46 ms |            585.08 / 616.13 ms |
| Matching 3+ characters, before  |               12 |          557.96 / 583.34 ms |           768.17 / 788.04 ms |            581.99 / 597.92 ms |
| Matching 3+ characters, now     |               12 |          583.89 / 703.70 ms |         840.29 / 1,014.68 ms |            606.12 / 652.44 ms |
| CJK, before                     |                6 |            16.23 / 19.75 ms |             17.82 / 25.29 ms |              17.71 / 19.47 ms |
| CJK, now                        |                6 |            17.25 / 26.67 ms |             16.60 / 23.48 ms |              18.67 / 24.59 ms |
| No-match and prefixes, before   |               51 |            15.74 / 21.03 ms |             15.52 / 19.62 ms |              17.82 / 28.82 ms |
| No-match and prefixes, now      |               51 |            18.98 / 28.83 ms |             17.01 / 26.74 ms |              17.72 / 22.90 ms |

| Released-project keystroke category | Samples per host | Workbench default p50 / p95 | Workbench all-open p50 / p95 | Electroswag default p50 / p95 |
| ----------------------------------- | ---------------: | --------------------------: | ---------------------------: | ----------------------------: |
| Matching 1–2 characters, before     |               24 |          204.88 / 389.44 ms |         862.86 / 1,143.93 ms |            215.62 / 389.35 ms |
| Matching 1–2 characters, now        |               24 |          210.67 / 386.51 ms |         910.76 / 1,147.67 ms |            234.33 / 389.06 ms |
| Matching 3+ characters, before      |                9 |          196.54 / 229.78 ms |         758.86 / 1,019.08 ms |            184.18 / 254.98 ms |
| Matching 3+ characters, now         |                9 |          200.41 / 232.12 ms |         776.63 / 1,010.74 ms |            187.11 / 253.33 ms |
| CJK, before                         |                6 |            11.55 / 12.09 ms |             12.18 / 16.66 ms |              12.87 / 13.36 ms |
| CJK, now                            |                6 |            12.39 / 14.87 ms |             11.54 / 17.72 ms |              13.24 / 13.75 ms |
| No-match and prefixes, before       |               51 |            9.24 / 206.72 ms |             7.81 / 827.53 ms |              9.45 / 213.16 ms |
| No-match and prefixes, now          |               51 |            9.40 / 221.52 ms |             8.70 / 884.40 ms |             10.62 / 236.05 ms |

| Project and host state       | Header requests: n, before → now p50 / p95 | Group requests: n, before → now p50 / p95 |
| ---------------------------- | -----------------------------------------: | ----------------------------------------: |
| 1× Workbench default         |   21, 494.41 / 518.29 → 509.73 / 544.44 ms |      21, 59.69 / 77.18 → 62.05 / 72.46 ms |
| 1× Workbench all-open        |   21, 477.83 / 504.43 → 513.86 / 639.45 ms | 105, 186.87 / 303.96 → 207.04 / 317.34 ms |
| 1× Electroswag default       |   21, 523.26 / 538.24 → 538.99 / 562.19 ms |      21, 60.28 / 72.39 → 60.73 / 76.62 ms |
| Released Workbench default   |   33, 185.85 / 343.78 → 193.02 / 339.89 ms |      36, 12.02 / 44.92 → 12.11 / 46.96 ms |
| Released Workbench all-open  |   33, 189.01 / 344.77 → 197.06 / 341.70 ms | 186, 239.11 / 792.41 → 239.58 / 790.92 ms |
| Released Electroswag default |   33, 203.03 / 346.90 → 206.91 / 346.21 ms |       36, 9.91 / 48.16 → 10.07 / 48.37 ms |

### Findings against the baseline

Quality returns **222,592 findings** on 1× (baseline 222,872), SHA-256
`ff1c131a4479b268896506748c6ca372a8a0c06f426babff93129fb1a2ffe8b2`, and **274,829** on the released
project (baseline 276,122), SHA-256 `b1b3fe87d0851ac81d1a0449e02b443f51b8fbcaf7f860fe2d1675d6542f0c30`.
To check the difference, every finding was paged out of `localizationQualitySearch` from both
versions, each on a copy of its measured cache, and the two lists were compared by finding ID:

- **No finding is new** on either project.
- **Removed: 280 findings on 1× and 1,293 on the released project.** All are `whitespace` findings
  on empty translations: 28 lines in ten cultures on 1×, 294 lines on the released project. Each of
  those lines still reports `empty_translation`, and none of its other findings changed. This is
  the removed `empty-translation-whitespace` pin.
- **Changed: 2,022 released-project findings on 578 lines.** Each keeps its ID, severity and
  problem, but its first location moves from the compiled copy of a Blueprint text literal
  (`ScriptBytecode[N]` on the compiled function) to the authored graph pin it came from
  (`Pins[N].DefaultTextValue`), and it lists one location fewer. This is the compiled-copy repair.
  No 1× finding changed.
- The other fact repairs change no finding on either project.

Build, open and cached reopen still agree with each other on each project
(`a2c3e70ee52370e0370fd22c8f3c776163885d4dcad331d7bd3d0c91b3674245` on 1×,
`6b19c93a7b0663f0f8d490e44f3a11903f7a2c6eaceca53084282bb7461ff784` on the released project), but
not with the baseline: the visible page's answer grew by 626 bytes on 1× and 620 on the released
project. The harness keeps hashes, not answers, so the change hasn't been compared field by field.

### Regressions

Against the baseline medians:

- **Quality, captured default checks:** +62.6% on 1× and +90.6% on the released project, with about
  1 GiB more sampled RSS on both.
- **Keystrokes that return rows**, mostly 2–10% slower at p50:
    - 1×, three or more characters: +4.6% (p95 +20.6%) in the Workbench default state, +9.4%
      (+28.8%) all-open and +4.1% (+9.1%) in Electroswag.
    - 1× all-open, one or two characters: +5.9% (+5.0%). Its group requests are 10.8% slower.
    - Released, one or two characters: +5.6% all-open and +8.7% in Electroswag.
    - Header requests: +3.0% to +7.5% at p50 on 1× (all-open p95 +26.8%), and +1.9% to +4.3% on the
      released project.
- **CJK and no-match rows:** up to about 3 ms slower at p50 and 8 ms at p95 on 1×, and some are
  faster. On the released project their p95 is 7–11% higher; it's set by the no-match query's first
  prefixes, which return rows.
- **Cold build:** +2.1% on 1× and +3.7% on the released project, each from one run.

Open, cached reopen, selection, the related-line probe and the released project's three-character
keystrokes are within 3% at the median, or faster. The released probe is 5.9% faster; the 1×
probe's p95 is 7.2% higher.

Measured parts of the Quality stage, from #166 and #167: Quality reads every line's findings back
from the engine as JSON, about 1.3 GB on 1×. It does so in about 2,300 line reads of 64 to 256
lines and about 4,600 unit reads of 256 units. After the first read, a 256-line read took about
55 ms and a 256-unit read 0.7 ms. Evaluating the default catalogue took 12.75 s. The rest of the
stage hasn't been attributed, and the keystroke and build changes haven't been profiled.

The owner reviewed these results on 2026-10-24 and accepted them for Phase 1. Phase 3 moves
sorting, paging and counting of findings into the engine, and Quality stops re-checking lines.

## Phase 2 results

Plan 059 Phase 2, measured on 2026-10-24 at `769f7503` with the same harness, machine and caps.
Build and Quality ran once each, as in Phase 1. The interactive stages also ran once, where Phase 1
ran them three times, so their Phase 2 values are single runs. The Phase 1 values are that record's
medians. The later Phase 2 commits change no finding. The rules file reset, the review fixes and the
CLI work keep the engine's 1× catalogue digest, and the opt-in `shared` and `long` checks aren't in
the starter file.

| Path                                       |        Generated 1× | Released 10-culture project |
| ------------------------------------------ | ------------------: | --------------------------: |
| Cold build to visible page                 |   68.395 → 68.610 s |         112.164 → 110.968 s |
| Open to visible page                       |     1.923 → 1.902 s |             1.816 → 1.808 s |
| Cached reopen to visible page              |     2.962 → 2.974 s |             6.115 → 6.039 s |
| Quality, captured default checks           | 153.005 → 155.755 s |         336.059 → 300.365 s |
| Quality in process, without its worker     |           159.631 s |                   345.195 s |
| Workbench selection, two requests          |   57.37 → 59.95 ms¹ |           81.94 → 85.64 ms¹ |
| Electroswag selection, two requests        |   55.47 → 58.16 ms¹ |           83.37 → 83.03 ms¹ |
| Saturated related-line probe, 444 requests | 789.03 → 849.06 ms¹ |         600.51 → 712.05 ms¹ |

¹ One Phase 2 run.

Quality is +1.8% on 1× and −10.6% on the released project. The three group checks now run in the
engine, and the TypeScript passes that computed them are deleted. Quality's sampled RSS maximum fell
from 3.40 to 3.19 GiB on 1× and from 3.76 to 3.72 GiB on the released project. The released cold
build's rose from 3.94 to 4.59 GiB in this one run; 1×'s fell from 2.59 to 2.55 GiB.

**Findings are unchanged.** Quality's answer has the Phase 1 SHA-256 on both projects
(`ff1c131a…` on 1×, `b1b3fe87…` on the released project), in its worker and in process. Build, open
and cached reopen have the Phase 1 answers (`a2c3e70e…`, `6b19c93a…`).

**The Quality worker stays.** In process, Quality's largest event-loop gap is 741 ms on 1× and
882 ms on the released project; with the worker, 115 ms and 528 ms. Phase 2 required no worse than
the worker's (spec §6). The gaps are the TypeScript scan's paging, sorting and hydration, which
Phase 3 replaces.

**The engine's catalogue** (the 1× timing test at the Phase 2 head) has 24 rules and takes 21.0 s,
against 11.9 s for Phase 1's 21. The group rules account for most of the difference:
`duplicate_source` 3.3 s, `inconsistent_translation` 3.1 s and `culture_invariant_text` 0.5 s.
`existsOther`'s sub-stages are inputs 0.6 s, signatures 0.2 s, sites 0.1 s, tuples 1.8 s, count
1.5 s and match 0.8 s. Its first version took 33.5 s. Expanding each row signature once took it to
8.4 s, and interning values structurally to 5.2 s, each with the same digest.

**`loc check`:**

- On both canonical corpora, its output with the starter checks is byte-identical to Phase 2's
  output before the reset, except for one added `"ruleDiagnostics": []`, which reports carry
  whenever a rules file exists. With `--rules` it is identical to that.
- On the released project, with `--rules` and the starter checks, it completes in 326 s. Its report
  is 625 MB and has 274,829 findings, Quality's count. Before the CLI printed the report in parts,
  `JSON.stringify` of that report exceeded V8's string limit.
- The generated 1× project keeps its text in benchmark records, so the CLI sees its 583,507-line
  join but no packages. It completes in 56 s with 164,426 findings from six evidence checks.

**The corpus fixture.** Both canonical corpora compare with 1,120 subjects and the two pinned
disagreements (`detail-culture-scope`, `manifest-notes-filter`), none unexpected or stale. The new
`shared` and `long` probe agrees with Browse on every line. One 10,000-line fuzz run on UE 5.8
(seed 73131: 11,042 lines, 44,168 subjects) has no unexpected disagreement and no stale defect,
before and after a package edit, and its incremental and full scans agree. Its first run showed
the near miss's expectation was wrong, not the engine: Browse's `unresolved` signal still counts
as a finding problem until Phase 3 (plan decision 16). Quality's check reported nothing there, as
intended.

The owner reviewed these results on 2026-10-24 and accepted them for Phase 2, single-run rows
included. Phase 2 merged in #168.

## Phase 3 results

Plan 059 Phase 3, measured on 2026-10-25 at `357c650e` against Phase 2's accepted head
(`19ac7882`), both on that day with the same harness, machine and caps, so the Phase 2 column is
re-measured rather than copied. Build and Quality ran once each; open, cached reopen, selection
and typing three times. Quality also ran once more on each commit with its rule preview timed, so
its row is the whole path from loading the rules to the first Quality page.

| Path                                         |       Generated 1× | Released 10-culture project |
| -------------------------------------------- | -----------------: | --------------------------: |
| Cold build to visible page                   |  68.105 → 66.515 s |         111.077 → 108.639 s |
| Open to visible page                         |    1.935 → 1.958 s |             1.836 → 1.896 s |
| Cached reopen to visible page                |    2.993 → 3.073 s |             6.126 → 6.189 s |
| Quality, loading the rules to the first page | 184.021 → 30.059 s |          375.701 → 34.634 s |
| … of which the rule preview                  |  40.198 → 29.604 s |           57.313 → 34.198 s |
| … of which the first Quality page            |  143.823 → 0.455 s |           318.388 → 0.436 s |
| Workbench selection, two requests            |   57.41 → 54.83 ms |            82.00 → 79.03 ms |
| Electroswag selection, two requests          |   57.27 → 55.53 ms |            82.43 → 79.63 ms |
| Saturated related-line probe, 444 requests   | 787.84 → 636.30 ms |          604.74 → 546.19 ms |
| One `related` request for the same review    |          198.05 ms |                   129.11 ms |

| Keystroke p50 / p95, Phase 2 → Phase 3                            |                   Generated 1× |        Released 10-culture project |
| ----------------------------------------------------------------- | -----------------------------: | ---------------------------------: |
| Workbench default, matching 1–2 characters                        |       557 / 595 → 300 / 354 ms |           285 / 402 → 111 / 203 ms |
| Workbench default, matching 3+ characters                         |       584 / 609 → 323 / 371 ms |             209 / 239 → 54 / 71 ms |
| Workbench all-open, matching 1–2 characters                       |       826 / 861 → 403 / 433 ms |       1,139 / 1,252 → 204 / 342 ms |
| Workbench all-open, matching 3+ characters                        |       839 / 865 → 412 / 445 ms |         776 / 1,023 → 158 / 167 ms |
| Electroswag default, matching 1–2 characters                      |       589 / 647 → 300 / 353 ms |           299 / 399 → 107 / 160 ms |
| Electroswag default, matching 3+ characters                       |       618 / 642 → 316 / 353 ms |             199 / 260 → 48 / 73 ms |
| No-match query and its prefixes, p95 (WB default / all-open / ES) | 27 / 22 / 25 → 21 / 22 / 21 ms | 205 / 864 / 224 → 51 / 150 / 47 ms |

A keystroke matches when it sent more than a header request. CJK keystrokes stay at 11–25 ms on
both projects.

**Quality.** The first page is now one `findings_query` over the engine's layer, so it no
longer depends on the corpus size. What remains is the rule evaluation, which the preview runs once
for Quality and Browse. Quality's largest event-loop gap is 22 ms on 1× and 24 ms on the released
project, against the Phase 2 worker's 113 ms and 536 ms; the worker is deleted. Quality's sampled
RSS maximum is 4.25 → 4.48 GiB on 1× and 4.34 → 4.72 GiB on the released project, preview
included.

**Findings are unchanged.** Quality's answer has the same SHA-256 at both commits on both projects
under this harness (`9c42c489…` on 1×, `1c820f57…` on the released project). The Phase 2 record's
`ff1c131a…` and `b1b3fe87…` come from the harness before step 5; dumps at Phase 2's accepted head
and at Phase 3's step 4 and 5 all digest to the current values.

**The index.** The cold build is 2.3% faster on 1× and 2.2% on the released project; its sampled
RSS maximum is 2.51 → 2.67 GiB on 1× and 4.04 → 3.85 GiB on the released project. The store is
43.5 → 44.2 MB on 1× and 129.7 → 187.5 MB on the released project, both with their findings layers.
On the released project, the joined layer grew from 36.9 to 99.5 MB: it gained the trigram index
over folded sources and every culture's translations (spec §4) and lost
`query.occurrence.places`. The dependency graph shrank from 13.0 to 7.3 MB without the duplicate
recompute's postings. The layer hasn't been split by section.

**Open and cached reopen** are 1–3% slower in three runs each; neither has been profiled.

**Related lines.** One `related` request gives the review the 444-request probe assembles in
198 ms on 1× and 129 ms on the released project. The probe itself is 19% and 10% faster.

**Parity.**

- `loc check` is byte-identical to Phase 2's on both canonical corpora with the starter rules file.
- The corpus fixture compares 1,120 subjects on each canonical corpus with no disagreement, pinned or
  unexpected. The planted answers now project Browse as Phase 3 shows it: its signals are the four
  facts, and without a findings layer no line has the `finding` problem. The `shared` and `long`
  probe reads those checks through Browse's findings layer, and every line's findings are the rules
  the report lists for it.
- One 10,000-line fuzz run on UE 5.8 (seed 73131: 11,042 lines, 44,168 subjects) has no unexpected
  disagreement and no stale defect, before and after a package edit, and its incremental and full
  scans agree.

The owner reviewed these results and the Workbench screens on 2026-10-25 and accepted them for
Phase 3. The review moved a line's findings into the banner at the top of its page and gave
project rules an optional `label`. Phase 3 merged in #169.

## Phase 4 results

Plan 059 Phase 4, measured on 2026-10-25 at `c973e531` against Phase 3's merge (`9a11b066`), both
on that day with the same harness, machine and caps. Build, Quality, `loc check`, the all-languages
export and the engine-load stage ran once on each commit; open, cached reopen, selection and typing
three times. The engine-load stage repeats its own measures: 28 idle keystroke headers, a keystroke
header after another for as long as two rule previews run, five cancels of each kind and ten
findings pages.

| Path, Phase 3 → Phase 4                    |        Generated 1× | Released 10-culture project |
| ------------------------------------------ | ------------------: | --------------------------: |
| Cold build to visible page                 |   68.307 → 67.424 s |         129.387 → 107.500 s |
| Open to visible page                       |     1.961 → 1.924 s |             1.876 → 1.859 s |
| Cached reopen to visible page              |     3.017 → 3.043 s |             6.206 → 6.163 s |
| First Quality page after the preview       |    429.8 → 335.9 ms |            414.7 → 397.8 ms |
| Workbench selection, two requests          |      51.2 → 52.6 ms |              77.9 → 76.6 ms |
| Electroswag selection, two requests        |      50.7 → 53.1 ms |              79.1 → 76.4 ms |
| Saturated related-line probe, 444 requests |    631.3 → 287.1 ms |            558.5 → 269.7 ms |
| One `related` request for the same review  |    191.5 → 190.4 ms |            128.1 → 126.7 ms |
| `loc check` with the starter rules         | 123.661 → 110.830 s |           41.831 → 31.977 s |
| … its process tree's peak                  |     4.88 → 3.43 GiB |             3.44 → 2.29 GiB |
| All-languages CSV export                   |    fails → 87.640 s |            fails → 56.777 s |
| … its process tree's peak                  |        — → 1.14 GiB |                — → 1.42 GiB |

| Keystroke p50 / p95, Phase 3 → Phase 4                            |                   Generated 1× |      Released 10-culture project |
| ----------------------------------------------------------------- | -----------------------------: | -------------------------------: |
| Workbench default, matching 1–2 characters                        |       293 / 346 → 280 / 340 ms |         114 / 200 → 106 / 189 ms |
| Workbench default, matching 3+ characters                         |       314 / 394 → 314 / 357 ms |              10 / 75 → 9 / 68 ms |
| Workbench all-open, matching 1–2 characters                       |       374 / 439 → 334 / 418 ms |         202 / 345 → 168 / 292 ms |
| Workbench all-open, matching 3+ characters                        |       389 / 443 → 372 / 415 ms |           11 / 162 → 11 / 128 ms |
| Electroswag default, matching 1–2 characters                      |       287 / 353 → 285 / 350 ms |          102 / 162 → 95 / 160 ms |
| Electroswag default, matching 3+ characters                       |       327 / 367 → 310 / 366 ms |              10 / 71 → 8 / 66 ms |
| No-match query and its prefixes, p95 (WB default / all-open / ES) | 21 / 26 / 21 → 19 / 19 / 19 ms | 50 / 165 / 46 → 43 / 113 / 41 ms |

Here the matching keystrokes are the prefixes of `the` and `Taluma`; on the released project their
3+ character prefixes match few lines. CJK keystrokes are 9–14 ms in both phases.

| The engine under load, p50 / p95, Phase 3 → Phase 4 |                 Generated 1× |    Released 10-culture project |
| --------------------------------------------------- | ---------------------------: | -----------------------------: |
| Matching keystroke header, idle                     |     270 / 314 → 277 / 312 ms |         64 / 171 → 59 / 166 ms |
| Matching keystroke header, rules evaluating         |     359 / 443 → 388 / 448 ms |         68 / 203 → 80 / 213 ms |
| Other keystroke headers, rules evaluating           |         15 / 21 → 12 / 25 ms |           14 / 51 → 11 / 51 ms |
| Cancel latency, rule evaluation                     | 26,171 / 26,202 → 40 / 82 ms | 27,781 / 29,168 → 224 / 290 ms |
| Cancel latency, export of every unit                |  60,064 / 60,244 → 2 / 43 ms |   48,850 / 49,134 → −11 / 4 ms |
| A bulk read with nothing to cancel                  | 1,756 / 1,769 → 847 / 895 ms |   1,677 / 1,716 → 864 / 901 ms |
| 5,000-row findings page                             |     688 / 959 → 691 / 899 ms |       359 / 725 → 386 / 621 ms |

| Memory, Phase 3 → Phase 4                   |    Generated 1× | Released 10-culture project |
| ------------------------------------------- | --------------: | --------------------------: |
| The engine's working set, one snapshot open | 2.48 → 1.73 GiB |             2.66 → 2.07 GiB |
| … after a 5,000-line bulk read              | 2.51 → 1.73 GiB |             2.68 → 2.07 GiB |
| Quality, process tree's peak                | 1.98 → 1.34 GiB |             2.15 → 1.49 GiB |
| Engine-load stage, process tree's peak      | 6.22 → 4.13 GiB |             6.24 → 4.19 GiB |

**Cancel.** A cancel's latency is how much longer the next bulk read takes than the same read
with nothing to cancel: an export of every capability that matches no unit, issued as soon as the
interrupt returns, a second into the cancelled work. The interrupt returns in 1–3 ms in both phases.
Phase 3's engine then finished the cancelled evaluation or export before it answered, 26–60 s
later. Phase 4's engine stops at its next check: within 82 ms of an evaluation on 1× and 290 ms on
the released project, and at once for an export (the negative p50 is the idle read's noise). The
idle read itself halved, 1.76 → 0.85 s on 1×.

**Keystrokes while rules evaluate.** The p95 of a matching keystroke's header is unchanged on both
projects (443 → 448 ms, 203 → 213 ms); its p50 is 8% and 18% slower. The rule preview ran about as
long in both phases, judging by the keystrokes it fitted (187 → 186, 548 → 542). The slower p50 has
not been profiled.

**`loc check`** is 10% and 24% faster end to end, and its process tree's peak is 30% and 33%
lower. The report is written as it's composed: the CLI no longer holds the findings as a value or
the report as a string. Both phases report the same number of findings (222,592 and 274,829). The
peak is the whole tree's; the host and the engine haven't been separated.

**The all-languages CSV export** fails in Phase 3 on both projects with `RangeError: Invalid string
length`: the file is one string, and it's longer than a string can be. Phase 4's
`cultureLinesCsv` sink writes 583,507 rows in 87.6 s on 1× and 264,585 rows in 56.8 s on the
released project. Its first version held every line's fields while sorting and reached a 13 GB
tree on 1×; it now holds only the sort keys and reads each line's fields again as it writes them.

**The 5,000-row findings page** is unchanged: a page of batches takes as long as Phase 3's page of
JSON did. On 1×, of its 690–750 ms the engine's `compose` stage takes 450–490 ms: it builds each
finding with its places, one at a time, about 95 µs a finding. Selecting, ordering and counting
take under 3 ms, and the host's thread spends 46–94 ms. The rest is the 12 MB page crossing the
session and being parsed. The page's findings carry their affected occurrences, about 2.4 KB a
finding.

**Memory.** With one snapshot open, the engine's working set is 30% and 22% smaller. It doesn't
grow with a 5,000-line bulk read in either phase.

**The rest** is within run-to-run noise. The released project's cold build is a single run, and
Phase 3's own record measured 108.6 s for the same commit. The saturated related-line probe
halved on both projects; the single `related` request it is compared with is unchanged.

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
