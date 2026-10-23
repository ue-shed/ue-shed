# Plan 059: native fact repairs and corpus fixes

Implementation follows the owner's narrowed scope of 23 October 2026. Plan 059's design text and
`059-phase1-stop-report.md` are unchanged. The untracked `rule-ir.ts` draft and `.task-cache/`
were deleted. No v4 contract, IR, builder, evaluator or findings-layer design was implemented.

## Commits

All commits are local on `feat/game-text-engine-phase1`; nothing was pushed and no PR was opened.

| Commit     | Change                                                                                |
| ---------- | ------------------------------------------------------------------------------------- |
| `4c3ec72f` | Remove retired native localization actions and overlay publisher.                     |
| `177d30a4` | Distinguish missing String Table entries from unavailable tables.                     |
| `ddad282b` | Validate foreign archive sources against the native archive override.                 |
| `3bf0e3b3` | Fold compiled Blueprint literals into their unique authored pins.                     |
| `f1254eed` | Resolve collapsed PO identities by namespace and effective source.                    |
| `280feaa5` | Prove deleted packages absent from the complete prepared inventory.                   |
| `704c68b7` | Assert planted rename fixes, add nested plurals and serialize corpus scans.           |
| `18246126` | Align saved-fixture assertions with corrected source and copy facts.                  |
| `4d01651e` | Guard missing manifest input in the TS reference join; separate native test archives. |
| `91b15b2d` | Accept the appended missing-entry reason bit in persisted join inspection.            |
| `889bccca` | Attempt to read older corpus bookkeeping; reverted by the next commit.                |
| `df58d010` | Revert that compatibility adapter; retained expectations remain strict.               |
| `8a15e019` | Isolate saved-source changes from native translation changes in the recipe.           |
| `b6d08af3` | Plant existing Japanese plural-modifier behavior in the nested cases.                 |

## Defects repaired

| Defect                      | Root cause                                                                                                                                                                                | Repair and regression coverage                                                                                                                                                                                                                                                                                                                                                                                                              |
| --------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `reference-missing-key`     | An unresolved entry in an existing String Table was treated as untranslated, without distinguishing it from a missing table namespace.                                                    | Preserve `unknown` with appended reason `string_table_entry_missing`; update Rust/TS reason enumerations, bit validation, labels and docs. Persisted Rust and pure TS cases distinguish a missing table from a missing entry.                                                                                                                                                                                                               |
| `native-source-override`    | Foreign archive validity used the raw manifest source even when Unreal uses a different native archive translation as its source.                                                         | Match `FLocTextHelper::GetExportText` and `GetRuntimeText` in UE 5.7 and 5.8: when native archive Source and Translation differ by exact text/metadata comparison, use native Translation as the foreign expected source. Include that archive as a dependency even when native culture is outside the selected scope. Rust cases cover current/stale sources, metadata and empty overrides; TS quality tests cover the resulting evidence. |
| `compiled-copy-differs`     | Package-stamp reconciliation required equal source text, so an older compiled literal lost its authored pin's identity. Function bytecode and the pin also have different property paths. | Reconcile by clean namespace/key, then fold a generated function literal into its unique authored Blueprint pin. Keep the pin's source and the compiled source as copy provenance. Ambiguous pin ownership stays separate. Rust reader tests and saved UE 5.7/5.8 assets cover the identities; TS tests cover current/stale, ambiguous and unrelated copies. The related `wired-pin-shared` pin also became stale and was removed.          |
| `collapse-mode-identity`    | `IdenticalNamespaceAndSource` caused blanket target-wide PO ambiguity.                                                                                                                    | Resolve namespace-only PO contexts by namespace and effective source, retaining explicit keyed lookup and duplicate detection. Persisted Rust and TS cases cover unique pairs and multiple keys sharing a source.                                                                                                                                                                                                                           |
| `deleted-package-not-found` | An absent package path was indistinguishable from an unprepared inventory. Deleting the last package removed the last preparation marker.                                                 | Treat absence from the prepared complete inventory as `not_found`; retain `unknown` for unprepared, partial and failed coverage. Publish an empty package layer after the last deletion. Persisted Rust and package-layer TS cases cover those distinctions.                                                                                                                                                                                |

Finding identity computation and the existing golden IDs are unchanged.

## Deleted paths

The caller audit covered Rust, TS, CLI, Workbench and extensions. Neither retired inline action
had a host caller. `join_overlay::publish` had one internal Rust call, but rejected the current
joined-key prefix before publishing anything; both the call and the module were removed.
The two request variants, validation/dispatch branches and unused page helper were removed,
and the existing wire contracts were regenerated. `localization_focus_export` and its detail
helper remain live. Remaining old action strings are rejection tests and an internal test label.

## Fixture repairs and parity

`CorpusFinding.fix` is optional and has today's proposed-change fields: target, culture,
namespace, key, source, previousTranslation and translation. Rename replacements are planted
from recipe argument slots, including nested plurals. New expectations assert fixes explicitly;
older retained expectations retain their original evidence assertions. Portable tests compare
the planted fixes with today's TS check and validate the current change-set shape.

Two recipe corrections have construction/source evidence:

- `changed-since-gather` previously changed native Translation while keeping foreign archive
  Source old. UE 5.7/5.8 `LocTextHelper.cpp` then requires foreign `needs_update`, contrary to
  the recipe's expected `translated`. The recipe now leaves the native archive at gathered text
  so it isolates the saved-package change. Its expected facts were preserved.
- The new nested plural and its near case omitted today's Japanese `redundant_modifier`
  findings. The existing plural recipe already plants those source/translation findings.
  Both new cases now plant the same evidence, with regression coverage across two seeds.

The original requested folders were inspected without modification:

- `E:/ue-shed-fixture-scratch/canonical/Content/Fixture/Corpus` predates required density/edit
  bookkeeping and the `gatheredSource` expectation field; its strict decoder fails.
- `E:/ue-shed-fixture-scratch/ue57/Content/Fixture/Corpus` has three unexpected foreign subjects
  from the saved-source/native-override recipe error above, zero stale pins and three pinned
  disagreements.

To respect the restriction on writes, canonical seed 1, 256 requested lines, density 1 was
regenerated under the allowed `p1-*` paths. Each constructs 280 lines / 1,120 main subjects,
plus its separate collapse probe. No comparison adapter rewrites expected answers.

| Engine   | Regenerated canonical corpus folder                                         | Compare                         | Corpus integration |
| -------- | --------------------------------------------------------------------------- | ------------------------------- | ------------------ |
| UE 5.8.3 | `E:/ue-shed-fixture-scratch/p1-canonical-ue58-facts/Content/Fixture/Corpus` | 0 unexpected, 0 stale, 3 pinned | Passed             |
| UE 5.7.4 | `E:/ue-shed-fixture-scratch/p1-canonical-ue57-facts/Content/Fixture/Corpus` | 0 unexpected, 0 stale, 3 pinned | Passed             |

One fuzz run used UE 5.8, seed `59102317`, 10,000 requested lines and the default density of
five. It constructed 11,019 initial lines / 44,076 subjects, including scaffolds, and 11,020
lines after the package edit batch.

| Fuzz stage                  | Unexpected | Stale |
| --------------------------- | ---------- | ----- |
| Initial scan                | 0          | 0     |
| Edited incremental scan     | 0          | 0     |
| Fresh full scan after edits | 0          | 0     |

Full versus incremental: **0 differences**. Each stage retains 15 pinned instances, five for
each of the three remaining defects. Evidence is in
`E:/ue-shed-fixture-scratch/p1-fuzz/59102317-1792735285974`, including `comparison.json`,
`incremental-comparison.json`, `full-after-comparison.json` and `refresh-differences.json`.

## Checks

- `cargo fmt --all -- --check` passed.
- Tests for `game-text-index`, `uasset-io` and `uasset-inspection`, all targets: 270 passed,
  three existing ignored cases; clippy for all three crates passed with `-D warnings`.
- Full `pnpm run typecheck` and all four contract checks passed under Node 26.12.0.
- Full static gate passed: lint, formatting, dependency/license/StyleX checks, Effect/public API
  checks and all 319 architecture tests.
- Requested Vitest scopes (`game-text`, `unreal-assets`, Workbench main, Game Text extension):
  154 files / 1,068 tests passed, with eight gated tests skipped. Corpus integration was then
  enabled separately and passed for both regenerated corpora.
- Additional persisted/reference join regressions passed (33 tests), as did the other package
  layer, incremental and chunk regressions. The fixture-fix suite passed all five tests.

## Pins, costs and handoff

The remaining pins are `empty-translation-whitespace`, `manifest-notes-filter` and
`detail-culture-scope`. They concern TS check policy, notes filtering and detail culture scope
outside this round's narrowed native fact fixes. No pin was added.

Native joined keys and package-text cache keys were advanced so old incorrect facts/copies
rebuild. Changed collapsed targets conservatively use a full join because current incremental
dependency edges are keyed by identity, rather than namespace/source. Native source overrides
also retain translation metadata columns and a native archive dependency. No benchmarks ran.

All heavy validation and Unreal runs held `E:/es-id-repairs-scratch/unreal.lock`; the final
validation batch retained that lease continuously and serialized child operations on a local
mutex. Runs used `RAYON_NUM_THREADS=16`, `CARGO_BUILD_JOBS=8` and Node 26. No Perforce command,
push, PR, Electroswag edit or UI/UX work was performed.

The regenerated canonical folders are the reviewable replacements for the retained artifacts.
Replacing the original folders is outside the allowed write locations for this task.
