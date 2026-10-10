# Shared Game Text index measurements

Source order is fixed, with independent fixture/tiny/targeted and saved 1× equality re-runs.
Phase 6 is stopped on a new findings mismatch for split gathered identities. See the
[continuation evidence](#phase-6-continuation-source-order-fixed-new-findings-stop).

Phase 5 adds the joined layer, saved-oracle equality and bounded incremental refresh; its
measurements and command ledger follow the retained Phase 3/4 evidence below. Hosts and the
production query migration remain Phase 6 work.

The following opening measurements are the retained **Phase 3** baseline, recorded
2026-10-10, Windows / Node 26.11.1. Cold import, ordinary PO refresh and size targets
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

## Phase 4: package-text layer complete; Phase 5 next

Recorded 2026-10-10, Windows / Node 26.9.0, debug native reader. This continuation completes
source verification, header evidence, eligibility/exclusion helpers and the committed-fixture
audit. No real project or saved fixture was regenerated. No 1× or 10× layer experiment ran.
Heap is capped at 16,384 MiB/process; heavy lanes run serially, including one compile action at
a time in the localization process lane. Any future 10× command retains a single 900-second
startup-to-cleanup deadline and the 20 GB total RSS cap; exceeding the deadline is failure.

**Rule and source evidence.** Select raw `PKG_RequiresLocalizationGather` (`0x00040000`), or a
positive gatherable-text count and offset, or external actor/package relationships. No class
whitelist. `TextProperty` adds **zero** candidates beyond the flag on every committed root and
both retained engines, so drop that clause. Summary evidence is necessary: each legacy save root
has three selected packages but only two flagged packages. `FText` serialization marks the
archive only when `ShouldGatherForLocalization()`; save propagates the linker's archive state
into the package flag, then writes it into the summary. Cached gather data can avoid loading a
package: the selected set is eligibility for text inspection, not a claim that every candidate
is loaded by Unreal on every cached gather.

All paths below are relative to each configured engine's `Engine/Source`. Source reads were
read-only. `node scripts/check-text-gather-rule.ts` checks twelve probes per version plus the
FText/gather conditions; the full line ledger is `test-results/codex/057-gather-source.log`.

| Source file / evidence                                                                                                          | UE 4.27 lines |    UE 5.7 lines |        UE 5.8 lines |
| ------------------------------------------------------------------------------------------------------------------------------- | ------------: | --------------: | ------------------: |
| `Runtime/CoreUObject/Public/UObject/ObjectMacros.h`: flag                                                                       |           123 |             148 |                 151 |
| `Runtime/Core/Private/Internationalization/Text.cpp`: FText marks archive                                                       |     1022–1024 |       1058–1060 |           1101–1103 |
| `Runtime/CoreUObject/Public/UObject/Package.h`: sets/reads package flag                                                         |       379–398 |         754–773 |             752–771 |
| `Runtime/CoreUObject/Private/UObject/SavePackage.cpp` (4.27) / `SavePackage2.cpp` (5.x): linker state → package → summary flags |     4455–4458 |       3130–3151 |           3177–3198 |
| Same save file: gatherable-text offset/count and records                                                                        |     3271–3280 |       2294–2300 |           2330–2336 |
| `Runtime/CoreUObject/Private/UObject/PackageFileSummary.cpp`: count/offset serialization                                        |           206 |             297 |                 297 |
| `Runtime/CoreUObject/Private/UObject/LinkerLoad.cpp`: seeks and reads table count                                               |     1572–1585 |       2048–2061 |           2108–2121 |
| `Editor/UnrealEd/Private/Commandlets/GatherTextFromAssetsCommandlet.cpp`: summary/cache flags                                   |  634, 650–695 | 1384, 1749–1806 |     1444, 1897–1962 |
| Same commandlet: cached table read / loaded-package gather condition                                                            | 705–714 / 779 | 1390–1397 / 382 | 1470–1477 / 388–389 |

5.7's loaded-package condition is flag **or external actors**. 5.8 adds external packages to
`bHasExternalObjects`. In 5.8 the commandlet discovers external-to-outer relationships through
Asset Registry optional outer paths at 1381–1392. The fixture helper resolves saved external
actors/objects and their outer packages from the complete inventory, without another traversal:
`Runtime/Engine/Private/Level.cpp:4151–4183` defines external actor roots, and
`Runtime/Engine/Private/ExternalPackageHelper.cpp:145–178,192–215` defines external object roots
and their two-level hash layout. The predicate also accepts explicit external relationship
evidence; inventory layout is the fixture audit's representation of that condition. Absolute saved paths
and relative Project Index `Content/...` paths are both covered by the helper regression.

**Reader and coverage decisions.** The parser already reads flags at
`crates/uasset-parser/src/package.rs:630` and the version-gated gather table at 645, including
4.27. A portable inspection projection now exposes them, plus an exact complete-name-map probe.
Saved scans opt into **uasset-io v1.9** with `headerData: true`; Project Index header queries use
minor 9. Workers omit added fields below minor 9. Both page encodings retain `headerData`;
profile 2 / `catalogs-v5` and scan-cache version 3 rebuild incompatible derived evidence. Missing
header evidence requires an upgrade before pruning. The v1.8 package-record stream and legacy
text stream keep their semantics. Game Text retains normalization/publication ownership under
ADR 0007; native writes would duplicate dictionary/storage ownership.

`packageCoverage` remains optional and can now contain `not_gatherable`. Exclusions get
`package_not_gatherable` diagnostics, not `complete` records. `loc status` keeps a bounded excluded
package list and optional count; Game Text's Read problems shows the count and reason. These
helpers prepare the new layer; production hosts still use their existing corpus path.

**Oracle mapping.** `compareTextCandidateCorpora` separately enforces full-corpus unit/occurrence
equality, selected-package coverage/diagnostic equality, and the exact excluded set. Fold the
legacy events for eligible packages, replacing excluded completion with `not_gatherable` rows
and reasons; do not assert their payloads were inspected. Discovered count remains the full
inventory; inspected/partial/gap counters describe selected payloads. Preserve excluded baseline
gaps separately in the audit's `gapsMovedToExcluded`. Thus `DA_Native`'s `OpaqueValue.Value`
remains named as **excluded because Unreal does not gather it**, instead of silently disappearing.
Text loss or selected-coverage divergence is a STOP. Regression tests reject both and an
unreported excluded set. No candidate-specific fixtures or assets were regenerated.

| Committed root                                                  | Packages | Flag / summary / external / TextProperty | Selected / excluded | Units / occurrences retained | Full / selected gaps |
| --------------------------------------------------------------- | -------: | ---------------------------------------: | ------------------: | ---------------------------: | -------------------: |
| `unreal-project`                                                |       83 |                          34 / 7 / 7 / 32 |             41 / 42 |                      62 / 71 |                1 / 0 |
| `legacy-unreal-project`                                         |        0 |                            0 / 0 / 0 / 0 |               0 / 0 |                        0 / 0 |                0 / 0 |
| `legacy-unreal-project/Generated/4.27`                          |        3 |                            2 / 3 / 0 / 2 |               3 / 0 |                      27 / 33 |                1 / 1 |
| `legacy-unreal-project/Generated/5.3`                           |        3 |                            2 / 3 / 0 / 2 |               3 / 0 |                      27 / 33 |                1 / 1 |
| `unreal-427-localization`                                       |        0 |                            0 / 0 / 0 / 0 |               0 / 0 |                        0 / 0 |                0 / 0 |
| `perforce-map-history/revisions/baseline`                       |        7 |                            0 / 0 / 7 / 0 |               7 / 0 |                        0 / 0 |                0 / 0 |
| `perforce-map-history/revisions/add-arrival`                    |        1 |                            0 / 0 / 1 / 0 |               1 / 0 |                        0 / 0 |                0 / 0 |
| `perforce-map-history/revisions/conventional-baseline`          |        1 |                            0 / 0 / 0 / 0 |               0 / 1 |                        0 / 0 |                0 / 0 |
| `perforce-map-history/revisions/conventional-move-actor`        |        1 |                            0 / 0 / 0 / 0 |               0 / 1 |                        0 / 0 |                0 / 0 |
| `perforce-map-history/revisions/label-north`                    |        1 |                            0 / 0 / 1 / 0 |               1 / 0 |                        0 / 0 |                0 / 0 |
| `perforce-map-history/revisions/move-east`                      |        1 |                            0 / 0 / 1 / 0 |               1 / 0 |                        0 / 0 |                0 / 0 |
| `perforce-map-history/revisions/two-unclassified-package-edits` |        2 |                            0 / 0 / 2 / 0 |               2 / 0 |                        0 / 0 |                0 / 0 |

Across twelve roots: **103 packages, 59 candidates, 44 exclusions, 116 units and 137 occurrences,
zero text loss**. Three baseline gaps become two selected gaps plus one explicitly excluded gap.
Both retained 5.7 and 5.8 fixtures also retain **62 units / 71 occurrences**, selecting **41/83**
packages and excluding 42; each moves the same single native gap to exclusion evidence. All
**12 committed + 2 engine audits pass** the documented mapping. Raw per-root timings, byte counts,
excluded paths and gap coordinates: `test-results/game-text-scale/phase4-candidate-audit.json`.

### Package layer implementation and final measurements

This final pass changes Game Text storage only. The v1.8 reader, v1.9 header evidence and
candidate rule above are frozen; their source and engine audits are retained prior evidence.
Measurements use Node 24.21.0; final checks also run on supported Node 26.5.0. All inputs are
retained generated files or committed saved fixtures. No real project or regeneration.

Occurrence/source/identity/location/notes and gap coordinates are u32 shared-domain IDs.
Coverage columns retain complete/partial/not_gatherable/error status, bytes, decode failures,
reason counts and bounded samples. The caller supplies the Project Index's opaque signature
and header evidence from a complete, path-sorted inventory. Fixed 256 path shards hash these
signatures plus eligibility into versioned keys. A refresh opens only changed shards, reuses
unchanged package records, reads only changed/new selected payloads, drops removed packages,
and atomically publishes all affected shards under the writer lock. Rename and gather-flag
transitions are tested, as are external-package add/remove transitions with an unchanged outer
signature. An unchanged refresh performs no payload reads and publishes no generation.

Eight workers prepare cold shard snapshots, followed by the Phase 3 target-wide external
64 MiB string sort. Existing-store adoption resolves that sorted stream against existing IDs
without a second sort. Batch publication replaces small updates; broad updates use one cold
publication to avoid a segment per shard. This remains a Node library/CLI capability, with no
Workbench dependency. No native dependency or alternative package scanner is introduced.

The reusable `scripts/package-text-layer-oracle.test-support.ts` decodes the layer and compares
with today's complete event corpus and the documented selected-events/not_gatherable mapping.
All twelve committed roots and scales 0.0001, 0.001 and 0.002 pass. A separate tiny retained
stream conversion passes the same oracle. Excluded payloads are never claimed as inspected;
the full oracle rejects any lost unit or occurrence and checks the exact excluded set.

Conversion streams the retained saved-text NDJSON, folding package gaps into full reason counts
and bounded samples. It explicitly flags generated text packages (16,500 / 165,000) and leaves
all others unflagged (150,018 / 1,500,180). Original input has no flags. Counts are 166,518 /
1,665,180 packages, 1,028,205 / 10,282,050 occurrences and 4,800,000 / 48,000,000 gaps. Synthetic
signatures encode generated package byte metadata; production callers supply Project Index
signatures. LF-only framing is necessary: Node 24 readline splits authored U+2028/U+2029.

The whole-index measurement adopts actual package columns plus the retained Phase 2 joined
snapshot into a copy of the retained Phase 3 localization store. It imports every declared
Phase 2 dictionary width, including unused synthetic variants. No compaction is used to establish
size acceptance. The joined columns are a **saved size reference**, not a Phase 5 join build.
These refresh timings cover package and localization inputs; joined refresh remains Phase 5.
Cold adoption includes the saved joined snapshot's string resolution, which is why it costs
more than an empty-store package build. No OS cache eviction; each cell is one measured run.

All sizes are MiB (2^20 bytes), measured after package and PO edits. Physical totals include
inactive retained layer files, generations, publication metadata and importer stat hints.

| Whole-index component                     |   1× bytes |   1× MiB |   10× bytes |    10× MiB |
| ----------------------------------------- | ---------: | -------: | ----------: | ---------: |
| Package occurrence/coverage layers        |  4,687,352 |    4.470 |  30,987,100 |     29.552 |
| Localization layers                       | 15,398,832 |   14.685 | 303,046,588 |    289.008 |
| Joined saved-size reference               |  4,321,892 |    4.122 |  48,890,592 |     46.626 |
| Shared strings/lookup metadata            | 11,680,824 |   11.140 | 175,061,868 |    166.952 |
| Active subtotal                           | 36,088,900 |   34.417 | 557,986,148 |    532.137 |
| Physical store incl. retained/publication | 41,653,249 |   39.724 | 635,749,848 |    606.298 |
| Stat hints                                |      6,048 |    0.006 |      11,849 |      0.011 |
| **Total**                                 | 41,659,297 |   39.729 | 635,761,697 |    606.310 |
| **Target**                                |            | **≤100** |             | **≤1,024** |

Standalone package columns after one edit are 4,698,252 / 32,758,464 bytes (4.481 / 31.241 MiB),
plus shared strings 2,464,312 / 23,751,196 bytes (2.350 / 22.651 MiB). Different shared IDs change
column compression; the whole-store table uses the actual adopted layers, not these added twice.

Heap is max(sampled heap, pre-GC trace heap) **per V8 isolate**, not the sum of worker isolates.
RSS is max(internal sample, OS working-set polling), including all threads in the supervised
process. RSS is a conservative upper bound on aggregate resident heaps. Array buffers are outside
V8 heap and included in RSS. All processes have 16,384 MiB old-space caps; all observed RSS stays
below the 20 GB limit. The largest cold adoption is 1,188.02 MiB heap/isolate and 6,039.36 MiB RSS.

| Operation                        |   1× s | 1× peak heap / RSS MiB |   10× s | 10× peak heap / RSS MiB | Target / result          |
| -------------------------------- | -----: | ---------------------: | ------: | ----------------------: | ------------------------ |
| Convert retained events          | 36.396 |       230.74 / 2498.11 | 481.950 |        390.36 / 3504.40 | Counts exact             |
| Inventory read, whole run        |  0.654 |        139.18 / 299.19 |   7.204 |         480.07 / 646.44 | Included in command wall |
| Cold package, empty store        | 21.630 |       316.15 / 2658.57 | 191.346 |        899.16 / 4059.38 | Bounded; pass            |
| No-change, empty store           |  0.179 |        136.00 / 566.32 |   1.864 |        510.35 / 1336.55 | Zero payload reads       |
| One package, empty store         |  1.079 |        144.85 / 678.43 |  17.736 |        610.59 / 2056.07 | One payload read         |
| Size, empty store                |  0.038 |         87.34 / 674.76 |   0.072 |        467.97 / 1480.82 | Measured                 |
| Cold whole-store adoption        | 41.295 |       363.37 / 2647.88 | 700.389 |       1188.02 / 6039.36 | ≤900 s command; pass     |
| No-change package, whole store   |  0.235 |        136.78 / 651.50 |   1.807 |        492.39 / 2073.98 | Zero payload reads       |
| One package, whole store         |  1.186 |        147.25 / 695.45 |  19.517 |        602.63 / 2452.93 | One payload read         |
| Prepare localization stat hints  |  0.295 |        130.48 / 691.40 |   0.527 |        536.70 / 1975.63 | Zero files parsed        |
| No-change package + localization |  0.432 |        141.71 / 681.43 |   2.182 |        533.67 / 1467.25 | ≤5 / ≤30 s; pass         |
| One package + one-byte PO        |  3.517 |        193.37 / 763.78 |  39.133 |        805.98 / 2494.13 | ≤10 / ≤60 s; pass        |
| Whole-store size census          |  0.054 |        137.70 / 659.47 |   0.050 |        588.57 / 1833.10 | ≤100 / ≤1,024 MiB; pass  |

Combined refresh reads exactly one package and parses exactly one PO file: 62,510,683 /
632,193,682 bytes. Unchanged localization files are not read. The byte is restored in the
worker and the parent cleanup guard. No-change package + localization reads zero PO bytes.
One-package whole-store updates reuse 15,832 / 139,136 existing strings and resolve only two
new strings. All measurements include checksum verification and atomic root publication.

### Final-pass command ledger

Benchmark prefix `B` below is exactly
`node --import tsx scripts/benchmark-localization-import.ts --mode package`.
Paths are relative to `test-results/game-text-scale/` unless written otherwise. `--project`
is `project-1x` or `project-10x-final`; `--records` is `phase4-records-1x` or `phase4-records-10x`.
Each row is a separate serial supervised command, with absolute 900 s startup-to-cleanup
10× timeout and the same memory caps. Conversion is measured separately; cold builds consume
converted reader records. No 10× command combines conversion with whole-store adoption.

| Command arguments after B                                                                                                                        | Passed stages / failed | End-to-end seconds | JSON artifact                |
| ------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------: | -----------------: | ---------------------------- |
| `--project project-1x --records phase4-records-1x --cache phase4-layer-1x --select convert --output phase4-convert-1x.json`                      |                  1 / 0 |             38.076 | `phase4-convert-1x.json`     |
| `--project project-10x-final --records phase4-records-10x --cache phase4-layer-10x --select convert --output phase4-convert-10x.json`            |                  1 / 0 |            483.713 | `phase4-convert-10x.json`    |
| `--project project-1x --records phase4-records-1x --cache phase4-layer-1x --select cold --output phase4-cold-1x.json`                            |                  5 / 0 |             25.169 | `phase4-cold-1x.json`        |
| `--project project-10x-final --records phase4-records-10x --cache phase4-layer-10x --select cold --output phase4-cold-10x.json`                  |                  5 / 0 |            219.930 | `phase4-cold-10x.json`       |
| `--project project-1x --records phase4-records-1x --cache phase4-integrated-1x --select integrated --output phase4-integrated-1x.json`           |                  8 / 0 |             49.230 | `phase4-integrated-1x.json`  |
| `--project project-10x-final --records phase4-records-10x --cache phase4-integrated-10x --select integrated --output phase4-integrated-10x.json` |                  8 / 0 |            772.777 | `phase4-integrated-10x.json` |

`Copy-Item -LiteralPath .../speed-final-1x -Destination .../phase4-integrated-1x -Recurse`
and the equivalent `speed-final-10x` copy each pass 1/0; retained originals are unchanged.
Saved joined inputs are `snapshot-v3-final-1x-256.snapshot` (57,003,132 bytes) and
`snapshot-v3-final-10x-256.snapshot` (717,660,668 bytes).

The broad test filter is exactly:

```text
packages/protocol packages/unreal-assets packages/game-text packages/localization extensions/game-text scripts/game-text-scale.test.ts scripts/localization-import.test.ts scripts/game-text-dictionary.test.ts scripts/package-text-reader.test.ts scripts/package-text-record.test.ts scripts/package-text-layer.test.ts apps/cli/src/index.e2e.test.ts apps/cli/src/localization-status.integration.test.ts apps/cli/src/localization-check.integration.test.ts apps/cli/src/localization-report.integration.test.ts apps/cli/src/localization-gate.integration.test.ts --maxWorkers=1
```

| Command                                                                                                   | Passed / failed / skipped                                                                                                                 |
| --------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| `pnpm test <broad filter above>` (Node 24.21.0)                                                           | 849 / 0 / 7; 95 files pass, three skip; 229.93 s                                                                                          |
| `node scripts/test.ts <same broad filter>` (explicit installed Node 26.5.0, PATH set to the same runtime) | 849 / 0 / 7; 95 files pass, three skip; 222.92 s                                                                                          |
| `pnpm exec oxfmt <changed paths>`                                                                         | 22 changed files formatted / 0 errors (21-file pass, one adapter file, then final 22-file pass)                                           |
| `pnpm run check:precommit` (Node 26.5.0, workspace concurrency 1)                                         | 6 stages / 0 failures; 43 architecture tests / 0 failures; contract checks pass in all four packages; repeated after adapter declarations |
| `pnpm run effect:architecture`                                                                            | First check: 3 errors (unregistered Promise/resource adapters); scoped adapter declarations added; final check passes / 0 errors          |
| `pnpm run format:check` after the final ledger update                                                     | Gate passes / 0 errors                                                                                                                    |
| `git diff --check`                                                                                        | Gate passes / 0 whitespace errors                                                                                                         |

The broad commands both include native CLI index/status/check/report/gate integration tests;
the wrapper uses the existing native executable after a successful incremental cargo build.
They include all 21 layer tests. The seven skips require optional live snapshots, commandlet
evidence or a Blueprint sample; three files skip. No requested portable layer test is skipped.
The shell default Node 24 is below the repository's declared >=26 engine; final verification
was repeated on installed Node 26.5.0. Measurement runtime is recorded separately above.

Iteration ledger (these failures were corrected before final checks):

| Command                                                                                                                                                                                                                   | Passed / failed / skipped                                                            |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------ |
| `pnpm exec vitest run scripts/package-text-layer.test.ts` before adding the file to Vitest config                                                                                                                         | 0 / 0; harness exit 1, no tests found                                                |
| Same command, first and second codec iterations                                                                                                                                                                           | 0 / 17 each; fixed empty-domain sentinels and lower-case/length-limited column names |
| Same command, third iteration                                                                                                                                                                                             | 14 / 3; fixed LF-only NDJSON framing                                                 |
| Same command with `-t 'parallel cold'`                                                                                                                                                                                    | 0 / 3 / 14; framing diagnosis                                                        |
| Same command after framing fix                                                                                                                                                                                            | 17 / 0                                                                               |
| `pnpm exec vitest run scripts/package-text-layer.test.ts packages/game-text/src/shared-index.test.ts packages/game-text/src/shared-string-sort.test.ts packages/game-text/src/shared-string-codec.test.ts --maxWorkers=1` | 40 / 0; four files                                                                   |
| `pnpm exec tsc -p packages/game-text/tsconfig.build.json --noEmit`                                                                                                                                                        | Gate passes / 0 errors                                                               |
| `pnpm exec tsc -p tsconfig.scripts.json --noEmit`                                                                                                                                                                         | First run fails on Scope typing; final gate passes / 0 errors                        |
| `pnpm exec oxlint .`                                                                                                                                                                                                      | First run 12 errors; final 0 errors / 11 existing warnings                           |
| `pnpm --filter @ue-shed/game-text build`                                                                                                                                                                                  | 1 build gate / 0 failures; compiled workers available                                |

The three late regressions (actual tiny conversion, external-package transitions, empty
inventory no-change) are included in the final 21 package-layer tests. Logs are
`test-results/game-text-scale/phase4-layer-*`, `phase4-lint-*` and `phase4-format-*`.
No unresolved failures, STOP condition or cap hit. Full `pnpm check` was not run.
Phase 4 is complete; Phase 5 must build the joined layer and compare its behavior with the
existing full corpus/join oracles. Hosts and production query acceptance remain later work.

### Prior reader/gather-step verification (retained; not rerun)

**Prior verification command ledger.** All commands used the heap cap and serial heavy execution.
The matrix uses `UE_SHED_UASSET_ENGINE_MATRIX_RETAINED_ROOT` for fresh VerifyOnly reflection,
source checks, native/WASM/review parity against existing saves. Legacy generator lanes are
skipped by this no-regeneration mode; committed 4.27/5.3 saved fixtures are audited above.

| Command                                                                                                                                                                                       | Passed / failed / skipped                                                                                                                                                   |
| --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `node --import tsx scripts/check-text-gather-rule.ts`                                                                                                                                         | 12 source probes per engine, 36 / 0; gather-condition assertions pass in 4.27, 5.7 and 5.8                                                                                  |
| `node --import tsx scripts/benchmark-package-text-candidates.ts out/uasset-engine-matrix-qqwSSf`                                                                                              | 12 committed + 2 retained-engine audits / 0 / 0; no text loss                                                                                                               |
| `pnpm run build:typescript-packages`                                                                                                                                                          | Build gate passes / 0 failed                                                                                                                                                |
| `cargo test --locked -p uasset-io`                                                                                                                                                            | 96 / 0 / 1 ignored (78 library + 18 native process tests)                                                                                                                   |
| `cargo test --locked -p uasset-io --features catalog-oracle`                                                                                                                                  | 121 / 0 / 1 ignored (103 library + 18 process tests)                                                                                                                        |
| `cargo test --locked -p uasset-inspection --lib package_header`                                                                                                                               | 1 / 0; 18 unrelated tests filtered                                                                                                                                          |
| `cargo clippy --locked -p uasset-parser -p uasset-inspection -p uasset-io --all-targets --features uasset-io/catalog-oracle -- -D warnings`                                                   | Gate passes / 0 errors                                                                                                                                                      |
| `cargo fmt --all -- --check`                                                                                                                                                                  | Gate passes / 0 errors                                                                                                                                                      |
| `pnpm exec vitest run … --maxWorkers=1` (scope below)                                                                                                                                         | 727 / 0 / 7 skipped; 85 files pass, 3 skipped                                                                                                                               |
| `pnpm --filter @ue-shed/game-text build`                                                                                                                                                      | Query-summary fix builds / 0 failed                                                                                                                                         |
| `pnpm exec vitest run extensions/game-text/src/game-text-route.component.test.tsx packages/game-text/src/query.test.ts --maxWorkers=1`                                                        | 36 / 0 / 0; initial component-only run had 32 passed / 1 failed, corrected by retaining the optional exclusion count in the validated query summary                         |
| `pnpm exec vitest run extensions/game-text/src/game-text-route.component.test.tsx packages/game-text/src/query.test.ts packages/game-text/src/package-text-candidates.test.ts --maxWorkers=1` | 39 / 0 / 0; final UI/query/helper checks, including relative Project Index external-package paths                                                                           |
| `pnpm test:uasset-engine-matrix` — UE 5.7                                                                                                                                                     | 13 native tests / 0; 2 source codegen gates, 2 fresh reflection gates, WASM parity (23 inspection + 12 authoring + 8 compact fixtures, guards) and saved-review parity pass |
| `pnpm test:uasset-engine-matrix` — UE 5.8                                                                                                                                                     | 13 native tests / 0; 3 source codegen gates, 2 fresh reflection gates, the same WASM and saved-review parity gates pass                                                     |
| `pnpm test:localization-processes` — UE 5.7                                                                                                                                                   | 1 complete process journey / 0 failed                                                                                                                                       |
| `pnpm test:localization-processes` — UE 5.8                                                                                                                                                   | 1 complete process journey / 0 failed                                                                                                                                       |
| `pnpm exec oxfmt <changed files>`                                                                                                                                                             | Changed-file formatting passes / 0 errors                                                                                                                                   |
| `pnpm run format:check` (after final evidence edits)                                                                                                                                          | Gate passes / 0 formatting errors                                                                                                                                           |
| `pnpm run check:precommit`                                                                                                                                                                    | 6 stages pass / 0 failed; architecture tests 43 / 0; contract checks pass in all 4 packages                                                                                 |

The broad Vitest command includes all of `packages/protocol`, `packages/unreal-assets`,
`packages/game-text`, `packages/localization`; `scripts/game-text-scale.test.ts`,
`localization-import.test.ts`, `game-text-dictionary.test.ts`, `package-text-record.test.ts`,
`package-text-reader.test.ts`; and CLI `index.e2e`, localization status/report/gate/check
integration files. Seven tests needing optional live snapshots, commandlet evidence or a
Blueprint sample are skipped there (three files); both engine matrix lanes run independently.
Earlier precommit attempts found three new lint errors and a missing query-summary field;
these were fixed, then package declarations rebuilt before the passing run. The final exclusion
regression also decodes the public query summary, so the count survives validation.
The localization journey checks plans, gather/import/
export/compile/reports/sync/prepare, audit, cancellation, review state and PO writes. Neither
engine process lane failed. Fresh matrix evidence is `out/uasset-engine-matrix-rFiayA`; process
evidence is `out/loc-processes-ad6d5c`. Full `pnpm check` was not run.

The final layer pass above completes the formerly remaining Phase 4 work. Rust, reader,
fixture and Unreal integration sources did not change in this pass: `cargo test --locked -p
uasset-io`, UE 5.7 matrix/process lanes and UE 5.8 matrix/process lanes are not rerun. Each
engine's prior 13 native passes / 0 failures remain recorded above; no new engine result is
claimed. No commit, push, branch switch or stash occurred. Prior logs:
`test-results/codex/057-gather-*`.

## Phase 5: columnar join and incremental refresh

Recorded 2026-10-10–11, Windows; measurement runtime Node 24.21.0. Existing generated projects,
stream records and Phase 4 caches were reused. Only temporary tiny test targets were constructed;
retained projects and native assets were not regenerated. No real project or Git history operation
was used. One heavy process ran at a time, with a 16,384 MiB heap cap per process and a 20 GB
parent-plus-child RSS guard. Every 10× command had an absolute 900-second startup-through-cleanup
watchdog. No 10× command expired, and the object join never ran at 10×.

The new library APIs are `refreshJoinedTarget`, `openJoinedTarget`, `hydrateJoinedTarget` and
`inspectJoinedTarget`. Manifest, archive, PO and package occurrence permutations sort by shared
namespace/key IDs and merge with bounded cursors. Unit membership, row references, source/state/
reason/problem/review columns and facet memberships use external buffers and typed arrays.
Packed A64 segments expand to UTF-8 buffers plus typed offsets, avoiding a JavaScript string per
dictionary entry. Normal identities and translation equality stay on IDs. Strings are decoded
for package-namespace stripping, literal String Table ownership, gather/path rules, source
metadata comparison, conflicting-source ordering, key-change places, notes/long-text signals,
review fingerprints and bounded hydration. Folder facets use IDs in the shared A64 path domain;
file/folder labels are interned in batches. Equal physical columns share aliases. Original
manifest/archive/PO row references preserve metadata during hydration, capped at 10,000 lines.
Raw-unit facets survive slices into different gathered identities. The cache key includes the
project root and string-ID generation; generation/dependency checks reject stale reads, and a
generation change triggers a full rebuild. The compaction regression verifies rejection,
full rebuild equality and the subsequent no-change fast path. Host migration is Phase 6.

### Equality and construction checks

Each fixture imports localization through the parser/import oracle and checks package records
through the package-layer oracle before invoking the Phase 1 line oracle. Comparisons include
identity, source, origin, original metadata, every culture's state/facts/reasons, pending PO text,
review and key changes. Tiny/fixture tests also compare problem bits and file/folder/origin/
editing/notes facets with today's query behavior. The final focused suite has 16 tests:

| Input                                     |   Passed / failed | Evidence                                                                                                                                                          |
| ----------------------------------------- | ----------------: | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `fixtures/unreal-project`                 |             1 / 0 | Every configured target equal                                                                                                                                     |
| `fixtures/legacy-unreal-project`          |             1 / 0 | Every configured target equal                                                                                                                                     |
| Legacy `Generated/4.27`                   |             1 / 0 | Every configured target equal                                                                                                                                     |
| Legacy `Generated/5.3`                    |             1 / 0 | Every configured target equal                                                                                                                                     |
| `fixtures/unreal-427-localization`        |             1 / 0 | Every configured target equal                                                                                                                                     |
| Perforce `baseline`                       |             1 / 0 | Every configured target equal                                                                                                                                     |
| Perforce `add-arrival`                    |             1 / 0 | Every configured target equal                                                                                                                                     |
| Perforce `conventional-baseline`          |             1 / 0 | Every configured target equal                                                                                                                                     |
| Perforce `conventional-move-actor`        |             1 / 0 | Every configured target equal                                                                                                                                     |
| Perforce `label-north`                    |             1 / 0 | Every configured target equal                                                                                                                                     |
| Perforce `move-east`                      |             1 / 0 | Every configured target equal                                                                                                                                     |
| Perforce `two-unclassified-package-edits` |             1 / 0 | Every configured target equal                                                                                                                                     |
| Seed 57, 0.0001                           |             1 / 0 | No/current/changed review; every line equal                                                                                                                       |
| Seed 57, 0.001                            |             1 / 0 | No/current/changed review; every line equal                                                                                                                       |
| Targeted semantic construction            |             1 / 0 | All three pairing tiers, ambiguity, literal/ref String Tables, keyless, outside, gathered-only, not-found, partial/excluded packages, metadata, split-unit facets |
| Two successive package/PO edits           |             1 / 0 | Object oracle equality; flat overlay equals every full-rebuild column                                                                                             |
| Saved 1× object oracle                    | 583,507 / 0 lines | Exact line comparison; frozen file reused                                                                                                                         |

The single authorized object-join run saved `phase5-oracle/oracle-1x.ndjson`
(2,786,473,773 bytes). Evidence loading / corpus / join-and-save took 50.125 / 73.509 /
44.477 seconds. Peak heap including pre-GC was 5,781,535,240 bytes; RSS 6,130,487,296 bytes. The first complete
comparison took 802.693 seconds, heap including pre-GC 7,540,871,872, array buffers 1,079,018,638 and RSS
9,111,605,248 bytes. The final-layout comparison reuses the same saved file and
passes 583,507 / 583,507 lines with zero differences in 525.928 seconds (537.999 seconds
startup through cleanup). Peak heap including pre-GC is 7,142,057,120 bytes, array buffers
1,093,978,163 and RSS 8,239,452,160, taking the greater of Node samples and OS polling. No second object join is authorized or performed.

The generator's Phase 4 header selection excludes apparent old-key packages. Those excluded
packages cannot prove absence: compared with the original raw Phase 1 census, 203 / 2,030
lines become unknown rather than not-found, with zero provable key-change pairs. The saved
1× object oracle confirms this behavior; no oracle correction is claimed. True not-found and
all pairing tiers are checked independently in tiny semantic cases.

The recipe verifier derives identities' categories from the seed construction, not the joined
output. The 1× target has 10 cultures and the 10× target has 20; every culture has these counts:

| State                                           |        1× |       10× |
| ----------------------------------------------- | --------: | --------: |
| translated                                      |   128,539 | 1,285,401 |
| not_translated                                  |     1,340 |    13,390 |
| not_synced                                      |     1,476 |    14,759 |
| not_gathered                                    |    60,769 |   607,690 |
| gathered_only                                   |     1,048 |    10,480 |
| outside_target                                  |     4,132 |    41,320 |
| unknown                                         |   386,203 | 3,862,030 |
| needs_update / changed_since_gather / not_found | 0 / 0 / 0 | 0 / 0 / 0 |
| Total                                           |   583,507 | 5,835,070 |

Keyless counts are 386,000 / 3,860,000; key-change pairs and ambiguities are zero. Every
culture has complete columns. Checks validate dictionary IDs, state/reason/problem bits,
input/review/pair references, both pairing directions and permutations exhausting all
occurrence/manifest rows. File and folder memberships cover each line once in this generated
construction. Folder counts sum to all lines: Content 578,327 / 5,783,270, Source and Config
each 524 / 5,240, L10N 4,132 / 41,320. These checks prove construction counts and structural
integrity. They do not prove arbitrary 10× identity/content equality with the object join.

### Full versus incremental decision

Initial full rebuilds after one changed package and one freshly parsed PO took 11.0029451 /
167.986709 seconds: **both fail** the 10 / 60 second refresh targets. A stable edit now patches
affected identities into one flat overlay over a retained full layer. There is no overlay chain;
the accumulated patch is capped at 8,192 rows. Structural identity/coverage, manifest/archive,
review/generation, short-source, conflicting-source and absence-candidate changes fall back to
a full rebuild. The measured package source edit plus PO edit affects one line. This satisfies
the specified refresh workload; it does not establish the same latency for every fallback.

Two successive tiny edits equal both today's object oracle and a full rebuild. At 1× and 10×,
the benchmark forces a full rebuild after the measured incremental refresh and compares
SHA-256 of **every logical column**, including aliases, row references and facets: 94 / 164
columns match, with zero differences across 583,507 / 5,835,070 lines. No-change refresh
stat-checks inputs, parses zero files, reads zero authored bytes and does not rebuild the join.

### Final measurements

Single runs without OS cache eviction. Cold means a fresh joined layer over already present
localization/package layers, not an empty project index. Heap peaks take the greater of sampled
heap and pre-GC trace peak. Array/RSS peaks are measured separately, not necessarily at one
instant. The RSS supervisor checks parent plus child; the child peaks below leave room for
the approximately 115 MB supervisor. All byte columns below are exact; MiB means 1,048,576 bytes.

| Operation                                       | 1× seconds | 10× seconds | Target / result                                       |
| ----------------------------------------------- | ---------: | ----------: | ----------------------------------------------------- |
| Cold join                                       | 11.1433659 |  99.9888654 | Measured; query/build acceptance remains later phases |
| No-change package + localization + join         |  0.5782796 |   2.1728796 | ≤5 / ≤30 s: pass; zero rebuilds                       |
| One package + fresh PO parse + incremental join |  4.4895785 |  44.0198648 | ≤10 / ≤60 s: pass; exactly one package and one PO     |
| Forced full rebuild for equality proof          |  7.5698603 |  94.0102752 | All logical columns equal                             |
| Complete final command, cleanup included        | 30.5247498 | 295.4457347 | Every 10× command ≤900 s: pass                        |

| Operation / metric               |      1× bytes |      10× bytes |
| -------------------------------- | ------------: | -------------: |
| Cold heap, pre-GC included       |   185,915,288 |    717,517,384 |
| Cold array buffers               | 1,193,168,714 | 15,198,570,998 |
| Cold child RSS                   | 1,465,794,560 | 15,780,085,760 |
| Refresh heap, pre-GC included    |   212,435,456 |    900,460,232 |
| Refresh array buffers            |   183,227,083 |  2,385,867,629 |
| Refresh child RSS                |   545,636,352 |  3,162,517,504 |
| Full-proof heap, pre-GC included |   187,918,984 |    736,702,872 |
| Full-proof array buffers         | 1,170,228,753 | 15,245,061,065 |
| Full-proof child RSS             | 1,468,178,432 | 15,898,247,168 |

Cold joined layers are 11,244,048 / 117,888,712 bytes (10.723 / 112.427 MiB). The following
whole-index table is captured **after the measured refresh, before retaining the full proof**.
The joined row includes its full base and active overlay. Physical accounting includes all
retained files and publication records, every declared Phase 2 dictionary width, plus stat
hints. No compaction or pruning credit is taken; staging files are excluded as in prior phases.

| Component                             |       1× bytes |           1× MiB |       10× bytes |             10× MiB |
| ------------------------------------- | -------------: | ---------------: | --------------: | ------------------: |
| Package layers                        |      4,687,352 |            4.470 |      30,987,100 |              29.552 |
| Manifest/archive/PO layers            |     15,398,828 |           14.685 |     303,046,592 |             289.008 |
| Joined full base + overlay            |     11,264,720 |           10.743 |     117,944,176 |             112.480 |
| Shared strings                        |     11,701,596 |           11.160 |     175,280,744 |             167.161 |
| Retained files, publication and hints |     10,513,417 |           10.026 |     132,642,521 |             126.498 |
| **Physical total / target**           | **53,565,913** | **51.084 / 100** | **759,901,133** | **724.698 / 1,024** |

The validation proof retains an additional immutable full joined layer. Physical totals
immediately after that proof are **64,810,089 / 877,789,965 bytes** (61.808 / 837.126 MiB),
still below both targets. These are separate accounting checkpoints, preserved in
`phase5-accepted-physical-after-proof.json`. After final oracle verification retains another
immutable layer, the 1× physical total is 76,075,037 bytes (72.551 MiB), still below 100 MiB;
see `phase5-accepted-physical-after-oracle.json`. The 10× total remains 837.126 MiB.

### Phase 5 command ledger

Commands use `NODE_OPTIONS=--max-old-space-size=16384`, serial heavy execution and the benchmark
supervisor. Replace `S` with `1` or `10`; existing inputs are
`test-results/game-text-scale/project-1x` / `project-10x-final`, records `phase4-records-Sx`.
Final cache names are `phase5-accepted-Sx`; the accepted runs use the uncached byte 122.
The harness's `--mode join --select all` performs inventory, input
restore, cold join, recipe/invariants, no-change refresh, changed refresh, size and full proof.

```text
node --import tsx scripts/benchmark-localization-import.ts --project <project-1x-or-project-10x-final> --cache test-results/game-text-scale/phase5-accepted-Sx --records test-results/game-text-scale/phase4-records-Sx --mode join --select all --po-change-byte 122 --output test-results/game-text-scale/phase5-accepted-Sx.json
```

The requested broad Vitest filter is exactly:

```text
packages/localization packages/game-text packages/unreal-assets apps/cli extensions/game-text scripts/game-text-scale.test.ts scripts/localization-import.test.ts scripts/game-text-dictionary.test.ts scripts/package-text-record.test.ts scripts/package-text-reader.test.ts scripts/package-text-layer.test.ts scripts/columnar-join.test.ts --maxWorkers=1
```

| Command                                                                   | Passed / failed / skipped                                                                                 |
| ------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| Benchmark join `--select oracle`, 1×                                      | 3 stages / 0 failed; one object join saved                                                                |
| Benchmark join `--select compare`, first 1× comparison                    | 583,507 lines / 0 differences; 1 stage / 0 failed; command 818.10 s                                       |
| Benchmark join `--select all`, initial full 1× and 10×                    | Each command completed; refresh target fails at 11.00 / 167.99 s                                          |
| Benchmark join `--select all`, before generation guard 1×                 | 8 stages / 0 failed; 94 logical columns equal                                                             |
| Benchmark join `--select all`, before generation guard 10×                | 8 stages / 0 failed; 164 logical columns equal; 305.39 / 900 s                                            |
| `pnpm exec vitest run scripts/columnar-join.test.ts --maxWorkers=1`       | 16 / 0; one file; 26.10 s                                                                                 |
| `pnpm --filter @ue-shed/game-text build`                                  | 1 build / 0 failures                                                                                      |
| `pnpm exec vitest run <broad filter>` — Node 24.21.0                      | 835 / 0 / 44; 93 files pass, 14 skipped; 294.97 s                                                         |
| Explicit Node 26.11.1 `node_modules/vitest/vitest.mjs run <broad filter>` | 835 / 0 / 44; 93 files pass, 14 skipped; 298.25 s                                                         |
| `pnpm test <broad filter>` — native enabled, Node 24.21.0                 | 872 / 0 / 7; 104 files pass, three skipped; 321.08 s; before generation guard                             |
| Explicit Node 26.11.1 `scripts/test.ts <broad filter>` — native enabled   | 872 / 0 / 7; 104 files pass, three skipped; 282.26 s                                                      |
| Benchmark join `--select compare`, final-layout 1×                        | 583,507 lines / 0 differences; 1 stage / 0 failed; 537.999 s end to end                                   |
| Changed-file `pnpm exec oxfmt`                                            | 19 paths / 0 errors; includes final generation guard                                                      |
| `pnpm run check:precommit`                                                | 6 stages / 0 failed; architecture 43 / 0; contracts in all four packages pass; first gate on Node 26.11.1 |
| Benchmark join `--select all --po-change-byte 122`, accepted 1×           | 8 stages / 0 failed; 94 logical columns equal; 30.52 s                                                    |
| Benchmark join `--select all --po-change-byte 122`, accepted 10×          | 8 stages / 0 failed; 164 logical columns equal; 295.45 / 900 s                                            |

| `pnpm test <broad filter>` — final native-enabled Node 24.21.0 | 872 / 0 / 7; 104 files pass, three skipped; 299.93 s |

| `pnpm run check:precommit` — final Node 26.11.1, workspace concurrency 1 | 6 stages / 0 failed; architecture 43 / 0; contracts in all four packages pass |
| `pnpm run format:check` after final status edits | 1 gate / 0 errors |
| `git diff --check` | 1 gate / 0 whitespace errors |

The broad filter includes all requested CLI workflows, not just the earlier Phase 4 five-file
CLI filter. Direct Vitest skipped 44 cases, including native CLI cases whose executable was
not supplied to the harness. Final native-enabled wrappers pass 872 / 0 / 7 on both Node 24.21.0 and Node 26.11.1.
The seven skips require live snapshots, commandlet evidence or an optional Blueprint sample. The 16 portable join tests are not skipped.
Measurement artifacts are `phase5-*.json`; test,
format/lint and benchmark logs are `phase5-*.log` in `test-results/game-text-scale`.

Iteration failures were corrected before final verification. The join sequence had 12/4,
14/2, 15/1 and 13/3 intermediate results; focused diagnostics had 0/1 with 15 skipped, then
1/0 with 15 skipped. Strategy guards and test harness errors were fixed. In particular, one
edited-PO comparison awaited an Effect without executing its importer, so object and columnar
joins received different PO versions. Running the reusable import oracle makes the inputs
equal and the comparison passes. A query-problem helper omitted `op: "is"` and assumed all
empty text was a missing table reference; it now derives empty-text signals from actual raw
units. These are demonstrated unequal-input/helper failures, not same-input semantic
differences or oracle corrections. Final focused comparisons pass 16/0. Initial lint found
13 errors and two new warnings, fixed with schema boundary decoding, explicit safety comments,
defined conditional spreads and `isDeepStrictEqual` for canonical input comparison. Initial
TypeScript errors were corrected; `tsc` package/scripts checks then passed. One command used
the nonexistent `scripts/tsconfig.json` (TS5058); corrected to `tsconfig.scripts.json`.

The focused suite after the generation guard passes 16 / 0 in 30.32 s; the compaction case
rejects a stale read, rebuilds exactly and restores the no-change fast path. Effect architecture
also passes / 0 errors. The first fresh-copy final-code measurement completed five stages,
then failed the fresh-parse precondition because the default PO mutation already existed in
the copied cache (23.37 s). The accepted rerun uses `--po-change-byte 122`; no semantic
comparison failed. A 10× startup attempt used nonexistent `project-10x/scale.json` and failed
before any stage; the actual retained input is `project-10x-final`. The first precommit passed,
but pnpm 11 ignored the initial `npm_config_workspace_concurrency` setting and used its default
typecheck fan-out. Final gate execution uses `pnpm_config_workspace_concurrency=1`, verified
with `pnpm config get workspace-concurrency`; no large benchmark overlapped either gate.

The repeated command is `pnpm exec vitest run scripts/columnar-join.test.ts --maxWorkers=1`;
`increment-*` diagnostic runs add a test-name filter for the incremental case. Log stems below
are under `test-results/game-text-scale`, with `.log` appended.

| Iteration log                        | Passed / failed / skipped |
| ------------------------------------ | ------------------------- |
| `phase5-increment-diagnostic-2`      | 0 / 1 / 15                |
| `phase5-increment-diagnostic`        | 0 / 1 / 15                |
| `phase5-increment-oracle-diagnostic` | 0 / 1 / 15                |
| `phase5-increment-proof-2`           | 1 / 0 / 15                |
| `phase5-increment-proof`             | 0 / 1 / 15                |
| `phase5-join-cases`                  | 15 / 0 / 0                |
| `phase5-join-facets`                 | 16 / 0 / 0                |
| `phase5-join-final-cases`            | 13 / 3 / 0                |
| `phase5-join-first`                  | 14 / 0 / 0                |
| `phase5-join-generation`             | 16 / 0 / 0                |
| `phase5-join-incremental-2`          | 14 / 2 / 0                |
| `phase5-join-incremental-3`          | 15 / 1 / 0                |
| `phase5-join-incremental-4`          | 15 / 1 / 0                |
| `phase5-join-incremental`            | 12 / 4 / 0                |
| `phase5-join-inputs-matched`         | 16 / 0 / 0                |
| `phase5-join-v3`                     | 15 / 0 / 0                |

| Additional command                                                       | Passed / failed                                                  |
| ------------------------------------------------------------------------ | ---------------------------------------------------------------- |
| `pnpm run lint`, initial                                                 | 0 gate passes / 1 failed gate; 13 errors, two new warnings       |
| `pnpm run lint`, precommit                                               | 1 gate / 0 failed; 11 existing warnings                          |
| Package / scripts `pnpm exec tsc -p ... --noEmit`, final targeted checks | Each gate passes / 0 errors                                      |
| `pnpm exec tsc -p scripts/tsconfig.json --noEmit`                        | 0 / 1 setup error (TS5058); correct file passes                  |
| `pnpm run effect:architecture`                                           | 1 gate / 0 errors                                                |
| Benchmark final-code fresh-copy 1×, default cached PO byte               | 5 completed stages / 1 fresh-parse precondition failure; 23.37 s |
| Benchmark startup with nonexistent `project-10x`                         | 0 stages / 1 path setup failure; corrected input passes          |

Native reader, parser, committed fixtures and Unreal integration are unchanged. UE 5.7 and
UE 5.8 engine lanes were not needed or rerun; prior results above are retained, not new claims.
Full `pnpm check` was not run. Changeset: `columnar-localization-join` (Game Text patch).
Saved-oracle, recipe, invariant and column proofs pass with no STOP condition. Final serial
precommit passes all six stages on Node 26.11.1, architecture 43 / 0 and contracts in all four
packages; workspace concurrency is verified as 1. Changed-file oxfmt covers 19 paths, and final
format/whitespace checks pass. Phase 5 is complete; host/query adoption remains Phases 6–7.

## Phase 6 STOP: conflicting-source order (historical, resolved below)

Recorded 2026-10-11, Windows. The first Plan 057 STOP condition applies: a columnar line
differs from the original-event oracle, which has not been shown to be wrong. The Phase 5
results above remain historical results on their inputs; this case reopens its equality
prerequisite. Phase 6 host adoption has not been implemented.

Two path-ordered, complete package records share namespace `UI` and key `Shared`.
`Content/Probe/Package00.uasset` has source `Alpha`, shard 247;
`Content/Probe/Package01.uasset` has source `Beta`, shard 230. The same records feed the
object corpus and package refresh. The original-event oracle's `Cases:["UI","Shared"]`
line has source **`Alpha Beta`**. The index hydrates **`Beta Alpha`**. Of sixteen matched
lines, exactly one differs, in exactly one field (`source`). All other line fields agree.

`loadJoinPackages` visits shard names in lexical order. The conflicting-source sort compares
unit ID then global occurrence row, preserving shard order when unit IDs match. The object
join instead retains original occurrence/source order. An oracle hydrated from the package
layers already shares their reordering and reports equality: the regression verifies this
blind spot separately, before asserting equality with the independent event oracle.

The regression is in `scripts/columnar-join.test.ts`. Preparation is in `beforeAll`, outside
the expected-failure wrapper, so setup failures fail the suite. Only the equality assertion
is `it.fails`; remove the annotation after fixing source order. Temporarily running that
assertion as an ordinary test produces the exact source mismatch, not a setup failure.
Raw evidence is `test-results/codex/phase6-order-probe.json` and `phase6-*.log` (ignored).

No real project, retained-project regeneration, 10× run or heavy-process overlap occurred.
Tiny invented test inputs are disposable. No package/app behavior or public contract changed;
no changeset is appropriate for the test/evidence changes alone. Both CLI and headless
Workbench cold/warm/query/heap/refresh measurements are not run at either scale because of
STOP; the target comparison table is in [the Phase 6 plan evidence](../../plans/057-game-text-compact-index.md#phase-6-stopped-on-conflicting-source-order).
No new UE 5.7/5.8 process or engine result is claimed. The requested broad host/component/e2e
tests and full `pnpm check` are not run after STOP; the known Data Authoring adoption failure
is prior evidence, not a failure measured in this pass.

### Commands in this pass

`V` means `node_modules/vitest/vitest.mjs run scripts/columnar-join.test.ts --maxWorkers=1`.
Node 24 uses `pnpm exec vitest run` with the same arguments; Node 26 uses the explicit
installed `C:/Users/denny/scoop/apps/nodejs/current/node.exe` (26.5.0).
The unwrapped/focused runs add `-t 'preserves conflicting source order'`.

| Command                                                                 |           Passed | Failed / expected failure        | Evidence                            |
| ----------------------------------------------------------------------- | ---------------: | -------------------------------- | ----------------------------------- |
| Standalone `node --import tsx test-results/codex/phase6-order-probe.ts` | 16 matched lines | 1 line / 1 source difference     | `phase6-order-probe.json`           |
| Unwrapped focused Vitest, Node 24.21.0                                  |                0 | 1 failed; 16 skipped             | `phase6-order-unwrapped-node24.log` |
| Corrected focused Vitest, Node 24.21.0                                  |       0 ordinary | 1 expected failure; 16 skipped   | `phase6-order-node24.log`           |
| Final V, Node 24.21.0                                                   |               16 | 0 unexpected; 1 expected failure | `phase6-join-node24-final.log`      |
| Final V, Node 26.5.0                                                    |               16 | 0 unexpected; 1 expected failure | `phase6-join-node26-final.log`      |

Final `pnpm exec oxfmt` on the three changed files passes **3 files / 0 errors**.
Final `pnpm run check:precommit` on Node 26.5.0 with workspace concurrency 1 passes
**6 stages / 0 failures**, including **43 architecture tests / 0 failures** and contract
checks in **4 packages / 0 failures**; lint retains eleven existing warnings.
Final `git diff --check` passes **1 gate / 0 whitespace errors**.
Final `pnpm run format:check`, after the evidence updates, passes **1 gate / 0 errors**.
Precommit evidence: `test-results/codex/phase6-precommit-final.log`.

Iteration/setup failures are excluded from acceptance: the first standalone probe held a
package writer open while acquiring a joined writer and failed with typed `busy`; separate
scopes corrected that. A separate new script was outside Vitest's include list (0 tests,
exit 1); the case moved into the existing join suite. The initial regression omitted its
record-factory import; first precommit passed format/lint, then failed scripts typecheck with
TS2304. Initial full suites each passed the sixteen existing tests, but their expected-failure
annotation hid the new setup error. The import was fixed, setup moved to `beforeAll`, and
the unwrapped run verified that the remaining failure is precisely the oracle difference.
**Phase 6 is incomplete; source-order equality must be restored before continuing.**

## Phase 6 continuation: source order fixed, new findings STOP

Recorded 2026-10-11 on Windows / Node 24.21.0 and 26.11.1. The source-order STOP above is
resolved. Native scanning sorts path components (`scanner.rs:251`); parallel extraction retains
path-indexed slots (`project_io.rs:568–637`) and saved export/property traversal (`:793`). The
TypeScript reader does not reorder them (`asset-reader.ts:557–576`). The corpus preserves unit
occurrences, sorts distinct unit source values and unit IDs (`corpus.ts:713–741`), while the
localization source fold preserves distinct occurrence sources in insertion order
(`localization.ts:355–360`). Sorting source-value sets does not sort a localization line's source;
the final line-ID sort (`localization.ts:519`) does not change the fold either.

The index now ranks paths by Rust's component comparison, uses that rank and occurrence ordinal
independently of shards, and sorts package records before oracle hydration. In particular,
`Content/A/B.uasset` precedes `Content/A.uasset`. Within a package, native traversal remains the
order even when object/property names sort differently. `joined-v5` invalidates older joins and
overlays. Changeset `preserve-package-source-order` records the Game Text bug fix; today's corpus
and public contract behavior do not change.

All twelve fixture projects, both tiny scales (0.0001× / 0.001×), both existing targeted cases,
and four source-order regressions pass on both Nodes: **20 ordinary passes / 0 failures**.
Fixture, tiny and semantic comparisons now use independent original events rather than the
already reordered layer oracle. The source cases also compare the entire hydrated corpus,
including ordered occurrences, directly with the independent event corpus.

The saved 1× oracle was reused twice; no object oracle or retained inputs were regenerated:

| Saved 1× comparison               | Seconds | Matched lines / differences | Peak heap / array buffers / RSS, MiB |
| --------------------------------- | ------: | --------------------------- | ------------------------------------ |
| Initial corrected fold            |  453.38 | 583,507 / 0                 | 7,826.85 / 926.94 / 9,117.75         |
| Final native component comparator |  363.74 | 583,507 / 0                 | 4,933.42 / 1,087.85 / 5,518.55       |

Both runs count **0 conflicting-source lines and 0 conflicting sources across packages**. The
generated duplicate sources do not create conflicting sources for one gathered identity, so
the earlier 583,507-line match could not expose this defect. These supervised oracle checks
use the Phase 5 16 GiB heap cap, not the Phase 6 default-heap host query measurement. No 10×
object oracle or benchmark was run. Total RSS stayed below 20 GB; heavy commands ran serially.
An independent streaming search of the saved oracle also finds zero `conflicting_source` values
(`phase6-saved-oracle-conflicts.log`), corroborating the joined-column census.

**New STOP: findings for split gathered identities.** A saved identity `UI [literal] / T`
contributes an asset property to gathered `UI / T` and a string-table entry to gathered
`UI [literal] / T`. The two sources are individually short (24 / 23 characters), but the
columnar raw-unit pass measures their combined length, 48 characters. Today's query slices
the saved unit per gathered line before deriving its findings; both line findings are false.
The columns mark both true. `joined-target.ts:313–334,799–825` must match the actual sliced query
behavior in `query.ts:238–255,83–105`. Raw-unit facet expectations also need an audit against that
API. This is the first plan STOP condition (a same-input per-line problem difference); there is
no evidence that today's oracle is wrong.

The unwrapped reproduction fails on both Nodes. The permanent test checks corpus/unit shape,
line-schema equality and the exact two oracle negatives/columnar positives in `beforeAll`,
outside `.fails`; only problem equality remains an expected failure. The previous source-order
regression has no expected-failure annotation. A passing gate does not establish full join
equality while this known semantic failure remains.

The query backend, shared refresh service, host migration and write invalidation remain pending.
The existing product heap guidance remains applicable. No public schema changed; no host/app
changeset is added. Complete inventory/signature access is an implementation prerequisite, not
the new STOP. No real project, retained regeneration, commit, push, branch switch or stash was
used. Disposable fixture copies used by verification are separate from retained inputs.

### Phase 6 target comparison

Each result below applies separately to CLI and headless Workbench main, at both scales.

| Measurement                                    | 1× target    | 10× target | Result after STOP |
| ---------------------------------------------- | ------------ | ---------- | ----------------- |
| First query after cold build                   | Record       | Record     | Not measured      |
| First query with warm index                    | Record       | Record     | Not measured      |
| Count / filter / facet / page / search / focus | ≤100 ms each | ≤1 s each  | Not measured      |
| Peak query heap at default heap                | ≤128 MiB     | ≤256 MiB   | Not measured      |
| No-change refresh                              | ≤5 s         | ≤30 s      | Not measured      |
| One package + one PO refresh                   | ≤10 s        | ≤60 s      | Not measured      |

### Continuation command ledger

Logs are under ignored `test-results/codex`. `V` is `node_modules/vitest/vitest.mjs run`;
Node 26 uses `test-results/game-text-scale/runtime/node-v26.11.1-win-x64/node.exe`.
Every Vitest run uses `--maxWorkers=1` and the existing native `uasset` executable.

| Command                                                                                                                                                                                                                                                                                                                   | Node / engine |        Passed | Failed / skipped                 | Log or result                                   |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------- | ------------: | -------------------------------- | ----------------------------------------------- |
| `V scripts/columnar-join.test.ts`, source-order fix                                                                                                                                                                                                                                                                       | 24.21.0       |            20 | 0                                | `phase6-native-order-node24.log`                |
| Same, source-order fix                                                                                                                                                                                                                                                                                                    | 26.11.1       |            20 | 0                                | `phase6-final-order-node26.log`                 |
| Same, final code with new STOP regression                                                                                                                                                                                                                                                                                 | 24.21.0       |            20 | 0 unexpected; 1 expected failure | `phase6-order-and-stop-final-node24.log`        |
| Same, with new STOP regression                                                                                                                                                                                                                                                                                            | 26.11.1       |            20 | 0 unexpected; 1 expected failure | `phase6-order-and-stop-final-node26.log`        |
| Unwrapped new STOP, focused                                                                                                                                                                                                                                                                                               | 24.21.0       |             0 | 1 failed; 20 skipped             | `phase6-split-findings-reproduction-node24.log` |
| Unwrapped new STOP, focused                                                                                                                                                                                                                                                                                               | 26.11.1       |             0 | 1 failed; 20 skipped             | `phase6-split-findings-reproduction-node26.log` |
| `node --import tsx scripts/benchmark-localization-import.ts --project test-results/game-text-scale/project-1x --cache test-results/game-text-scale/phase5-final-verified-1x --records test-results/game-text-scale/phase4-records-1x --mode join --select compare --output test-results/codex/phase6-final-order-1x.json` | 24.21.0       | 583,507 lines | 0 differences                    | `phase6-final-order-1x.json`                    |
| `V apps/cli apps/workbench extensions/game-text packages/game-text packages/localization packages/unreal-assets`                                                                                                                                                                                                          | 24.21.0       |           990 | 0 failed; 7 skipped              | `phase6-hosts-node24.log`                       |

The requested host suites include the native CLI integrations and all six Game Text component
files. Node 26 also passes **990 / 0 / 7 skipped**, in 259.25 s (`phase6-hosts-node26.log`);
the separate `V --project component extensions/game-text` run passes **88 / 0**, six files,
in 50.15 s (`phase6-game-text-components.log`). UE 5.7's `pnpm test:localization-processes`
passes **1 engine lane / 0 failed lanes**, including review persistence, apply/PO writes, sync,
audit, cancellation and carrying a key across gather (`phase6-localization-processes-57.log`).
Its disposable output is `out/loc-processes-beeb2d`; it does not rewrite the retained fixture.

UE 5.8's separate `pnpm test:localization-processes` also passes **1 engine lane / 0 failed
lanes**, including the same write/cancellation/carry checks (`phase6-localization-processes-58.log`,
disposable output `out/loc-processes-6e6b09`). Engine roots were discovered from the local install
inventory and confirmed with `Engine/Build/Build.version`: 5.7.4 and 5.8.3. Native reader/parser,
codegen and retained fixtures were not changed, so no new `test:uasset-engine-matrix` result is
claimed.

`pnpm test:e2e:workbench showcase-improvements.e2e.ts --grep 'Game Text'` builds Workbench
and runs **0 passed / 3 failed** (`phase6-game-text-e2e.log`). These existing scenarios ask for
the old `Quality` tab and assume an immediate search/export view. The unchanged UI instead shows
`Quality checks` and an initial `Scan project` action. The same incompatible selectors and idle
UI are present at `HEAD`; neither the e2e file nor renderer/main host implementation changed in
this pass. This is separate from the new columnar findings STOP. The run used only the synthetic
fixture root, isolated Electron profiles and disposable rule/export files, with an offline
Remote Control endpoint; no live or real project was accessed.

Final changed-file oxfmt passes **9 files / 0 errors** (`phase6-oxfmt-final.log`).
`pnpm run check:precommit`, Node 26.11.1, passes **6 stages / 0 failures**, including
**43 architecture tests / 0 failures**, contracts in **4 packages / 0 failures**, typecheck,
StyleX checks and repository formatting (**1,966 files**). Lint has zero errors and eleven
existing warnings (`phase6-precommit-continuation.log`). `git diff --check` also passes.

Full `pnpm check`, Node 26.11.1, passes **10 top-level stages / 1 failed stage**, then exits
at Data Authoring adoption (`phase6-full-check.log`). Completed stages include native/libraries/
WASM UAsset checks, package builds, engine supervisor checks, typecheck, Effect architecture,
license, StyleX, **43 architecture tests / 0 failures**, **42 release tests / 0 failures**, and
packed-package conformance (**20 tarballs / 0 failures**). The Rust test commands total
**356 passed / 0 failed / 4 ignored**. Browser WASM smoke, packed-consumer exports, native/WASM
fixture parity and saved review also pass.

The failed adoption stage reports TS2307 in its copied `packages/protocol/src/index.ts:163`:
`./editor-foreground-responsiveness.js` is missing. At committed `HEAD`, the protocol index
already exports that module while `extensions/data-authoring/adoption.manifest.json` omits it;
neither file changed in this pass. This is the brief's known pre-existing adoption failure,
separate from the semantic STOP and existing e2e failures. The subsequent full-gate lint,
format, contract and whole-repository test stages do not execute after that failure; precommit
and the requested host suites supply their separately reported checks, not a full-gate pass.

Final evidence updates are included in the changed-file formatting and whitespace checks.
**Phase 6 is incomplete.**
