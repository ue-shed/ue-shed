# Plan 061: What changed between two localization files

> **Executor instructions**: Read this plan fully before starting. Also read `AGENTS.md`,
> [ADR 0012](../docs/decisions/0012-native-engine-boundary.md),
> `docs/engineering/native-game-text-index.md` and Plan 060 (its text diff and `compare_points`).
> Run targeted checks while you iterate. Honour the STOP conditions. At the end of every phase,
> record its evidence and measurements here and review the plan with the owner before starting the
> next phase.
>
> **Drift check (run before each phase)**:
> `git diff origin/main...HEAD -- crates/game-text-index/src/localization crates/game-text-index/src/text_file_compare.rs packages/game-text packages/ui extensions/game-text apps/workbench`.

## Status

- **State**: In progress. Phase 1 started 2026-10-30, overnight, before owner review: the owner
  asked for a start on the UE Shed side and will decide in the morning whether it joins 0.24.0.
- **Priority**: P2
- **Effort**: M
- **Risk**: LOW. It reads two files with the parsers the localization import already uses, and
  writes nothing.
- **Depends on**: Plan 060 (the text diff on the review page, paging like `compare_points`).
- **Category**: product
- **Planned at**: `feat/text-file-diff`, 2026-10-30

## Context

A changelist that touches a `.po`, `.archive` or `.manifest` shows "binary file" on a review page,
or a text diff of a file whose order and escaping nobody reads. A `.archive` is UTF-16 JSON
sorted by namespace; a `.po` carries its key in `msgctxt` and its comments in four kinds of line.
What a reviewer wants is the text: which keys came and went, which translations changed, and
which words.

Plan 060 built that view for a changelist's game text: Electroswag's `TextDiff`, which takes
neutral entries (a kind, a key on each side, a file, fields compared under the key) and knows no
source. This plan gives it a second source: two revisions of one localization file.

## Decisions

1. **Native, paged, like `compare_points`.** A project's archives run to hundreds of megabytes.
   The engine reads and parses both files with the localization import's parsers
   (`localization::parse_json`, `localization::parse_po`), pairs and compares them, and returns
   one page of changes with counts. Only the page crosses into TypeScript.
2. **One request, no reader and no configuration**: `compare_text_files`, with the file format
   and PO options (`LocalizationOptions`), each side as a path on disk (absent for a file that was
   added or deleted), and a page. The host fetches revisions (for example with `p4 print`) and
   passes paths.
3. **Entries pair by identity, then occurrence.** Manifest and archive rows pair by
   namespace and key; PO rows by the identity the importer gives them (`msgctxt`, or the msgid for
   Crowdin's keyed format). A key repeated in a file (a manifest key with several contexts) pairs
   by its nth occurrence.
4. **A new key is a kind of its own.** An entry removed under one key and added under another with
   the same source text is a rekey, when that text is the only one of its kind among both the
   removed and the added. Plan 060 found 397 dialogue rows moved to GUID keys in one change; a
   reviewer needs to see that as one move, not 397 removals and 397 additions.
5. **Fields are typed.** Source, a plural source, translation (one per PO plural form), path,
   notes (extracted comments), comments (translator comments), references and flags. The host
   labels them. Metadata and key metadata are not compared in this plan.
6. **Changes keep file order.** Changes come in the order of the newer file, with each removed
   entry placed before the next entry that followed it in the older file. A translator reads a
   `.po` in that order.
7. **The last comparison is kept.** "Load more" asks for the next page; the engine keeps the last
   comparison, keyed by format, options, paths, sizes and modification times, so a second page does
   not parse the files again.
8. **Spans and stage times.** `text_files.compare` with `read`, `parse` and `diff` stage times in
   the reply, like `compare_points`.
9. **The view moves into `@ue-shed/ui`.** `TextDiff` and its model (`text-diff.ts`) move from
   Electroswag into `packages/ui` unchanged in behaviour, so Workbench, Electroswag and the
   Game Text extension share one component.

## Phases

### Phase 1: the engine compares two files

- `crates/game-text-index/src/text_file_compare.rs`: request, pairing, rekeys, fields, order,
  paging and the kept comparison. Tests for each format: an edited translation, an added and a
  removed key, a rekey, a repeated key, a plural form, a deleted file and a page past the end.
- `EngineRequest::CompareTextFiles`, the generated contract, and `compareTextFiles` in
  `@ue-shed/game-text`.
- Measure on the largest archive and PO in the Game Text fixture, and on a large UE 4.27
  project's archive at two revisions: parse, diff and the second page. Record here.

### Phase 2: one text diff for every host

- `TextDiff` and `text-diff.ts` in `packages/ui`, with their tests.
- A mapping from `compare_text_files` changes to `TextDiffEntry`.

### Phase 3: Workbench shows it

- The Game Text extension's localization view compares two files: a file and an older copy,
  picked or dropped. It is the showcase for the component.

### Later, not in this plan

- Electroswag's review page uses it for a changelist's `.po`, `.archive` and `.manifest` files.
- A command line `ue-shed loc diff` for two files, beside Plan 060's points.
- Metadata and key metadata.

## STOP conditions

- The parsers disagree with the importer on any fixture file: fix the parser through the import's
  own tests first.
- A comparison of the largest fixture archive takes more than a second warm: profile before going
  on.

## Evidence

(Recorded at the end of each phase.)
