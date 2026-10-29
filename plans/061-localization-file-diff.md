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
6. **Changes come by consequence** (design review, round 1). Each change has a group, listed in
   this order: moved to a new key, source changed (a translation made for the old source is out of
   date), removed, added, translation changed, and notes and references only. Within a group,
   changes keep the newer file's order. File order alone put a real week's first page in key-hash
   order: trivia first, the 435 new keys on pages 3 to 11.
7. **The engine filters.** A page lists one or more groups and a text filter over every change, so
   a chip's count and the list it opens always agree. Counts are always of every change.
8. **Unreal's repeated notes are dropped.** A PO note `Key: X` equal to the entry's key, and
   `SourceLocation: Y` equal to a reference, say nothing new; without them an asset move shows
   once, as a reference, and lands in "notes and references only".
9. **The latest comparisons are kept.** "Load more" and a new filter ask again; the engine keeps
   its eight latest comparisons, keyed by format, options, names, paths, sizes and modification
   times, so neither parses the files again.
10. **Spans and stage times.** `text_files.compare` with `read`, `parse`, `diff` and `filter`
    stage times in the reply, like `compare_points`.
11. **The view moves into `@ue-shed/ui`.** `TextDiff` and its model move from Electroswag into
    `packages/ui`, so Workbench, Electroswag and the Game Text extension share one component. It
    gains sections by group, a host-run filter, labelled fields, a translation shown as context
    under a changed source or new key, folded details on added and removed entries, and marks
    that show a changed apostrophe or a dropped space.

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

- Game Text's **Compare files** tab: Before and After slots, a swap, and Compare. It needs no
  scan, project or target. Files are chosen through the host (`chooseLocalizationFile`), and a
  comparison may name only chosen files.
- Two rounds of UI review by subagents (owner, 2026-10-30): a design critique from screenshots
  of the running app, and a code review.

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
