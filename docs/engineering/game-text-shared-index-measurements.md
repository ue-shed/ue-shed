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

## Phase 4: Unreal gather eligibility, measured fixture audit; layer unfinished

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

| Package layer / whole index measurement    | 1×           | 10×          | Target                              |
| ------------------------------------------ | ------------ | ------------ | ----------------------------------- |
| Actual package layer size                  | Not measured | Not measured | Included in whole index             |
| Whole index including actual package layer | Not measured | Not measured | ≤100 / ≤1,024 MiB                   |
| Cold package build                         | Not run      | Not run      | Bounded run; no forecast acceptance |
| No-change package refresh                  | Not run      | Not run      | ≤5 / ≤30 s                          |
| One changed package                        | Not run      | Not run      | Changed package only                |
| One package + one PO file                  | Not run      | Not run      | ≤10 / ≤60 s                         |

Phase 3's size table above still contains an estimated package proxy. It does not establish
Phase 4 size or refresh acceptance and gets no candidate-pruning credit. The generated event
stream has no package flags; its future layer conversion must explicitly mark generated text
packages flagged and other packages unflagged, without regenerating the stream.

**Verification command ledger.** All commands use the heap cap and serial heavy execution.
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

Remaining: signature-keyed refresh (new, changed, removed, renamed and gains/losses of eligibility),
shared-store occurrence/coverage columns with one cold sort, the reusable layer-to-corpus oracle,
and all six 1×/10× measurements above. Keep the current full corpus oracle for Phase 5.
No commit, push, branch switch or stash occurred. Logs: `test-results/codex/057-gather-*`.
