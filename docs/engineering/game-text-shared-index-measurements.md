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
