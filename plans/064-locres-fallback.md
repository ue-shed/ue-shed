# 064: A culture's translations from its `.locres`

Status: built on `feat/locres-native`, waiting for review. Decided by the owner: fork 1A (a
culture reads its resource only when it has no archive) and fork 2A (without a manifest, the
resource decides what it can). Builds on the native `.locres` reader and import (format `locres`).

## Why

Game Text reads a culture's translations from its archive, with the PO as the newer stage. A
project that keeps no archives, only the compiled resource, showed no translations at all: every
line was `unknown` (no manifest) or `not_translated` (manifest but no archive). The `.locres` is
what the game shows, so it is real evidence of what ships.

Hex, checked read-only on 2026-11-06:

- `EngineAssociation` 5.7.
- `Content/Localization/Game/id/Game.locres`, version 3 (magic + `03`), 814 bytes, read-only.
- No `Config/Localization/`, no `Game_*.ini`, no manifest, no archives, no PO.
- `Config/DefaultEditor.ini` has a Dashboard target `Game` (cultures `en`, `id`, native `en`,
  gathering packages under `Content/Hex/Localization/*`).

So Hex's target is known from the Dashboard but none of its outputs are configured; only the
runtime convention finds its resource.

## What Unreal writes (5.8 `TextLocalizationResourceGenerator.cpp`, 4.27 the same rule)

For each manifest entry and context, the generator asks `GetRuntimeText` for the culture's text
(`ELocTextExportSourceMethod::NativeText`) and calls
`AddEntry(namespace, key, manifestSource.Text, translation.Text)`. So:

- The stored hash is always `HashString(manifest source)`, never the native culture's text. It is
  proven on every fixture entry (`locres::source_hash`).
- The display string is the archive translation when it was made from the current source and is
  not empty. Otherwise it is the native culture's text for that key, or the source. Native entries
  are always "translated" (`bIsTranslated = bIsNativeCulture || ...`).
- 5.x writes every manifest entry, translated or not. 4.27 leaves untranslated entries out (the
  `de`/`fr` fixtures are empty).
- Entries with a platform context go into per-platform resources (`Platforms/<P>/<culture>/`).
  Only the platform-agnostic resource is read.

## As built

### Discovery (`packages/localization/src/targets.ts`, `service.ts`, `file-access.ts`)

A project with no gather configs is asked for its compiled resources by Unreal's runtime
convention, `Content/Localization/<Target>/<culture>/<Target>.locres` (the folder name equals the
file stem; `LocalizationFileAccess.listResources`, a bounded span). Configured targets keep their
configured `outputPaths.resources`.

- A Dashboard target of the same name (Hex's case) gets the discovered resources for its own
  cultures.
- A name the Dashboard lacks becomes a `source: "resource_files"` target: discovered cultures, no
  native culture, no configs, only `outputPaths.resources`.
- Both are marked `resourcesDiscovered: true`. The target preview carries `discovered: true`, and
  the Workbench shows a muted "discovered" tag beside the target name. `loc targets` prints the
  field.

### Import (`packages/game-text/src/localization-import.ts`)

A culture whose archive has no path, or whose archive file is not on disk, imports its resource
as `locres` (`resourcesInUse`, a bounded span). A culture with an archive never imports its
resource, so recompiles cost nothing there. The file budget is `cultures * 3 + 1`. The TypeScript
reference builder refuses `locres` with `unsupported_version`: compiled resources are bulk binary
data that only the native import reads (ADR 0012). `malformed_locres` is a `LocalizationErrorCode`.

### Join (`join.rs`, `join_columns.rs`, `join_incremental.rs`)

- `resource_inputs` picks, per culture, `outputPaths.resources[culture]` when the archive has no
  path or the join's `fileErrors` say `file_missing`. Those resources are join inputs and
  dependencies (`input_paths`). The join metadata records them as `resources` (per culture, a path
  or null).
- `c{ci}.locres` holds the resource row + 1. `FileColumns` loads `entry.source-hash` and the
  layer's `sourceHashVerified`. The resources load under the `join.resources` mark.
- `JOINED_KEY_PREFIX` is v9. A join with any resource culture takes the full path
  (`fallback("resource-culture")`): the delta path does not recompute hashes yet.

### Culture state, as built

For a culture reading its resource, `S` is the line's manifest source, or its saved source
without a manifest; `D` and `H` are the entry's display string and stored hash:

| Evidence                                                    | Fact             |
| ----------------------------------------------------------- | ---------------- |
| entry present, verified version, `H != hash(S)`             | `needs_update`   |
| entry present, native culture                               | `translated`     |
| entry present, `D == S` or `D` is the native culture's text | `not_translated` |
| entry present, otherwise                                    | `translated`     |
| entry absent, manifest loaded                               | `not_translated` |
| entry absent, no manifest                                   | `unknown`        |

- "The native culture's text" is the native archive's differing translation, or, when the native
  culture also reads a resource, its entry.
- A present entry also clears `missing_manifest` from the culture's operative reasons. The reason
  stays on the line, so the gather states stay undecided and the reason is still shown.
- `missing_archive` was already inoperative for a missing archive.
- `reducedSourceChecking` is true for the culture.
- A version 0-2 resource (`sourceHashVerified: false`) never gives `needs_update`: its text alone
  decides. Unlike the earlier draft, no new unknown reason was added: a reason would have made the
  state `unknown` and hidden the text decision.

### Reading it

- `shipped_translation` (`engine_query.rs`) falls back to the resource when there is no archive
  entry and the line is not pending a PO import.
- Translation search (`culture_translations`, `join_query::translation_ids`) searches resource
  text.
- Line evidence (`engine_evidence.rs`) adds `locres: { text, sourceHash } | null` to the cultures
  that read a resource, and only to those, so other targets' lines are unchanged.
  `LocalizationCultureState.locres` is optional.
- The line detail (`engine_detail.rs`) shows the resource text as the game text.
- Rule subjects (`rules/subjects.rs`, `subjects_columns.rs`) give `latest` from the resource and
  `latestOrigin: "locres"`.
- Generation comparisons (`engine_changes.rs`) compare resource entries as a third stage.
- Every reader reads `c{ci}.locres` only when the join metadata names a resource for the culture;
  joined layers written by the TypeScript reference builder have no such column.
- `LocalizationShippedTranslation.origin` gains `"locres"`.
- `joined-target-reader.ts` checks `c{ci}.locres` against the resource layer's rows.
- The TypeScript reference join (`localization.ts`) mirrors the rule, given decoded resources
  (`options.resources`), with `localizationResourceSourceHash`.

### Tests

- Rust, `join_resource_tests.rs`:
    - the four `Game` fixture resources with the archives removed match Unreal's compile rule over
      the removed archives, and every `locres.sourceHash` equals the manifest source's hash;
    - the `de` fixture resource with the manifest removed, against saved places: translated, not
      translated, a changed saved source (`needs_update`), a key the resource lacks (`unknown`), and
      the rule subjects' `latest`/`latestOrigin`;
    - synthetic resources: native text, an unverified version 2, and a culture with an archive whose
      resource is never read.
- TypeScript, `localization-resource.test.ts`: the reference rule and hash.
- `locres-fallback.integration.test.ts`: the host path end to end with the native reader. A
  resource-only `id` culture with no manifest gets `translated`, `needs_update`, `not_translated`
  and `unknown` against saved text, and `origin: "locres"`.
- `resource-discovery.integration.test.ts`: a temp project shaped like Hex (Dashboard target, no
  configs, a convention `.locres`), a resource-only target, files off the convention, and a
  project with configs that discovers nothing.

## Not built (later)

- Fork 1B: the resource as a third stage beside an archive (`not_compiled` when they disagree).
- An incremental path for resource cultures (today: full join).
- Compare points (`point_localization.rs`) and text-file compare (refuses `locres`).
- Per-platform resources, and file-status rows (`localization-status.ts`) for resources.
