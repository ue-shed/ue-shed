# Plan 052: Text identity and scope tools for Game Text

> **Executor instructions**: Follow this plan in order. Before editing, read `AGENTS.md`,
> `docs/README.md`, `docs/products/game-text.md` (the localization workspace sections), ADR 0009,
> archived Plan 051 and `docs/engineering/testing.md`. Verify every Unreal fact against each
> engine's `Engine/Source` before relying on it. Run targeted checks while iterating, and
> `pnpm check` before handoff.
>
> **Drift check (run before each phase)**:
> `git diff origin/main...HEAD -- packages/game-text packages/localization extensions/game-text apps/cli apps/workbench packages/map-history`.

## Status

- **State**: IN PROGRESS. Phases 1–2 are done; Phase 3 is next.
- **Priority**: P1
- **Effort**: L
- **Risk**: MEDIUM. Phase 4 carries translations to new keys through the existing PO writer and
  relaxes one change-set staleness rule; a wrong pairing would put a translation on the wrong line.
- **Depends on**: archived Plan 051 (localization workspace), `@ue-shed/map-history` Perforce
  workspace selection.
- **Category**: product
- **Planned at**: `feat/localization-identity-tools`, 2026-10-08

## Context

A writing and localization team named six deliverables in a user interview: identity validation,
diff and history review, a changelist scanner, a faster Unreal-to-writing round trip, a better
reading and authoring tool, and asset deduplication. Plan 051 already covers part of them:
"same key, different text" and "same text, different keys" detection, baseline comparison, work
before a gather, one joined view of every culture with PO editing and review, and running Unreal's
steps from UE Shed.

This plan adds the four items with the best effort-to-impact ratio:

1. **Where text comes from**: filter by source kind and path.
2. **Changed files**: show which text a list of changed files touches, with an optional Perforce
   bridge that produces the list.
3. **Key changes**: detect identity drift and carry the old key's translations over.
4. **All-languages spreadsheet**: one CSV with a row per key and a column per culture.

## Owner decisions (2026-10-08)

- The core API takes a plain list of files. Version control is a separate, optional bridge;
  Perforce is the first one, in a new `@ue-shed/perforce` package that also owns the workspace
  selection Map History uses today.
- UE Shed stays studio-agnostic: no Perforce, cloud storage or spreadsheet vendor in the core.
  Source control access is read-only; UE Shed never checks out or submits (ADR 0009).
- Out of scope here, each needing its own plan: fixing keys inside assets (keep, regenerate or
  merge), searchable export history, asset deduplication and submit-time validation, and a
  side-by-side editing grid.

## Phase 1 — Where text comes from

1. Add `TextWhere` to `TextCorpusSearchRequest`:
   `{ kinds?: TextOriginKind[]; pathPrefix?: string; files?: string[] }`, bounded (512 characters,
   5,000 files).
2. Derive each line's kinds in a pure `text-origin.ts`: `string_table`, `data_table` and `asset`
   from occurrence locations; `cpp` for `.cpp`, `.h` and `.inl` manifest paths (moving the
   renderer's regex here); `other_source` for other gathered sources; `asset` for `/Game` manifest
   paths without a corpus unit.
3. `pathPrefix` matches an occurrence `objectPath`, an occurrence `packageFile` or a manifest path,
   case-insensitively with normalized slashes.
4. Apply `where` to units in `query.ts` and to evidence-only lines in `localizedMatching`. Kind
   counts exclude their own facet, as the other toggle counts do.
5. CLI: `--kind` (repeatable) and `--path` on `loc status` and `text search`.
6. Workbench: kind chips (String table, Data table, Asset, C++, Other source), hidden at zero, and a
   compact "Path…" chip; both persisted.

**Gate**: every kind and path count equals its query's search total; component tests cover the
chips.

**Evidence (2026-10-08)**: Phase 1 is done.

- `@ue-shed/game-text` adds `TextOriginKind`, `TextWhere` (`where` on the search request),
  `counts.origins`, and pure helpers in `text-origin.ts`. The renderer's C++ label now uses the
  same `manifestPathOrigin`.
- `where` applies to units and to gathered-only lines, through search, localized search, counts,
  exports and saved presets. Origin counts exclude the origin facet; path is a hard filter.
- CLI: `--kind` (repeatable) and `--path` on `loc status` and `text search`, with or without a
  target.
- Workbench: origin chips and a compact "Path…" filter in the first toolbar row, persisted per
  project.
- Verified: origin tests (each origin count equals its filtered total, for saved units and for
  gathered C++ and config lines), the CLI integration test against the real fixture, route
  component tests, precommit, and the Node 24 and Node 26 sweeps.

## Phase 2 — Changed files

1. A pure `normalizeTextFileScope(paths)`: trim, unquote, `\` to `/`, `.uexp` and `.ubulk` to
   `.uasset`, case-insensitive matching, dedupe, at most 5,000 entries. Absolute paths become
   project-relative at the CLI and Workbench boundary.
2. A line matches when any occurrence `packageFile`, or any manifest path's file
   (`Source/X.cpp(10)` to `Source/X.cpp`, `X.ini:2` to `X.ini`, `/Game/...` through
   `manifestPackageFile`), is in the list.
3. The page reports `fileScope: { files, textFiles, lines, notScanned }`. Plugin content is not
   scanned and counts as `notScanned`.
4. CLI: `--files <list-file>` (one path per line) on `loc status` and `text search`.
5. Workbench: a "Changed files" chip with a paste box; the active scope reads
   "Changed files 12 ×" and lasts for the session.

**Gate**: a changed-file list over the fixture reports the right lines and states, including C++
and config sources and a not-scanned file.

**Evidence (2026-10-08)**: Phase 2 is done.

- `TextWhere.files` (at most 5,000) and `fileScope` on the search page. Files compare by a key:
  saved packages by extensionless stem, so `.uasset`, `.umap`, `.uexp` and `/Game` package paths
  name the same asset; gathered sources by file, without the `(line)` or `:line` suffix.
- `projectRelativeTextFiles` turns absolute paths under the project into relative ones; absolute
  paths elsewhere count as outside. Saved packages missing from package coverage count as not
  scanned.
- CLI `--files <list-file>` reads a bounded UTF-8 list. Workbench main converts pasted absolute
  paths with the project root; the "Changed files…" popover takes a pasted list for the session.
- Verified: file-key, conversion and scope tests for saved units and gathered C++ lines; the CLI
  integration test with a real list file over the fixture (absolute content path, C++ source and
  an outside path); route component tests; precommit; Node 24 and Node 26 sweeps.

## Phase 3 — Perforce bridge

1. New optional `@ue-shed/perforce`: move `selectPerforceWorkspace`, `optionsForProject` and the
   project-path helpers out of `@ue-shed/map-history`, which imports them back unchanged.
2. A `PerforceFileLists` service: `pendingChangelists(projectRoot)` and
   `changelistFiles(projectRoot, change | "default")` through p4client-ts, returning
   project-relative paths; files outside the project are counted, not listed. Submitted
   changelists use describe plus a depot-to-local mapping; verify the p4client-ts API first.
3. Typed failures: `perforce_unavailable`, `no_workspace_for_project`, `changelist_not_found`,
   `too_many_files`. Telemetry carries counts only.
4. CLI: `ue-shed p4 files <project-root> [--change <n>|default]` and
   `loc status --changelist <n>`, loading the package lazily.
5. Workbench: "From Perforce…" in the changed-files popover lists the user's pending changelists.
   No Perforce command runs until the popover opens.
6. ADR 0009 addendum: optional adapters may read file lists from source control.

**Gate**: Map History tests still pass; the bridge's unit tests use a test layer; a live check
against a local workspace is optional and reported either way.

## Phase 4 — Key changes

1. Pure pairing in `localization-key-changes.ts`, strictly 1:1, ambiguous candidates unpaired and
   counted, in order: same place (manifest path equals the new occurrence's location path), same
   text in the same package, same text unique in the project.
    - **Before a gather** (asset text): old keys are manifest-only `not_found` lines, new keys are
      `not_gathered` corpus lines.
    - **Across a gather that UE Shed runs** (any text, including C++ and config): compare the
      evidence read before and after `gather` or `prepare`. Old translations come from the archives
      as they were before Unreal trimmed them (`TrimArchive`).
2. Verify the manifest path format for data table cells and asset properties against the fixture
   manifests on 5.7, 5.8 and 4.27 and against GatherTextFromAssets in each engine.
3. Surfaces: a "Key changed" lens with a count, "Was `Namespace,Key`" in detail with the old
   translations, and `loc status --key-changed`.
4. "Carry translations" stages one edit per non-native culture through the existing staged edits.
   Pairs whose source text differs are not staged in bulk; detail offers "Carry anyway".
5. Rule change in `change-set-review.ts`: an absent previous translation (`null`) matches an empty
   one (`""`), since both mean nothing ships. Unreal gives new keys an empty archive translation
   after a gather. Note it in ADR 0009.
6. A `prepare` operation runs gather then export in one GatherText process (`-Config=A;B`, as
   `sync` does), shown as "Gather and export".
7. CLI: `loc run gather|prepare --carry <new-changes.json>` writes the carry change set exclusively.
8. Baselines gain an optional `path` per entry (still version 1); `diffLocalizationBaselines`
   pairs removed and added entries into `keyChanged`; Reports shows
   "N new · N removed · N key changed · N source changed".
9. A gather run outside UE Shed is detected only through baseline pairing, without recovering
   translations. The docs say so.

**Gate**: on UE 5.7 and UE 5.8 (`pnpm test:localization-processes`), renaming a `LOCTEXT` key in
the lane's temporary project copy, then `loc run prepare --carry` and `loc apply --sync`, ships the
old translation under the new key.

## Phase 5 — All-languages spreadsheet

1. A pure `localizationLinesCsv(join, lineIds)` reusing `spreadsheetCsv`: Namespace, Key, Source,
   Where, Kind, then for the native culture first and the target's culture order a translation
   column (what ships next) and a state column. Missing translations are empty cells; rows sort by
   code-unit order.
2. It exports what the list shows, including where, file and state filters.
3. Workbench: "Export all languages (CSV)" in the export menu when a target is selected.
4. CLI: `ue-shed loc export <root> --target <t> --output <new.csv>`, created exclusively.
5. The CSV is for reading and sharing; edits still go through PO change sets.

**Gate**: CSV tests cover column order, missing cells, sort and the formula guard.

## Verification matrix

| Scope       | Evidence                                                                                   |
| ----------- | ------------------------------------------------------------------------------------------ |
| Filters     | kind, path and file counts equal their search totals                                       |
| Files       | C++, config, `/Game`, `.uexp` and not-scanned paths matched or reported correctly          |
| Perforce    | test-layer coverage; Map History unchanged; live check optional and reported               |
| Key changes | every pairing tier, ambiguity, differing source; carry round trip on UE 5.7 and UE 5.8     |
| Export      | CSV shape, sort and formula guard                                                          |
| UI          | component tests, recording screenshots for changed files and a key change                  |
| Repository  | `pnpm check`; Node 24 and Node 26 sweeps; release package conformance with the new package |

## STOP conditions

Stop and report rather than weakening the contract if:

- pairing would need fuzzy text matching or anything other than a strict 1:1 match;
- carrying a translation would write anything other than PO `msgstr` values;
- the Perforce bridge would need to check out, edit or submit;
- a filter count cannot equal its query's search total.
