# Plan: a culture's translations from its `.locres`

Status: proposed, not built. Phase A (the native `.locres` reader and import, format `locres`)
is done; this plan uses it.

## Why

Game Text reads a culture's translations from its archive, with the PO as the newer stage. A
project that keeps no archives, only the compiled resource (Hex has `Game/id/Game.locres`, nothing
else), shows no translations at all: every line is `unknown` (no manifest) or `not_translated`
(manifest but no archive). The `.locres` is what the game shows, so it is real evidence of what
ships.

## What Unreal writes (5.8 `TextLocalizationResourceGenerator.cpp`, 4.27 the same rule)

For each manifest entry and context, the generator asks `GetRuntimeText` for the culture's text
(`ELocTextExportSourceMethod::NativeText`) and calls
`AddEntry(namespace, key, manifestSource.Text, translation.Text)`. So:

- The stored hash is always `HashString(manifest source)`, the manifest's source, never the native
  culture's text. Phase A proved this on every fixture entry (`locres::source_hash`).
- The display string is the archive translation when it was made from the current source and is
  not empty. Otherwise it is the native culture's text for that key, or the source.
- 5.x writes every manifest entry, translated or not. 4.27 leaves untranslated entries out (the
  `de`/`fr` fixtures are empty).
- Entries with a platform context go into per-platform resources (`Platforms/<P>/<culture>/`).
  This plan reads only the platform-agnostic resource.

## Today's behaviour without a manifest or archives

- Discovery needs a GatherText config that names a manifest; the resource path comes from the
  `GenerateTextLocalizationResource` step's `ResourceName` (`targets.ts` `outputPaths.resources`).
  A target with a dashboard entry but no config files has no output paths at all.
- `importLocalizationTarget` reports a missing manifest or archive as a `file_missing` diagnostic
  and imports the rest.
- The join (`join.rs`) gives every line `missing_manifest` when the manifest layer did not load.
  Lines still come from saved packages, but `not_gathered`, `not_found`, `gathered_only` and the
  culture states cannot be decided, so every culture is `unknown`. With a manifest and no archive
  file, an absent archive counts as read, so every line is `not_translated`.

So a target without a manifest already works, but shows only the saved text.

## Where `.locres` enters

1. **Import** (`packages/game-text/src/localization-import.ts`): add
   `[target.outputPaths.resources[culture], "locres"]` per culture. Raise the file budget from
   `cultures * 2 + 1` to `cultures * 3 + 1`. Import every named resource: it is content-keyed and
   cached, so a refresh where nothing changed costs one stat.
2. **Join inputs** (`join.rs` `input_paths`, `join_incremental.rs`): a culture's resource is a join
   input only when that culture **uses** it, meaning its archive has no path or failed with
   `file_missing`. Otherwise a recompile, which changes nothing Game Text shows, would invalidate the
   join. In the first version, a change to a used resource takes the incremental path's full-rebuild
   fallback, like a PO identity change. Bump `JOINED_KEY_PREFIX` (v8 to v9).
3. **Join columns**: `CULTURE_FIELDS` gains `locres` (resource row + 1, 0 when none), next to
   `archive` and `po`. `FileColumns::load` reads `entry.source-hash` for locres layers.
4. **Culture state** (`join.rs` per-culture loop; the TypeScript reference `localization.ts` mirrors
   it so the differential tests keep passing). For a culture using its resource, with the line's
   expected source `S` (the manifest source if loaded, otherwise the line's saved source) and the
   entry's display string `D` and hash `H`:

    | Evidence                                          | Fact                                                            |
    | ------------------------------------------------- | --------------------------------------------------------------- |
    | entry present, `H == hash(S)`, `D` differs from S | `translated`                                                    |
    | entry present, `H == hash(S)`, `D == S`           | `not_translated` (Unreal compiled the source in)                |
    | entry present, `H != hash(S)`                     | `needs_update`: the shown text was compiled for an older source |
    | entry absent, manifest loaded                     | `not_translated` (4.27 omits untranslated entries)              |
    | entry absent, no manifest                         | stays `unknown` (`missing_manifest`)                            |

    `missing_archive` stops counting toward `unknown` for that culture: the resource answers it.
    The culture's `reducedSourceChecking` is true: the check uses the hash, and the source the
    translation was made from cannot be shown. For a foreign culture, the native text for an
    untranslated key may be in the resource too, so `D` equal to the native culture's resource text
    also counts as `not_translated`. When the resource's version is not 3
    (`sourceHashVerified: false`), the hash is not trusted: present entries are `translated` or
    `not_translated` by text alone, and the line gets a new unknown reason, `unverified_resource`.

5. **Origins and hydration**:
    - `LocalizationShippedTranslation.origin` gains `"locres"`
      (`localization-shipped-translation.ts`).
    - `LocalizationCultureState` gains `locres: { text, sourceHash } | null`
      (`localization-schema.ts`).
    - The engine's `shipped_translation` (`engine_query.rs`), line detail and evidence
      (`engine_detail.rs`, `engine_evidence.rs`) and the rule subjects' `latestOrigin` and
      `translation` (`rules/subjects.rs`, `subjects_columns.rs`) read `c{ci}.locres` when the
      culture uses its resource.
    - Snapshot validation (`joined-target-reader.ts`) checks `c{ci}.locres` against the layer's row
      count.
    - The file status kinds (`localization-status.ts`) gain `locres`.
    - The host format literals (`joined-target-input.ts`, `localization-columns.ts`,
      `localization-import.ts`, `index-context.ts`) gain `"locres"`.
6. **Not in scope**: compare points (`point_localization.rs` builds its base from the manifest and
   archives) and text-file compare (refuses `locres` today); the PO and archive stages are
   unchanged.

## The forks

### 1. When the resource counts

- **A. Fallback only** (recommended): a culture uses its resource only when it has no archive. One
  source per culture, no new disagreement states, and the join depends on resources only where
  they matter. This is enough for Hex.
- **B. Always, as a third stage**: PO, then archive, then resource, with a new `not_compiled` fact
  when the archive's runtime text differs from the resource. This is the "compile pending" stage
  `game-text-corpus.md` already marks `notExposedYet`. It is worth doing later, but it changes
  every archive-backed project's states and makes every recompile a join input.

### 2. No manifest

- **A. The resource decides what it can** (recommended): per the table above, a present entry
  with a matching or mismatching hash gives `translated`, `not_translated` or `needs_update`
  against the saved source. An absent entry stays `unknown`. `missing_manifest` stays on the line,
  so the gather states stay undecided and the reason is still shown. Hex gets real per-culture
  states for every line its saved packages have.
- **B. Text only**: keep every state `unknown` and only show the resource text as the shipped
  translation (`origin: "locres"`). Simpler and never wrong, but Hex's lines all stay `unknown`.
  Filters and counts show nothing useful, and stale translations (the hash mismatch, which A
  catches exactly) look current.

Recommendation: 1A and 2A. Build the culture-state rule and its oracle in Rust first (fixtures:
the Phase A resources with their archives removed, plus one with its manifest removed), then
hydration and the TypeScript reference, then the host import.

## Open questions to check on a real project before building

- Does Hex have its `Config/Localization/Game_*.ini`? If not, no resource path is known.
  Unreal's runtime loads every `*.locres` under `<LocalizationPath>/<culture>/`; discovering that
  way would be a separate, explicit change in `targets.ts`.
- Hex's engine version (4.27 leaves untranslated entries out of the resource, which decides how
  often the "entry absent" row applies).
