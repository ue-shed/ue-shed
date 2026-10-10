# Localization import measurements

These independent-file measurements precede the shared string store. The current Phase 3 evidence
is in [Shared Game Text index measurements](game-text-shared-index-measurements.md).

Plan 057 Phase 3 revision, 2026-10-10, Windows / Node 24.21.0. Retained projects: 132,606 keys, 10 cultures / 21 files at 1× (1,507.45 MiB); 1,326,060 keys, 20 cultures / 41 files at 10× (29,466.57 MiB). Neither was regenerated. One supervised child at a time; 16,384 MiB heap, 20 GB OS RSS and 1,200 s per stage. Warm disk, fresh separate file/target caches; no OS eviction. Times include hashing/parsing, sorting, zstd, atomic publication and persisted verification. Touched inputs rewrite identical bytes before timing; the one-byte PO edit is restored.

**Profiles and decisions.** PO: escape/block decoding led the first 1× CPU profile (447/281 ms self), followed by insertion and UTF-8 encoding (388/337 ms). Archive: record scanning led (276 ms), followed by insertion and UTF-8 encoding (202/201 ms). Native bounded decoding/scanning, shared PO fast decoding, per-entry dictionaries and encodeInto remove the profiled character/encoding costs. The revised 1× profile spends 8.17 s in scanning, 6.91 s adding rows, 4.74 s decoding PO blocks, 4.14 s in identity insertion and 3.35 s in GC; decoder/hash take 1.59/1.39 s. Entry/schema/dictionary/allocation work bounds throughput; the 150 MiB/s goal is **not reached**. Stats record size, exact mtime/ctime nanoseconds and inode/device beside the content key; Windows tests verify stable identity across stats and rewrites. Stat hits open no source. Changed stats hash and parse once; existing hashes discard the parse, and before/after handle/path stats return typed retry failures on mutation. Input spooling is removed; only bounded column blocks spill. Importer version 3 revises the layout while retaining SHA-256(version, normalized options, raw content hash).

**Complete target.** Logical MiB/s uses the whole authored target even when reads are zero; it is not physical IO throughput. Heap / buffers / RSS are MiB: timer/checkpoints plus pre-GC/OS peaks; buffers are lower bounds and RSS retains allocator pages. Sizes count active snapshots, excluding small manifests/stat hints and obsolete generations. The changed case reads one PO (59.61 MiB at 1×; 602.91 MiB at 10×) and publishes one snapshot.

| Target / operation | Read MiB |  Seconds | Logical MiB/s | Heap / buffers / RSS MiB | Snapshot MiB | Published / stat hits |
| ------------------ | -------: | -------: | ------------: | -----------------------: | -----------: | --------------------: |
| 1× cold            |  1507.45 |  37.6353 |          40.1 |     187.3 / 79.7 / 422.7 |        75.38 |                21 / 0 |
| 1× touched         |  1507.45 |  37.2835 |          40.4 |     213.8 / 66.9 / 442.4 |        75.38 |                 0 / 0 |
| 1× stat hit        |     0.00 |   0.0536 |       28118.2 |       63.5 / 3.9 / 353.8 |        75.38 |                0 / 21 |
| 1× one-byte PO     |    59.61 |   1.6336 |         922.8 |     140.2 / 60.2 / 410.2 |        75.38 |                1 / 20 |
| 10× cold           | 29466.57 | 695.3285 |          42.4 |   590.8 / 460.2 / 1222.5 |      1513.06 |                41 / 0 |
| 10× touched        | 29466.57 | 524.6622 |          56.2 |   668.8 / 203.0 / 1047.0 |      1513.06 |                 0 / 0 |
| 10× stat hit       |     0.00 |   0.2014 |      146337.9 |      377.8 / 4.8 / 655.8 |      1513.06 |                0 / 41 |
| 10× one-byte PO    |   602.91 |  15.5483 |        1895.2 |   455.4 / 421.7 / 1033.0 |      1513.06 |                1 / 40 |

**Per file.** Cells are **seconds range; logical MiB/s range; maximum heap / buffers / RSS MiB**. Every touched read discards its parse; every stat hit reads zero bytes. [All 186 file/operation rows](../../test-results/game-text-scale/revision-final-per-file.csv) retain each file's input/read bytes, time, throughput, memory and size.

| Scale / format (files) | Cold                                               | Rewritten same bytes                               | Stat hit                                             | Snapshot MiB |
| ---------------------- | -------------------------------------------------- | -------------------------------------------------- | ---------------------------------------------------- | -----------: |
| 1× manifest (1)        | 2.1394; 39.8; 170.3 / 52.3 / 386.2                 | 1.6778; 50.7; 172.7 / 24.4 / 412.0                 | 0.0028; 30103.6; 141.8 / 3.3 / 346.9                 |         3.26 |
| 1× archive (10)        | 1.5495–1.8116; 46.6–58.0; 168.6 / 95.7 / 433.4     | 1.1490–1.5552; 54.3–78.2; 172.7 / 28.8 / 418.5     | 0.0031–0.0041; 20524.4–27513.5; 36.5 / 3.3 / 346.9   |    2.22–3.15 |
| 1× po (10)             | 1.6305–1.9982; 28.5–36.6; 161.3 / 90.6 / 441.8     | 1.1570–1.4861; 38.3–51.5; 141.7 / 30.4 / 421.5     | 0.0028–0.0037; 15600.6–21373.5; 36.5 / 3.3 / 346.9   |    3.28–4.25 |
| 10× manifest (1)       | 24.0913; 35.8; 632.4 / 386.3 / 1027.5              | 16.6469; 51.7; 608.0 / 149.4 / 1005.5              | 0.0046; 188552.3; 377.5 / 2.5 / 718.6                |        32.77 |
| 10× archive (20)       | 16.5114–18.5332; 48.7–51.5; 403.9 / 427.9 / 1265.3 | 11.7636–12.9383; 65.7–76.8; 542.0 / 173.5 / 1022.3 | 0.0050–0.0063; 134784.5–170044.6; 38.8 / 2.5 / 718.6 |  22.59–32.20 |
| 10× po (20)            | 16.9927–18.6409; 30.9–35.5; 454.7 / 432.3 / 1234.7 | 12.0309–13.8307; 41.7–50.1; 409.2 / 164.1 / 981.3  | 0.0046–0.0073; 79351.4–131636.2; 38.8 / 2.6 / 718.6  |  32.99–42.79 |

**10× English archive/PO bytes.** Each entry column is 5,304,240 raw bytes. Starts cells show stored (raw) bytes; meta/string row labels show raw archive/PO bytes. Strings include offsets/block headers. Canonical msgctxt/key comments, empty arrays, source-equal translations and a file-local path prefix are derived losslessly. Original archive/PO totals: 34,576,340 / 64,184,456 bytes; original PO comments: 583,896,384 raw / 25,548,155 stored. Every file remains independent.

| Column / domain                                             |                              Archive stored bytes |                                         PO stored bytes |
| ----------------------------------------------------------- | ------------------------------------------------: | ------------------------------------------------------: |
| entry.namespace                                             |                                            12,609 |                                                  13,317 |
| entry.key                                                   |                                         3,588,269 |                                               3,588,446 |
| entry.source                                                |                                         3,522,415 |                                               3,522,415 |
| entry.translation                                           |                                               183 |                                                  49,690 |
| entry.path                                                  |                                               183 |                                               3,588,379 |
| entry.notes / metadata / source-extra / translation-extra   |                                          183 each |                                                183 each |
| entry.po-extra                                              |                                               183 |                                                     506 |
| entry.options                                               |                                            33,580 |                                                  61,210 |
| entry.ordinal                                               |                                         3,588,269 |                                               3,588,269 |
| .starts: source / translation / paths / comments / identity | 2,224 (2,728) / 4 (4) / 4 (4) / 4 (4) / 627 (720) | 2,224 (2,728) / 36 (36) / 737 (848) / 4 (4) / 636 (720) |
| file.meta (raw 93 / 122)                                    |                                                93 |                                                     114 |
| source strings (raw 178,516,746 / 178,516,746)              |                                         7,113,784 |                                               7,113,784 |
| translation strings (raw 12 / 2,145,001)                    |                                                12 |                                                 113,943 |
| paths strings (raw 12 / 55,407,950)                         |                                                12 |                                               7,097,010 |
| comments strings (raw 12 / 56)                              |                                                12 |                                                      56 |
| identity strings (raw 47,152,071 / 47,152,071)              |                                         5,739,792 |                                               5,748,502 |
| directory / alignment                                       |                                            86,141 |                                                 107,514 |
| file total                                                  |                                        23,689,132 |                                              34,597,524 |

**Cold string codecs.** Cells are **stored MiB / encode seconds**, summed over 256 KiB blocks, using raw fallback when compression grows a block. Prefixing changes only paths; their levels were remeasured afterward. [Every original/revised domain and level](../../test-results/game-text-scale/revision-string-codecs.csv) includes exact bytes/times; empty domains below show exact bytes.

| File / domain                          |    Level 3 MiB / s |    Level 6 MiB / s |    Level 9 MiB / s |   Level 19 MiB / s |
| -------------------------------------- | -----------------: | -----------------: | -----------------: | -----------------: |
| archive source                         |      6.784 / 0.258 |      6.918 / 1.178 |      6.712 / 1.377 |    5.243 / 193.322 |
| archive identity                       |      5.645 / 0.103 |      5.474 / 0.393 |      5.463 / 0.531 |     2.189 / 33.288 |
| po source                              |      6.784 / 0.251 |      6.918 / 1.156 |      6.712 / 1.353 |    5.243 / 184.157 |
| po identity                            |      5.672 / 0.120 |      5.482 / 0.438 |      5.617 / 0.606 |     2.339 / 38.656 |
| po translation                         |      0.109 / 0.004 |      0.101 / 0.014 |      0.098 / 0.017 |      0.079 / 2.012 |
| PO prefixed paths                      |      7.119 / 0.199 |      7.497 / 0.613 |      6.768 / 0.865 |      3.481 / 9.081 |
| Original PO comments                   |     24.365 / 0.897 |     22.556 / 4.501 |     20.765 / 5.287 |   18.930 / 363.509 |
| Archive translation / paths / comments | 12 B / <0.001 each | 12 B / <0.001 each | 12 B / <0.001 each | 12 B / <0.001 each |
| Revised PO comments                    |      56 B / <0.001 |      56 B / <0.001 |      56 B / <0.001 |      56 B / <0.001 |

Chosen: identity 6, paths 9, source/translation/comments 3; numeric columns remain 1. Source 6 grows data, 9 saves <1% at roughly 5× encode cost, and 19 costs 184–193 s/file. Identity 19 costs 33–39 s/file; paths 19 costs 9.08 s versus 0.87 s at 9, saving another 3.29 MiB/PO. 10× projection: **1513.06 MiB localization + 684.41 MiB joined + 332.98 MiB package estimate = 2530.45 MiB (2.47 GiB)**. The optimistic package proxy uses Phase 2's source (36.63), identity (114.46) and paths/occurrence IDs (181.89); package headers and extra coverage evidence would increase it. The measured independent complete-file layers exceed 1 GiB before joining. Reaching the target needs shared strings across files/layers or sparse evidence overlays and a smaller joined/package representation; no such design change is made here.

**Reproduction and verification.** Run files/target modes sequentially at project-1x and project-10x-final with fresh caches; target mode includes the one-byte change. Profiles add `--select en/Generated.po` (or `en/Generated.archive`) `--profile`. Codec probes use --mode size `--report <target-report>`; final directory accounting adds --domain none. Reports/logs are `test-results/game-text-scale/revision-*`; profiles are `CPU.*.cpuprofile`. [Phase 3 evidence](../../plans/057-game-text-compact-index.md#phase-3-localization-files-as-columns-1) records final command counts and each UE version's availability.
