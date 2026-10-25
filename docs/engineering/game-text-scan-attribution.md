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
