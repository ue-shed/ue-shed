# Shared Game Text index measurements

Plan 057 Phase 3 final experiment, 2026-10-10, Windows / Node 26.11.1. **Stopped after measured
step 1: A64 selected; production remains 2f4a3aa9's hash store and targets remain open.** No retained
project regeneration, re-import, 1× join rebuild or today's 10× pipeline. One benchmark child at a
time, 16,384 MiB heap, 20 GB OS RSS, 1,200 s per stage. Every 10× run now has an absolute **900 s
whole-run deadline**, including startup, discovery, input loading, all cold files and cleanup.
Expiry kills the tree, records failure and exits nonzero; stage changes cannot reset it.
`--run-timeout-seconds` only lowers the cap. Parent-owned restoration survives a killed PO-edit worker.

## Method

Compaction retired the pre-compaction segment files; their JSON census survives. Unchanged
`snapshot-v3-final-{1,10}x-256.snapshot` sections retain 6,051,433 / 73,426,830 strings, including
all declared Phase 2 path/identity variants. No live-ID pruning is credited. Each physical domain
is one experimental immutable segment; this probes codecs, not production cross-domain deduplication
or publication. Input CRC/UTF-8 validation and extraction to byte buffers/u32 offsets are timed
separately. Sizes charge encoded indexes, reserved directories and padding.

A radix-sorts typed IDs by UTF-8 bytes, front-codes 16/32/64-string blocks and compresses groups up
to 256 KiB, with four sparse-index columns. IDs are sorted ranks; an inverse permutation supports
old page IDs. B implements [BBHash](https://drops.dagstuhl.de/opus/volltexte/2017/7619/pdf/LIPIcs-SEA-2017-25.pdf),
gamma 1, rank samples every 512 bits, eight-bit fingerprints, exact confirmation and a charged
insertion-ID permutation; inseparable hash collisions fail construction. C reproduces SHA-256
prefixes, 8,192-row delta hash/ID pages and 20-bit/seven-probe Bloom filters. Equal string levels:
paths 9, identity 6, other domains 3; index level 1, raw fallback. No native dependency or FST added.

The modeled file selects evenly spaced saved values: up to 132,606 × scale per source/path/native
translation domain, twice that for identity columns, and all comments: 659,755 / 6,597,555 present
requests plus one absent value per participating domain. It does not reproduce actual PO deduplication.
A sorts once and merges fences/blocks sequentially using one reusable decode buffer. B/C charge
hashing and each confirmation block once. Lookup/page inputs are compressed payloads in memory,
with empty decode caches; access bytes are not disk reads. Pages scatter 300 IDs **per physical
domain** (4,200 / 7,200 total), not the old joined 300-value page. Folder bounds/count use `/Game/`
(1,159,763 matches) at 1× and opaque synthetic `1/` (one match) at 10×; B/C scan resident raw bytes.
Every lookup, page and range is checked against original bytes. Heap/buffer samples are lower
bounds; OS RSS is independently polled. Each cell below is **1× / 10×**, one final run per scale.

## Comparison and decision

| Candidate     |     Dictionary MiB |           Build s | Modeled append s | Scattered pages total ms | Folder bounds/count ms |        Whole run s |
| ------------- | -----------------: | ----------------: | ---------------: | -----------------------: | ---------------------: | -----------------: |
| A16           |     15.43 / 242.30 |     13.03 / 62.76 |     3.01 / 21.29 |         159.06 / 2598.98 |            0.94 / 0.85 |     19.96 / 113.97 |
| A32           |     12.49 / 212.31 |     12.96 / 59.67 |     2.79 / 21.40 |         164.87 / 2116.55 |            0.85 / 0.89 |     19.72 / 115.51 |
| **A64**       | **10.69 / 194.64** | **10.92 / 63.51** | **2.40 / 22.64** |     **142.11 / 2119.57** |        **0.82 / 0.72** | **16.73 / 118.40** |
| B, BBHash     |     62.42 / 785.42 |      7.30 / 97.99 |     1.22 / 19.92 |         333.52 / 1850.24 |       262.66 / 2594.37 |     13.25 / 156.04 |
| C, hash pages |     80.37 / 976.19 |    15.02 / 238.80 |     2.40 / 43.89 |         348.60 / 2299.58 |       271.29 / 4709.96 |     21.36 / 324.46 |

| A block size | No further compression MiB, 1× / 10× | Compressed sparse index MiB, 1× / 10× |
| ------------ | -----------------------------------: | ------------------------------------: |
| 16           |                     221.43 / 7469.31 |                          3.82 / 36.15 |
| 32           |                     188.32 / 7213.11 |                          2.04 / 17.94 |
| 64           |                     171.75 / 7085.02 |                           1.05 / 8.88 |

**Select A64:** 80.1% smaller than C at 10×; best size and 1× append/page among A variants. Its
10× append trades 1.35 s against A16; page time is effectively tied with A32. B's bare MPH costs
2.897 / 2.889 bits/key; complete lookup costs **4.486 / 4.728 bytes/key** with fingerprints,
insertion IDs and metadata. Absent trials yield 590/140,000 and 1,029/240,000 fingerprint candidates
(0.42% / 0.43%) for exact confirmation; modeled appends make 659,756 / 6,597,560 confirmations.
B's faster lookup leaves much less space for real content/missing fields. A64's 8.88 MiB sparse
index gives no measured reason for an FST. Neither A64's 22.64 s nor B's 19.92 s before parsing/
publication establishes ≤20 s PO refresh. All final 10× runs finish within 325 s; maximum OS RSS
across candidates is 4,425.7 MiB. Build excludes loading; whole run includes loading and verification.

## Whole index and targets

Historical production operations were **not rerun with an integrated winner**. The compacted probe
prunes 26,085,533 declared strings / 1.84 GiB UTF-8. The full-width forecast charges those strings;
the prior 1,631.67 s cold sum is **failed under the new cutoff**, not an acceptable slow result.

| Whole index MiB                       |     1× measured | 10× compacted probe | 10× full-width forecast |
| ------------------------------------- | --------------: | ------------------: | ----------------------: |
| Current shared dictionary             |           80.35 |              672.84 |                  989.10 |
| Active localization/join layers       |           10.06 |              189.63 |                  191.88 |
| Package proxy/publications/stat hints |            1.94 |               21.14 |                   21.15 |
| **Current total / target**            | **92.36 / 100** |   **883.62 / 1024** |      **1202.12 / 1024** |
| A64 dictionary sizing model           |           10.69 |                   — |                  203.76 |
| A64 whole-index sizing model          |           22.70 |                   — |                  416.78 |

The A64 model preserves all **6,053,782 / 78,066,945** pre-compaction shared strings, charging each
owner's measured index bytes/key × old count and payload bytes/UTF-8 byte × old width; cultures
map to corresponding saved culture domains. Fixed layers/proxy/publications retain old budgets.
These are optimistic projections: remapped ID compression, ownership metadata, binary GUIDs and
publication remain unmeasured; synthetic compression does not predict real content/missing fields.

| Historical production operation |        1× s |                                10× s |
| ------------------------------- | ----------: | -----------------------------------: |
| Cold target files, sum          |       67.61 | **failed: historical 1631.67 > 900** |
| Stat-hit target / one-byte PO   | 0.11 / 3.41 |                         0.25 / 39.52 |
| Forced steady compaction        |       26.67 |                               261.42 |

Production reader open, joined-page decode and domain loads remain unverified for A64. Scattered
codec pages improve on C in aggregate, but cannot establish production latency after ID remapping.
Cold targets remain ≤38 s / ≤696 s; 900 s is the absolute 10× failure line. PO refresh remains ≤20 s.

## Verification and remaining work

| Command                                                                                                                                            |                                               Passed |                              Failed |
| -------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------: | ----------------------------------: |
| `benchmark-game-text-dictionary.ts`, five candidates × two scales                                                                                  |          10 final runs; 5 superseded successful runs |                                   0 |
| `pnpm exec vitest run scripts/game-text-dictionary.test.ts --maxWorkers=1`                                                                         |                                                   14 |                                   0 |
| `pnpm exec vitest run packages/localization packages/game-text scripts/game-text-scale.test.ts scripts/localization-import.test.ts --maxWorkers=1` |                                       479; 4 skipped |                                   0 |
| Node 26.11.1 Vitest format/file/store/shared/importer/scale/dictionary tests, `--maxWorkers=1`                                                     |                                                  158 |                                   0 |
| `pnpm exec oxfmt` changed files                                                                                                                    |                                             11 files |                                   0 |
| `pnpm run check:precommit`, final                                                                                                                  | 6 stages; 43 architecture tests; 4 contract packages |                                   0 |
| `pnpm run check:precommit`, first attempt                                                                                                          |                                             2 stages | 1 typecheck stage (2 errors, fixed) |

Reports/logs: `test-results/game-text-scale/dictionary-{A16,A32,A64,B,C}-{1,10}x.json`,
`dictionary-summary.json`, `dictionary-A64-forecast.json`, `dictionary-*vitest.log`.
[Commands and caps](../../scripts/game-text-scale.md). Remaining steps 2–3: integrate A64 with
immutable ranks/coordinated compaction; typed cold collection/sorting with bounded spill runs;
binary GUIDs with exact case recovery; sorted one-file probing across segments; then measure
physical whole-index size, cold/stat-hit/PO refresh/compaction and production readers at both scales.
No parser, codegen, fixture, native reader contract or Unreal integration changed: UE 5.7/5.8 checks
do not apply. Full `pnpm check` was not run for this experiment.
