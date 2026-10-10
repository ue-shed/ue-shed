# Shared Game Text index measurements

Recorded 2026-10-10, Windows / Node 26.11.1. Cold import, ordinary PO refresh and size targets
pass; the reader reference gaps remain explicit. Retained projects/saved joins were reused;
no regeneration, 1× join rebuild or legacy 10× pipeline. Heap cap 16,384 MiB/process, total RSS
20 GB; one heavy child at a time. Every 10× command has one absolute 900 s startup-to-cleanup
deadline; expiry is failure. Cold plus stat/edit/restore completed in 677.76 s.
Times are single runs without OS cache eviction; cold means an empty derived store.
Largest child RSS was 8.58 GiB during projection; observed concurrent verification stayed below
20 GB. Content-hash keys, stat fast path, CRCs, oracle comparisons and atomic generations remain.

Cold profiling found repeated per-file traversal of earlier segments: at 10×, en/de/fr PO
probe time was 2.980 / 3.944 / 3.778 s with 4 / 7 / 9 segments already present; whole-file time
rose 22.13 → 27.25 s. At 1×, PO probing rose 0.356 → 0.458 s as segments grew 4 → 23.
The serial design has growing, potentially quadratic work. The cold target now parses in worker
threads, externally sorts all strings once in 64 MiB runs, globally deduplicates exact bytes and
publishes one segment per nonempty domain with every layer under one lock/root. Both scales use
eight workers: largest-file incremental RSS 248 / 692 MiB, with a 2 GB minimum per-worker budget,
4 GB coordinator reserve and CPU/count caps. Cold parse/sort/layer encode took 9.74/15.25/2.63 s
at 1× and 159.29/407.40/51.37 s at 10×; cold probing is zero. Peak cold RSS 2.45 / 6.77 GiB.

Reader profiling found mixed blocks expanding nearly all domains: native zstd 2.90 s, varints
2.72 s, cursor expansion 2.50 s and GC 2.34 s in the initial CPU profile. Separate sorted domains
now decode directly to contiguous UTF-8 plus typed offsets per segment, without a JS string per
entry; byte scans fold ASCII directly and only decode Unicode where casing requires it. Domain
loads fell from 10.77/8.19/10.01 s to 2.638 / 0.274 / 1.573 s. Source owns 933.74 MB / 6.96 million
strings, including native input beyond Phase 2's saved source table; front-code reconstruction
and validation remain extra work over Phase 2's direct zstd expansion. Culture/path gaps remain.
Earlier separate-domain probes were 2.31/0.242/1.305 s; these single timings vary, and the final
reader table retains the slower run. The contiguous decoder removes scratch copies and per-entry
UTF-8 validation, but front-code varints/prefix reconstruction still cost more than direct raw
domain decompression, including for the culture/path domains.
The first page touches 243 frames / 1,765,028 bytes versus Phase 2's four / 68,988 bytes. An 8 MiB
decoded cache thrashed (zero repeat hits); 32 MiB holds all 249 touched blocks in 16,399,140 backing
bytes and restores repeats to 0.88 ms. First-page locality remains unresolved; block size stays 64.

Refresh profiling isolated 7.043 s of previous-file ID reuse, versus 10.963 s parse/finish and
0.045 s verification. Native layers now retain SHA-256 local-block stamps and remappable local→global
ID vectors. Exact unchanged blocks reuse IDs without decoding the previous file; changed blocks
hydrate only their old candidates, preserving implicit source-equal translations and GUID case.
Broad edits and old layers retain identity/byte matching. Hashing and parsing already share one
bounded read. Full verification remains: its measured cost is small. Native reuse maps add about
72 MiB of 10× layers before compaction versus the earlier store, keeping size under target. Parsing remains
the largest cost; the CPU-profiled run took 13.573 s parse / 1.248 s finish and missed 20 s.
Ordinary runs pass; entry-boundary parse workers would address further parse-latency headroom,
but were not measured because no ordinary refresh required them.

| Exclusive refresh stages, seconds            |       Before fix, 10× |   Final ordinary, 10× |
| -------------------------------------------- | --------------------: | --------------------: |
| Read / hash / UTF-8 decode                   | 0.461 / 0.286 / 0.222 | 0.558 / 0.285 / 0.299 |
| Parse / finish                               |         9.976 / 0.987 |        11.217 / 0.959 |
| Collect / block or identity diff + ID reuse  |         0.878 / 7.043 |         1.016 / 0.504 |
| Layer encode / verify                        |         1.151 / 0.045 |         1.131 / 0.092 |
| Obsolete-reference diff / root publish       |         0.392 / 0.013 |         0.543 / 0.015 |
| Cached-key lookup                            |                 0.006 |                 0.005 |
| Dictionary probe / append                    |         0.404 / 0.006 |         0.567 / 0.007 |
| Discovery / stat / scope cleanup / remaining |                 0.312 |                 0.467 |

| Whole index MiB                          |    1× compacted |    10× full width |     10× compacted |    10× four edits | 10× full-width forecast |
| ---------------------------------------- | --------------: | ----------------: | ----------------: | ----------------: | ----------------------: |
| Dictionary / indexes / directory         |           11.06 |            129.93 |             95.14 |             95.14 |                  150.60 |
| Active localization / join layers        |           18.81 |            335.68 |            335.63 |            335.63 |                  335.68 |
| Package proxy / publication / stat hints |            2.87 |             28.35 |             27.26 |             27.26 |                   28.36 |
| Retained inactive layers                 |            0.00 |              5.43 |              0.00 |             21.79 |                   21.79 |
| **Whole / target**                       | **32.74 / 100** | **499.40 / 1024** | **458.03 / 1024** | **479.82 / 1024** |       **536.43 / 1024** |

The full census exactly matches 78,066,945 strings / 7,707,973,974 UTF-8 bytes; compaction
leaves 51,981,412 / 5,733,848,265. Forecast takes the largest of full measured dictionary bytes,
per-owner payload×UTF-8 and index×count scaling, or compact dictionary×1.501824, then the largest
measured layers/proxy/metadata/retained bytes. No pruning credit. Package proxy remains an
estimate; synthetic compression does not establish real-content or complete Phase 4 size.

| Operation                                     |                      1× |                     10× | Target / result                                           |
| --------------------------------------------- | ----------------------: | ----------------------: | --------------------------------------------------------- |
| Cold target                                   |          29.18 s; 21/21 |         647.36 s; 41/41 | ≤38 / ≤696 s: pass                                        |
| Stat-hit target                               |                 0.088 s |                 0.190 s | ≤5 / ≤30 s: pass; zero authored bytes                     |
| Fresh one-byte PO                             |                  1.95 s |  16.04–17.67 s ordinary | 10× ≤20 s: ordinary pass                                  |
| Fresh PO with CPU profiler                    |                       — |                 21.41 s | misses 20 s; retained diagnostic                          |
| Edit lookup / reused local strings            |             1 / 396,093 |           1 / 3,960,855 | only one new string looked up                             |
| Compaction / saved projection                 |         17.27 / 19.60 s |       220.73 / 333.66 s | 14 / 26 domain segments; no join rebuilt                  |
| Directory / hot columns                       |        12.75 / 57.95 ms |       41.79 / 383.01 ms | 10× query/open ≤1 s: pass                                 |
| Reader peak V8 heap, sampled and pre-GC trace |               71.82 MiB |               99.93 MiB | ≤128 / ≤256 MiB: pass                                     |
| Source / culture / paths load                 | 0.125 / 0.001 / 0.399 s | 2.638 / 0.274 / 1.573 s | 10× references 0.83 / 0.20 / 1.40 s: gaps explained above |
| Source / culture / paths scan                 | 0.057 / 0.002 / 0.081 s | 0.858 / 0.050 / 0.451 s | 10× ≤1 s: pass                                            |
| Page columns / 300 strings                    |         40.63 / 5.44 ms |      385.55 / 106.51 ms | 5.75 ms reference first-page gap explained                |
| Repeat 300-string page                        |                 0.45 ms |                 0.88 ms | faster than 5.75 ms reference                             |
| Page frames / bytes                           |              2 / 18,800 |         243 / 1,765,028 | only touched blocks decoded                               |
| Native folder query / hydration oracle        |       82.51 / 154.21 ms |     439.62 / 1167.20 ms | 131,558 / 1,315,580 matches; oracle agrees                |
| Saved folder range / scan oracle              |       66.56 / 273.32 ms |      378.17 / 815.56 ms | /Game/: 1,159,763; Package: 1,315,580                     |

Exact commands are in [the scale guide](../../scripts/game-text-scale.md); all Vitest commands
use one worker. Final results:

| Command                                                                      |                                                          Passed |                            Failed |
| ---------------------------------------------------------------------------- | --------------------------------------------------------------: | --------------------------------: |
| New codec/sort/shared/importer Vitest                                        |                                                              69 |                                 0 |
| Requested localization/game-text/scale/importer/dictionary Vitest            |                                           510; 4 existing skips |                                 0 |
| Node 26 codec/sort/format/file/store/shared/importer/scale/dictionary Vitest |                                                             175 |                                 0 |
| Localization + game-text builds / compiled worker smoke                      |                                            2 packages / 3 files |                                 0 |
| Package + script typechecks / focused lint / Effect architecture             |                                              2 / 1 / 1 commands |                                 0 |
| Changed-file oxfmt / precommit                                               | 15 files / 6 stages; 43 architecture tests; 4 contract packages |                                 0 |
| Final supervised benchmark commands                                          |                                                         10 runs |   0; profiled refresh misses 20 s |
| Earlier diagnostic/profile/iteration benchmark commands                      |                                                         11 runs | 0; excluded from final acceptance |

An early focused run passed 59 tests and failed one (missing empty root); fixed. Early schema
mutability/type-narrowing and focused lint errors were fixed before the final passing gates.
UE 5.7 committed localization output oracle: 7 files pass; UE 5.8: 7 files pass. Live editor/UAsset
matrix checks were not run: no Unreal API, UAsset parser, codegen or fixture changed. Full
`pnpm check` was not run. Remaining: first-page locality, source/culture/path load reference gaps,
refresh margin under profiling, full package fields and Phases 4–7. No commits, pushes, branch
switches or stashes. Evidence is `speed-final-*.json`, `speed-profile-before-{1,10}x.json`,
`speed-reader-{before,after,cache8,cache32}-10x.json`, `speed-refresh-profile-before-10x.json`
and `speed-full-width-forecast.json` under `test-results/game-text-scale` (ignored).

## Phase 4 reader step, incomplete package layer

Recorded 2026-10-10, Node 26.11.1, release native reader. The opt-in v1.8 operation aggregates
occurrences and coverage before transport; corpus fields and the legacy operation are preserved.
Shared-store column encoding, package signatures, removal and cold sorting remain open. Existing
TextCorpusService/localization/CLI/Workbench/scale consumers still use the legacy stream.
ADR 0007 explains why the reader emits records while TypeScript owns derived storage.

These measurements use explicit Git-tracked Content packages. Ignored copies from other test
lanes are excluded, and source-only roots have an explicit empty selection. They measure native
projection/serialization/transport rather than candidate discovery or refresh. Full NDJSON bytes
include accepted/result/completed control frames. Wall time includes startup but excludes schema
decoding and the corpus oracle; each capture has a 120-second deadline and 128 MiB output limit.
Timings are individual runs without OS cache eviction. New package frames are capped at 64 MiB.

| Committed fixture root                                          | Packages | Units / occurrences / gaps | Old / new bytes |    Old / new ms | Old / new frames |
| --------------------------------------------------------------- | -------: | -------------------------: | --------------: | --------------: | ---------------: |
| `unreal-project`                                                |       83 |                62 / 71 / 1 | 93,731 / 83,720 | 116.22 / 106.59 |         161 / 89 |
| `legacy-unreal-project` (source only)                           |        0 |                  0 / 0 / 0 |       785 / 803 |   12.70 / 12.65 |            3 / 3 |
| `legacy-unreal-project/Generated/4.27`                          |        3 |                27 / 33 / 1 | 24,702 / 12,908 |   14.88 / 14.67 |           43 / 9 |
| `legacy-unreal-project/Generated/5.3`                           |        3 |                27 / 33 / 1 | 25,579 / 13,819 |   14.40 / 14.70 |           43 / 9 |
| `unreal-427-localization` (no saved packages)                   |        0 |                  0 / 0 / 0 |       787 / 805 |   13.47 / 12.52 |            3 / 3 |
| `perforce-map-history/revisions/baseline`                       |        7 |                  0 / 0 / 0 |   5,881 / 7,194 |   15.59 / 15.10 |          13 / 13 |
| `perforce-map-history/revisions/add-arrival`                    |        1 |                  0 / 0 / 0 |   2,020 / 2,223 |   13.80 / 13.56 |            7 / 7 |
| `perforce-map-history/revisions/conventional-baseline`          |        1 |                  0 / 0 / 0 |   1,959 / 2,162 |   14.17 / 14.62 |            7 / 7 |
| `perforce-map-history/revisions/conventional-move-actor`        |        1 |                  0 / 0 / 0 |   1,965 / 2,168 |   13.88 / 14.84 |            7 / 7 |
| `perforce-map-history/revisions/label-north`                    |        1 |                  0 / 0 / 0 |   2,020 / 2,223 |   13.90 / 14.16 |            7 / 7 |
| `perforce-map-history/revisions/move-east`                      |        1 |                  0 / 0 / 0 |   2,014 / 2,217 |   13.69 / 13.40 |            7 / 7 |
| `perforce-map-history/revisions/two-unclassified-package-edits` |        2 |                  0 / 0 / 0 |   2,783 / 3,171 |   14.99 / 13.49 |            8 / 8 |

All twelve old/new corpus and outcome comparisons pass. Empty packages are larger because their
record adds complete gap counters. Current and legacy text fixtures benefit from fewer envelopes.
The reusable corpus oracle compares every unit/occurrence field and diagnostic, preserving evidence
multiplicity. It passes at generated recipe scales 0.0001, 0.001 and 0.002. It also passes through
the public reader on the existing generated UE 5.7 and UE 5.8 matrix fixtures: each has 62 text units
and 71 occurrences. These are reader-record oracles; no persistent package layer has been hydrated.

The projected reader output uses Context counts, prior Plan 056 byte totals and measured fixture
sample widths. No real project or real content was accessed:

| Projection input / result                             |                                Value |
| ----------------------------------------------------- | -----------------------------------: |
| Packages / occurrences / gaps                         |      166,518 / 1,028,205 / 4,800,000 |
| Prior total / gap output                              |                      3.26 / 2.50 GiB |
| Maximum retained samples                              |          499,554 (three per package) |
| Mean raw gap sample JSON                              | 137.33 bytes (three fixture samples) |
| Worst-width counters + empty sample field per package |                            234 bytes |
| Retained prior non-gap output                         |                           778.24 MiB |
| Samples, separators and counters                      |                           103.06 MiB |
| **Projected output / reduction**                      |           **881.30 MiB / about 74%** |

The estimate retains all previous non-gap output, including per-occurrence envelopes and
diagnostics, so it claims no occurrence-grouping savings. The sample width is conditional on
fixture content; real widths can differ. This forecast is neither a native real-project measurement
nor an index-size acceptance result. Full scale acceptance remains unmeasured:

| Package layer operation | 1×           | 10×          | Target                            |
| ----------------------- | ------------ | ------------ | --------------------------------- |
| Cold build / layer size | Not run      | Not run      | Actual package columns required   |
| No-change refresh       | Not run      | Not run      | ≤5 / ≤30 s                        |
| One-package refresh     | Not run      | Not run      | Combined package + PO ≤10 / ≤60 s |
| Whole shared index      | Not measured | Not measured | ≤100 MiB / ≤1 GiB                 |

Commands run serially with the retained Node 26 runtime on PATH, `NODE_OPTIONS=--max-old-space-size=16384`
and `npm_config_workspace_concurrency=1`. Test TEMP/TMP point inside repository test-results.
Only the explicitly configured UE 5.7/5.8 roots were used for live engine lanes. No retained
scale project was regenerated; no legacy 10× run or real-project run occurred.

```powershell
cargo test --locked -p uasset-io
cargo clippy --locked -p uasset-io --all-targets -- -D warnings
cargo fmt --all -- --check
pnpm --filter @ue-shed/protocol contract:generate
pnpm --filter @ue-shed/protocol build
pnpm --filter @ue-shed/unreal-assets build
pnpm --filter @ue-shed/game-text build
pnpm exec vitest run packages/protocol/src/uasset-io.test.ts scripts/package-text-record.test.ts scripts/package-text-reader.test.ts --maxWorkers=1
pnpm exec vitest run packages/unreal-assets packages/game-text packages/localization scripts/game-text-scale.test.ts scripts/localization-import.test.ts scripts/game-text-dictionary.test.ts scripts/package-text-record.test.ts scripts/package-text-reader.test.ts apps/cli/src/index.e2e.test.ts apps/cli/src/localization-status.integration.test.ts apps/cli/src/localization-report.integration.test.ts apps/cli/src/localization-gate.integration.test.ts apps/cli/src/localization-check.integration.test.ts --maxWorkers=1
pnpm test:uasset-engine-matrix
node --import tsx scripts/verify-package-text-engine.ts out/uasset-engine-matrix-9IShIm
pnpm test:localization-processes
cargo build --locked --release -p uasset-io
node --import tsx scripts/benchmark-package-text-reader.ts
pnpm exec tsc -p tsconfig.scripts.json --noEmit
pnpm exec oxfmt <changed-files>
pnpm run check:precommit
```

| Verification command                                              |                                                                                         Passed |         Failed / skipped |
| ----------------------------------------------------------------- | ---------------------------------------------------------------------------------------------: | -----------------------: |
| Cargo test, final                                                 |                                                                   95 (78 library + 17 process) |            0 / 1 ignored |
| Cargo clippy / fmt check / release build                          |                                                                                 1 / 1 / 1 gate |                        0 |
| Protocol generation + protocol/reader/game-text builds            |                                                                                     4 commands |                        0 |
| Focused protocol/record/reader Vitest                             |                                                                                             35 |                        0 |
| Broad requested package/scale/import/dictionary/native CLI Vitest |                                                                                            621 | 0 / 42 skipped; 13 files |
| Native release benchmark/oracle                                   |                                                                               12 fixture roots |                        0 |
| UE engine matrix, 5.7                                             | 1 lane; 13 native tests; WASM 23 inspection / 12 authoring / 8 compact fixtures + review gates |                        0 |
| UE engine matrix, 5.8                                             | 1 lane; 13 native tests; WASM 23 inspection / 12 authoring / 8 compact fixtures + review gates |                        0 |
| Final public reader corpus oracle, 5.7 / 5.8                      |                                                                                          1 / 1 |                    0 / 0 |
| Localization processes, 5.7                                       |                                                             1 lane; seven supported operations |                        0 |
| Localization processes, 5.8                                       |                                                             1 lane; seven supported operations |                        0 |
| Final scripts typecheck                                           |                                                                                      1 command |                        0 |
| Changed-file oxfmt                                                |                                                                    All supported changed files |                        0 |
| UAsset / Effect architecture checks                               |                                                                                     1 / 1 gate |                        0 |
| Final precommit                                                   |                                           6 stages; 43 architecture tests; 4 contract packages |                        0 |

Initial explicit fixture selection, sample mutation, type-narrowing, lint and encoding failures
were corrected before final passing checks. UE 4.27/5.3 live matrix
checks were skipped because those installations are outside this run's authorization; their
committed saved fixtures were verified. Full `pnpm check` was not run. Engine-matrix fixtures are
repository-owned disposable copies; the final native reader oracle ran after the serialization-cap
change against both already-generated fixtures.

Remaining: signature refresh/removal, TextProperty candidate policy, shared-domain occurrence IDs,
one cold sort, layer oracle and all scale measurements. The existing String Table exception has
not changed: committed `ST_Game` has text but no TextProperty header name, so strict TextProperty-only
selection conflicts with oracle equality. `phase4-reader.json`, `phase4-engine-text.json`,
`phase4-vitest.log`, `phase4-localization-processes.log` and `phase4-precommit.log` retain ignored
evidence under test-results. Matrix results are retained under repository `out/`.
