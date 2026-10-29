# Game Text coverage compared with Unreal gather

Game Text's headless rescan reads saved package evidence and previously generated localization
files. It does not run a fresh Unreal gather. When a supported gather operation is explicitly run,
UE Shed launches Unreal's own commandlets and then reads their outputs; that operation has the
coverage of the selected Unreal recipe, not just the saved-package parser.

## What a headless rescan can miss

| Source or behavior                                    | Current saved-scan limitation                                                                                                                                                                                                                                                                                                                                                                                                  | What a fresh Unreal gather adds                                                                                                                                                                                            |
| ----------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| C++ and INI text                                      | Read with `unreal-code` when the host names the project's engine ([Code text](../products/game-text.md#code-text)), exactly as the target's source steps would. Without the engine, new, changed and removed `LOCTEXT`, `NSLOCTEXT`, UI-command and localized log text cannot be discovered.                                                                                                                                   | The source commandlet parses its configured files, namespaces, macro wrappers and conditional/editor-only context.                                                                                                         |
| Code-defined and CSV String Tables                    | Saved String Table assets are decoded. Code definitions, `LOCTABLE` entries and CSV files loaded by `LOCTABLE_FROMFILE_GAME` or `LOCTABLE_FROMFILE_ENGINE` are read with the target's code when its engine is named; asset references to a code-defined table are not yet resolved against it. References cannot manufacture a missing definition.                                                                             | The source commandlet collects definitions and loads the referenced CSV data.                                                                                                                                              |
| Reflected metadata                                    | User-defined enum display names are read from saved enum assets. The scan does not evaluate configured metadata input keys, output namespaces and key patterns over reflected fields.                                                                                                                                                                                                                                          | Configured metadata gathering can collect enum names, display names, tooltips and other metadata. In 5.8, asset gathering can also use the metadata helper.                                                                |
| Blueprint script bytecode                             | Text literals (`EX_TextConst`) in every saved `UFunction`'s script are read on UE 4.27 to 5.8. Level Blueprint functions in maps are walked the same way; real maps decode without errors, but no Level Blueprint text literal has been checked against Unreal yet. A function whose script cannot be followed is a decode error, so its package is partial. Graph pin text is not yet reported as a separate authoring place. | Unreal walks script text constants when loading the package. Saved gather caches cannot reliably replace this step for bytecode-bearing assets.                                                                            |
| Custom gather callbacks and unsupported serialization | The parser reads supported saved representations; it does not execute project/plugin class or struct callbacks, load-time initialization or arbitrary native serialization. Unsupported text histories and version-gated containers can also hide text. Dialogue/voice workflows are outside the product scope.                                                                                                                | Unreal loads the applicable classes/modules and invokes its reflection and type-specific gather behavior.                                                                                                                  |
| Plugin and engine content roots                       | The default Project Index inventory enumerates the project's `Content` directory. It does not inventory `Plugins/<plugin>/Content`, installed plugin content or engine content as additional mounted roots. Explicit lower-level reads can differ from the default inventory.                                                                                                                                                  | A configured gather can select assets through Unreal's mounted roots and Asset Registry.                                                                                                                                   |
| Exact gather inclusion and context                    | Scope inference handles project-relative paths, filename patterns and some class exclusions. It lacks complete reflected ancestry and per-site editor-only, optional, platform and custom-context decisions. Unavailable class/settings evidence produces unknown reasons where modeled.                                                                                                                                       | Unreal applies the actual recipe, reflected flags, archetype/default comparisons, manifest dependencies and source-site context. This can exclude text that our broad saved scan shows, as well as include text it misses. |

Previously gathered text from these sources is still visible when the selected target's readable
manifest supplies it. It is evidence from that gather, not proof of the current source file. For
example, a new C++ line remains invisible until gathered; an edited C++ line can continue to show
its old manifest text. Reading an archive or PO file does not independently discover new source.
Asset-origin evidence can acquire unknown/not-found states under the existing join rules; every
unmatched line should not be assumed to be gathered-only.

## Coverage and diagnostics

`complete` means every runtime entry in the package's saved gatherable text table was decoded. The
editor writes that table when it saves a package, and Unreal's asset gather reads it instead of the
exports, so it is the engine-authored list of localizable text the package contributes. Entries are
matched by namespace, key and source string, because Unreal groups gathered text by namespace and
source and treats another source under the same key as separate text. The table namespace is
compared as saved: Unreal already removed the package namespace marker from `FText` entries, and
String Tables save their authored namespace. Decoded `FText` namespaces lose that trailing marker
once; String Table rows keep theirs. Editor-only sites are skipped as the default gather skips
them. Known unsupported histories, rejected decoders, unavailable engine
features and legacy containers still produce coverage gaps, but only a missing table entry makes a
package partial: an export that fails to decode can lose a place, not a gathered line. Skipped graph
pins remain partial independently of the table.

The table is only used when Unreal's gather would use it. The reader mirrors
`UGatherTextFromAssetsCommandlet::CalculatePackageLocCacheState`: Unreal loads a package instead of
reading its table when the package predates gather flagging or `GatheredTextEditorOnlyPackageLocId`,
is an external actor package saved before `FixedLocalizationGatherForExternalActorPackage`, is an
old dialogue wave, or is flagged `PKG_RequiresLocalizationGather` without a table. The last case is
common: `SavePackage` writes no table for packages with script bytecode (every compiled Blueprint
and Widget Blueprint), text keyed with a stale package localization ID, or text initialized from a
string. Those packages, packages saved before the table existed, and unreadable tables keep the
decode-error-or-text-capable-gap rule. uasset-io 1.18 reports `may_contain_text` on every gap and
`textGapCounts` beside the complete per-reason `gapCounts`. Numeric values, names, object references,
soft paths and source-proven text-free native layouts retain their gaps without forcing partial
status. Missing type information remains text-capable. The table does not depend on running a
gather; the editor writes it on
every uncooked save. The project-level `SkipGatherCache` setting is not modelled.
`complete` does not certify parity with every Unreal gather source.
Excluded packages have `not_gatherable`, which does not prove the absence of text.

The table is written with the package, so it matches the saved exports. Packages with bytecode
have no table at all, so Blueprint text uses text-capable decoder gaps. Their compiled text literals
are read from the bytecode itself, one `ScriptBytecode[N]` place per distinct literal in a function. UE 5.8 renumbered the saved literal types when it added translator notes; the reader takes the 5.8 numbering from FortniteMain `AddDevNotesToFText` (260), the only saved marker for that change. An unread table entry is reported with its source string and site even though the reader
could not place it.

There are also blind spots outside those counters: source files are scanned only when the host
names the engine, default inventory omits other mounted content, and custom callbacks are not run.
Modern opaque export tails and binary-only exports do not all become text-specific gaps.
Zero findings or zero reported decoder gaps therefore cannot certify complete localization coverage.

The scan can display culture-invariant or unresolved saved text that Unreal intentionally does not
gather. Empty/whitespace-only text and String Table references are also not independent gathered
sources. More saved occurrences than manifest lines is not by itself a gather defect.

Unsaved editor changes and arbitrary runtime/server-generated strings are outside the saved scan.
A normal separate-process Unreal gather is not an audit of unsaved editor memory or every string
that can appear during play either. Rendered width, culture fallback and runtime localization
loading require separate runtime validation.

## Practical workflow and next improvements

Use rescan for supported saved assets, fast search and source-to-manifest drift. Use a fresh Unreal
gather before certifying target completeness or treating source-code changes as checked. UE Shed's
operation planner supports standard source, asset and metadata recipes; custom commandlets,
platform-split output and gather-cache repair/report recipes are currently rejected. Such recipes
must run through their existing Unreal workflow and their generated evidence can then be refreshed.

The next coverage work should first expose these source boundaries in reports and compare the
headless identity/source set with fresh 5.7 and 5.8 gather output. Extend the shared Project Index
for mounted roots instead of adding another feature-owned enumerator. A bounded source/CSV reader
would improve pre-gather review. Saved gatherable-text payloads now decide package coverage; they
could also supply site context and translator notes for unread entries. Custom callbacks need
dedicated support or an explicitly requested Unreal gather.

These are proposed follow-ups, not changes implemented by the performance work.

## Evidence

This comparison was checked against both locally installed UE 5.7 and UE 5.8 sources on 2026-10-13:

- `Editor/UnrealEd/Private/Commandlets/GatherTextFromSourceCommandlet.cpp`:
  `GetParsables`, String Table/CSV descriptors and INI handling.
- `Editor/UnrealEd/Private/Commandlets/GatherTextFromAssetsCommandlet.cpp`:
  package loading, external actors, class exclusions and source-site processing.
- `Runtime/CoreUObject/Private/Serialization/PropertyLocalizationDataGathering.cpp`:
  type-specific callbacks, reflected properties, archetype comparisons and script-bytecode text.
- `Editor/UnrealEd/Private/Commandlets/GatherTextFromMetadataCommandlet.cpp`, plus 5.8's
  `Editor/UnrealEd/Private/GatherTextMetaDataHelper.cpp`: reflected metadata gathering.

Repository evidence: [default inventory](../../crates/uasset-io/src/direct_executor/scanner/discovery.rs),
[text projection](../../crates/uasset-inspection/src/projection.rs),
[text decoder](../../crates/uasset-parser/src/codec.rs),
[candidate selection](../../packages/game-text/src/package-text-candidates.ts),
[scope inference](../../packages/game-text/src/localization.ts) and
[operation planning](../../packages/localization/src/operation-plan.ts).

Epic's [pipeline optimization guide](https://dev.epicgames.com/documentation/en-us/unreal-engine/pipeline-optimization-for-localization-in-unreal-engine)
explains saved gather caches, the bytecode exception and intentionally nongathered text.
Its [localization tools guide](https://dev.epicgames.com/documentation/en-us/unreal-engine/localization-tools-in-unreal-engine)
and [localization overview](https://dev.epicgames.com/documentation/en-us/unreal-engine/localization-overview-for-unreal-engine)
describe target recipes and the generated manifest/archive/resource pipeline. This was a source
comparison, not a new exhaustive project gather or a fresh engine conformance run.
