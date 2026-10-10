# Shared Game Text index measurements

Plan 057 Phase 3 integration, 2026-10-10, Windows / Node 26.11.1. **A64 is in production;
size and stat-hit targets pass, cold import and 10× PO refresh targets fail.** Retained projects
and Phase 2 snapshots were reused; no project regeneration, 1× join rebuild or legacy 10× pipeline.
One heavy child at a time: 16,384 MiB heap, 20 GB OS RSS, 1,200 s/stage, and an absolute **900 s
end-to-end deadline on every 10× run**. Expiry kills the tree and records failure. A parent byte
guard restores edited PO inputs, including after forced termination. Stage changes cannot reset caps.

## Decision and implementation

The committed A/B/C comparison is retained below; cells are **1× / 10×**. These were standalone
saved-section probes with compressed inputs in memory, not importer timings. Sizes include indexes,
directories and padding; all candidates used the same domain compression policy.

| Candidate     |     Dictionary MiB |           Build s | Modeled append s |   Scattered pages ms | Folder bounds ms |
| ------------- | -----------------: | ----------------: | ---------------: | -------------------: | ---------------: |
| **A64**       | **10.69 / 194.64** | **10.92 / 63.51** | **2.40 / 22.64** | **142.11 / 2119.57** |  **0.82 / 0.72** |
| B, BBHash     |     62.42 / 785.42 |      7.30 / 97.99 |     1.22 / 19.92 |     333.52 / 1850.24 | 262.66 / 2594.37 |
| C, hash pages |     80.37 / 976.19 |    15.02 / 238.80 |     2.40 / 43.89 |     348.60 / 2299.58 | 271.29 / 4709.96 |

A64 replaces production hash pages/Bloom filters. Immutable segment IDs are base + UTF-8 sort rank;
64-string blocks have sparse first-key/frame/offset indexes. Cold builds collect bytes, offsets and
radix-sort IDs in external typed buffers, encode each block once, retain compressed frames outside
V8 and write once with persisted CRC verification. Offsets widen above 4 GiB. No native dependency
or FST was added. Canonical 32-hex GUIDs use 16 bytes plus a tag and optional uppercase mask;
noncanonical text uses front-coded suffixes. Tests recover exact original case and text.

Sorted unresolved requests probe matching domains/newer segments first, then other domains. Each
segment gets one ordered pass after a sparse seek; complete bytes confirm equality. **256 segments
is the ceiling.** Compaction globally merges live strings into one immutable segment, remaps every
active layer and publishes one generation; existing readers retain old handles. Ownership pages
and conservative block masks preserve lazy domain loading and the Phase 2 page-decode representation.
Root version 2/importer version 5 invalidate the disposable hash cache. Bounds, typed failures,
checksums, locking and atomic publication remain enforced.

Previous-file reuse comes from the active path publication or stat hint. Identity matching handles
reordering/duplicates; unchanged values reuse that file's IDs, including implicit translations using
the old source. Only unresolved strings enter segment probes; a missing prior version falls back
to full sorted lookup. Refresh counts below include repeated local values in spill blocks.

## Whole index and operation targets

| Whole index MiB                                   |    1× compacted | 10× full-width before compaction |     10× compacted | 10× after four edits | 10× width-preserving forecast |
| ------------------------------------------------- | --------------: | -------------------------------: | ----------------: | -------------------: | ----------------------------: |
| Dictionary, including indexes/ownership/directory |           10.80 |                           128.99 |            101.38 |               101.38 |                        152.25 |
| Active localization/join layers                   |           15.32 |                           263.61 |            292.72 |               292.72 |                        292.72 |
| Package proxy/publications/stat hints             |            2.88 |                            28.36 |             39.84 |                39.84 |                         39.85 |
| Retained inactive layers                          |            0.00 |                             4.42 |              0.00 |                18.33 |                         18.33 |
| **Whole / target**                                | **29.00 / 100** |                **425.37 / 1024** | **433.94 / 1024** |    **452.27 / 1024** |             **503.14 / 1024** |

The pre-compaction production census preserves all **78,066,945 strings / 7,707,973,974 UTF-8
bytes**; its owner counts/widths match the retained historical census exactly. Compaction prunes
26,085,533 strings / 1,974,125,709 bytes, leaving 51,981,412 strings / 5,733,848,265 bytes.
Forecasting restores the full count/width: take the larger of per-owner measured payload/UTF-8 and
index/key scaling (128.99 MiB), or the complete mixed dictionary scaled by max(count ratio, UTF-8
ratio), 1.501824 (152.25 MiB). Charge the largest measured fixed layers, proxy, metadata and retained
bytes. No pruning credit is taken. Global ranks enlarge layer/proxy ID streams, explaining why
compaction reduces dictionary size but increases whole size. The proxy is the existing package
estimate, not a complete Phase 4 package index; synthetic compression is not a real-content forecast.

| Operation                            |       1× measured |                            10× measured | Target / result                           |
| ------------------------------------ | ----------------: | --------------------------------------: | ----------------------------------------- |
| Cold files                           | 52.89 s, 21 files | **failed at 900.14 s**, 35/41 completed | ≤38 s / ≤696 s: fail; >900 s always fails |
| Stat-hit target                      |           0.095 s |                                 0.178 s | ≤5 s / ≤30 s: pass                        |
| Fresh one-byte PO                    |            2.45 s |                                 27.49 s | 10× ≤20 s: fail                           |
| Edit lookup / reuse / segment passes |   1 / 396,093 / 2 |                       1 / 3,960,855 / 1 | only changed string looked up             |
| Forced compaction                    |           25.95 s |                                175.63 s | one segment, all active layers remapped   |
| Saved-section projection             |           23.85 s |                                298.22 s | retained snapshots; no join rebuilt       |

The final failed 10× cold run completed 884.85 s of file stages. The earlier deadline failure
completed 29/41 files at 900.20 s; a separate 431.46 s resume completed that store for
projection/reader/compaction measurements. Neither the partial sum nor resume establishes a cold pass.
Other fresh edit measurements before the final reuse fix were 21.75–30.30 s; the final profiled
fresh byte took 26.49 s, one lookup/3,960,855 reuses/one probe, with 0.201 s stat hits. Repeated edits
that hit historical content keys are excluded; the harness now fails unless the edit parses one file.
Refresh timing includes parsing, prior mapping, dictionary work and publication; whole refresh runs
also include restored-input preparation/cleanup (43.21 s profiled). No final 10× run exceeded its
heap/RSS caps; the largest measured OS RSS was about 8.6 GiB during saved-section projection.

## Reader operations and parse profile

| Reader operation                       |                      1× |                       10× |
| -------------------------------------- | ----------------------: | ------------------------: |
| Directory / hot columns                |         9.91 / 49.95 ms |         27.28 / 384.61 ms |
| Source / selected culture / paths load | 0.337 / 0.144 / 0.811 s | 10.995 / 8.420 / 10.037 s |
| Source / culture / paths scan          | 0.095 / 0.001 / 0.298 s |   1.117 / 0.104 / 0.967 s |
| Page columns / 300 strings             |         39.29 / 4.93 ms |         381.28 / 68.64 ms |
| Page frames / bytes read               |              1 / 14,388 |           188 / 2,560,332 |
| Folder range / independent scan oracle |       71.24 / 256.89 ms |        367.50 / 712.88 ms |
| Folder matches                         |     `/Game/`: 1,159,763 |      `Package`: 1,315,580 |

10× historical hash-store source/culture/paths loads were 1.180/0.146/0.564 s; the 300-string
page was 5.75 ms (four frames/68,988 bytes). Sorted global numeric synthetic prefixes interleave
owners, so each selected domain decodes nearly every mixed block (77–81 MiB read), and scattered
ranks touch 188 frames. Front-code expansion adds CPU work. This is a substantial, explained
regression; 32 MiB frame caching and lazy returned domains remain bounded. Page columns improve
from 453.08 to 381.28 ms; directory/hot open remains comparable. The 1× folder is a saved path
range; 10× uses a stored basename prefix after the independent oracle showed `/Game/` and `1/`
had no live matches. Native PO common folder prefixes live once in file metadata; full native
folder selection combines that prefix with suffix ranges. Separate native folder probes include
path/flag column loads, range bounds and row intersection: **62.05 / 387.90 ms**, selecting
131,558 / 1,315,580 references under the PO's actual common folder. Independent bounded hydration
oracles agree in 113.31 / 1116.46 ms. Store open and metadata discovery precede these query timers.

The supervised `--cpu-prof` parse probe reads 632,193,682 bytes / 1,326,060 rows. Before/after:
**12.56 / 12.01 s** (48.00 / 50.19 MiB/s), one run each. Top self costs before → after in seconds:
PO blocks 2.025→1.687; column arena additions 1.963→1.824; identity IDs 1.278→1.351;
simple entry parsing 0.846→0.776; feed 0.658→0.696; GC 0.568→0.524. Cheap fixes trim once,
fast-path ordinary `msgstr`, and split simple unescaped Unreal contexts without the general escape
parser. Oracles retain multiline, escaped, BOM, duplicate identity and chunk-boundary coverage.
The single run pair shows a 4.4% improvement, not a statistical guarantee; parsing alone still
consumes most of the refresh budget. Profiles and JSON/logs are under `test-results/game-text-scale`.

## Verification and remaining work

[Exact commands](../../scripts/game-text-scale.md) use one test worker and serial workspace checks.

| Command                                                           |                                               Passed |                   Failed |
| ----------------------------------------------------------------- | ---------------------------------------------------: | -----------------------: |
| Focused new codec/shared/importer Vitest                          |                                                   63 |                        0 |
| Requested localization/game-text/scale/importer/dictionary Vitest |                                504; 4 existing skips |                        0 |
| Node 26 format/file/store/shared/importer/scale/dictionary Vitest |                                                  169 |                        0 |
| Localization + game-text package build                            |                                           2 packages |                        0 |
| Changed-file oxfmt                                                |                                             22 files |                        0 |
| `pnpm run check:precommit`, final                                 | 6 stages; 43 architecture tests; 4 contract packages |                        0 |
| `pnpm run check:precommit`, first attempt                         |                                             2 stages | 1 typecheck stage, fixed |

| Supervised benchmark command, retained evidence | Passed runs |                      Failed runs |
| ----------------------------------------------- | ----------: | -------------------------------: |
| 1× `--select all`                               |           1 |                                0 |
| Fresh 10× `--select cold`                       |           0 |              2 deadline failures |
| Diagnostic cold resume                          |           1 | 0; excluded from cold acceptance |
| 10× `--select parse --profile`                  |           2 |                                0 |
| 10× `--select projection`, `compact`, `reader`  |           3 |                                0 |
| Final 10× `--select refresh`, ordinary/profiled |           2 |                0; both miss 20 s |
| 1× / 10× `--select folder`                      |           2 |                                0 |

Both committed **UE 5.7** and **UE 5.8** localization output fixture
oracles pass; no live Unreal integration, UAsset parser or codegen changed, so editor/UAsset matrix
checks were not run. Full `pnpm check` was not run. Remaining work: cold-import and 20 s refresh
performance, mixed-domain bulk/page costs, complete package fields and Phases 4–7. No commits,
pushes, branch switches or stashes were made. Implementation is complete; performance acceptance is open.

Evidence: `a64-production-1x.json`, `a64-production-cold-10x.json`,
`a64-accepted-{cold,resume,projection,compact}-10x.json`, `a64-production-reader-10x.json`,
`a64-production-refresh-10x.json`, `a64-refresh-profile-10x.json`, `a64-parse-{before,after}-10x.json`
`a64-native-folder-{1,10}x.json` and `a64-full-width-forecast.json`. Initial focused tests were 53 passed / 2 failed (missing-old-file
fallback and the obsolete tiny-segment memory fixture); both were fixed. Initial package/script
typechecks each found one error, fixed before verification. Three manually superseded cold runs
record failure; one refresh guard run failed before replacement-byte forwarding was corrected.
The first precommit attempt found one branded culture-map key error in the new folder probe;
using the discovered culture fixed it. The final gate passes; existing lint warnings remain unchanged.
The cached-edit timing and empty-folder diagnostics are excluded from acceptance evidence.
