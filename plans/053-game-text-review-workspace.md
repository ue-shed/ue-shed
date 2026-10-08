# Plan 053: Game Text review workspace

> **Executor instructions**: Follow this plan in order. Before editing, read `AGENTS.md`,
> `docs/README.md`, `docs/products/game-text.md`, the design direction in
> [`docs/ideas/game-text-review-workspace.md`](../docs/ideas/game-text-review-workspace.md) with its
> mockup, Plan 052 and `docs/engineering/testing.md`. Run targeted checks while iterating and
> `pnpm check` before handoff.
>
> **Drift check (run before each phase)**:
> `git diff origin/main...HEAD -- packages/game-text extensions/game-text apps/cli apps/workbench packages/ui`.

## Status

- **State**: IN PROGRESS. Phases 1–5 are done (Phase 3 without the keyboard and saved views, which
  the owner skipped as polish the showcase does not need; Phase 4 without history; Phase 5 without
  the `X` key); the documentation and website pass is next. The
  design is a mockup with sample data; each phase earns its part against the fixture and a
  generated large corpus.
- **Priority**: P1
- **Effort**: XL
- **Risk**: MEDIUM. The Workbench's Game Text surface changes shape; saved views and presets from
  0.10 must keep working, and query cost must stay bounded on projects with tens of thousands of
  lines and a dozen or more cultures.
- **Depends on**: Plan 052 (where filters, key changes, all-languages CSV).
- **Category**: product
- **Planned at**: `feat/localization-identity-tools`, 2026-10-08

## Context

Game Text added a chip for every check and state. Together they wrap into rows, treat a lost
translation and a long line alike, and do not scale to a shipping game. The review workspace design
replaces them with a list grouped by worst problem, colour reserved for severity, one Filter and one
Display control, a culture strip with a multi-select culture picker, facets in the right pane,
and a page per line.

The core stays usable without the Workbench: problem classification, grouping, facets and culture
scope are pure functions in `@ue-shed/game-text`, exposed through the existing query and the CLI.

## Decisions

1. **Problem order** is one ordered literal set, worst first: `key_changed`,
   `conflicting_source` (same key, different text), `not_gathered`, `changed_since_gather`,
   `translation` (missing, to update or not synced in a culture in scope), `finding` (same text
   with different keys, long, reused, not localizable), `up_to_date`. A line's group is its worst
   problem; every problem it has stays visible on the line and in its page.
2. **Facts are not problems.** Gathered only, outside the target and origin are filters and
   properties, never groups or colours.
3. **Culture scope** is a request field, `cultures`, defaulting to every target culture. Problem
   classification, counts, findings with a culture (long text) and the strip use only the cultures
   in scope.
4. **Culture picker**: any number of cultures, remembered per project and user. Named culture
   sets were dropped by owner decision on 2026-10-08: Unreal has no culture groups, and a
   remembered multi-select covers the same work.
5. **Filters are a list of clauses**, each `{ field, op: "is" | "is_not", values }`, decoded at the
   boundary and applied as an AND of ORs. They are an added request field, ANDed with the existing
   `lens`, `capability`, `withoutNotes`, `where` and `localization.state/review/keyChanged`, which
   keep their own code path, so old requests and saved presets behave exactly as before. The
   Workbench sends clauses from Phase 3, when 0.10 presets migrate to them.
6. **Grouping pages per group.** The page returns every group's key, label, count and worst problem,
   and lines only for open groups, each with its own cursor. A collapsed group costs a count.
7. **The line page** replaces the detail pane for a picked line. With nothing picked, the right pane
   shows facets.

## Phase 1: Problems, clauses and culture scope (core and CLI)

1. `packages/game-text/src/text-problems.ts`: `TextProblem` literals in worst-first order,
   `lineProblems(line, scope)` returning every problem on a line, and `worstProblem`. Pure, using
   existing localization states, key-change evidence and review signals.
2. `TextFilterClause` and `TextFilter` schemas; `normalizeTextFilter(request)` maps the legacy fields
   to clauses so the query has one path. Fields: problem, translation state, finding, review,
   origin, folder, asset, source file, changed files, editing, translator notes, namespace,
   culture.
3. Request `cultures` (bounded by `MAX_LOCALIZATION_CULTURES`); the query and counts honour it.
4. CLI: `--problem`, `--not-<field>` or `--exclude <field>=<value>`, `--cultures de,fr` on
   `text search`, `loc status` and `loc export`.

**Gate**: every problem's count equals its filtered total; legacy requests and saved preset JSON
decode to the same results as before; a generated 50,000-line, 14-culture corpus answers a
filtered count inside the existing query budget.

**Evidence (2026-10-08)**: Phase 1 is done.

- `text-problems.ts`: `textProblems` returns every problem worst first (`up_to_date` alone when
  none), so the worst is the first; `TextFacts`, `matchesTextFilter` (with one field left out for
  facets) and `textProblemCounts`. Facts are gathered only, outside the target and origin; they
  never count as problems.
- `TextFilterClause` covers problem, finding, translation, origin, folder, editing and notes. Asset,
  source file, namespace and culture clauses come with their facets in Phase 2; changed files stay
  on `where.files` and review on the selection's `review`. A translation clause without a target
  fails with `invalid_selection`.
- `LocalizationSelection.cultures` scopes states, per-culture counts and translation work, and must
  name target cultures.
- CLI: one repeatable `--filter "<field> is|is-not <values>"`, mirroring a pill, and
  `--cultures de,fr`, on `loc status`, `loc export` and localization-aware `text search`; malformed
  clauses fail with the expected form. This replaces the planned `--problem` and `--exclude` flags.
- Scale: no query budget existed, so `query-scale.test.ts` generates 50,000 lines in 200 folders and
  14 cultures and measures. It found that joining the target took about 30 seconds, from a schema
  guard rebuilt on every text comparison; the join now takes about 1.5 seconds. Per-culture counts
  now take one pass. An unfiltered page takes about 0.3 seconds (0.24 seconds without problem
  counts; 0.9 seconds before these fixes) and a problem-filtered page about 0.4 seconds. The test
  keeps loose bounds that catch quadratic work without failing on slow machines.
- Verified: problem and clause tests (each problem's count equals its filtered total; culture scope;
  refusal without a target); the CLI parser tests; the real-reader CLI test on the fixture, where
  each `--filter "problem is …"` total equals its count; the existing 142 Game Text tests unchanged;
  precommit.

## Phase 2: Groups and facets (core and CLI)

1. `group: "problem" | "folder" | "asset" | "origin" | "namespace" | "none"` and `openGroups` with
   per-group cursors on the request; `groups: [{ key, label, count, worst }]` on the page.
2. Facets on the page, each excluding its own field: folder children under the current prefix with
   line and problem counts sorted by problems, assets, origins, problems (when not grouped by
   problem), and per-culture counts for the culture picker.
3. CLI: `--group <by>` on `text search` and `loc status` prints groups with counts.

**Gate**: group counts sum to the total; each facet count equals the total after adding its clause;
the folder facet on the generated corpus stays bounded (top 200 children, then a count).

**Evidence (2026-10-08)**: Phase 2 is done.

- `text-groups.ts`: `textGroupOf`, `textGroups`, `textFolderFacet` (one level under a folder),
  `textAssetFacet`, `textOriginFacet` and `textCultureFacet`. Groups and facet entries carry a
  count, the lines that need work (problems worse than a finding) and the worst problem, sorted
  worst first, then by lines needing work, lines and label; at most 200 with a `more` count.
- The request takes `group`, `openGroup` (one group's lines; counts and groups stay the whole
  request's) and `facets`. Each facet leaves out its own clauses; the culture facet leaves out the
  culture set. Facts now carry files spelled as the project spells them (`textFileLabel`) and the
  namespace, and clauses add `asset` and `namespace`.
- CLI: `--group <by>` on `loc status` and `text search`.
- Scale: at 50,000 lines, 1,000 tables, 200 folders and 14 cultures, grouping by asset lists 200
  groups and counts 800 more, the folder facet lists 200 folders, and a grouped page with all four
  facets takes about 0.75 seconds against about 0.4 seconds for a plain page.
- Verified: group and facet tests (groups sum to the total; an open group lists exactly its
  count; each folder and asset facet entry equals its clause's total, and the facet ignores its
  own clause; the culture picker ignores the culture set; grouping without a target); the scale
  test; the real-reader CLI test, where folder groups sum to the total and the first group holds
  the target's worst problem.

## Phase 3: The list, Filter, Display and the culture picker (Workbench)

1. Replace the chip rows with Search, Filter and Display. Filter is a type-ahead menu that finds
   folders, assets and source files first and offers the other fields one level down; choices
   become removable pills (`is`, `is any of`, `is not`).
2. Grouped list with collapsible groups, "Show N more", worst-first order and quiet up-to-date
   lines. Severity colours only: red for key problems, amber for waiting and translation work,
   blue for not synced.
3. Culture strip component in `@ue-shed/ui`: one cell per culture in scope, fixed order, merged
   when all cultures share a state, summary text naming one or two cultures; accessible names list
   every culture's state.
4. Culture picker with saved sets and every culture worst first.
5. Right pane facets when nothing is picked; clicking a facet adds its pill.
6. Keyboard: `/` search, `F` filter, `J`/`K` and arrows to move, `Enter` to open, `X` to select.
7. Saved presets become saved views (name, filter, display, picked cultures); 0.10 presets
   migrate.

**Gate**: component tests for pills, groups, the strip (merged and mixed, set narrowing) and the
picker; preset migration tests; recording and screenshots on the fixture and the generated corpus;
StyleX and visual-regression checks for the strip and group header.

**Evidence (2026-10-08)**: first slice done (items 1, 2, 3, 5, and preset migration from 7).

- The chip rows are gone. **Filter** lists fields (Problem, Translation, Finding | Folder, Asset,
  Origin | Editing, Translator notes | Review, Line state), each opening a submenu of values with
  counts and its own filter box, as the owner asked after the first screenshots; typing at the
  first level finds values across fields. Values toggle pills; a pill's operator flips between
  "is" and "is not". Review and line facts still filter through the selection and show as chips
  beside the pills. Once a field has a pill its other values show without counts, because page
  counts follow every pill; a later change can count each field without its own clauses.
- **Display** groups by problem (default), folder, asset, origin or namespace, or none. Groups list
  worst first; all start open when every line fits on one page, otherwise the worst one does, and
  each fetches its own pages (`openGroup`), so a collapsed group costs only a count.
- Rows end with a status: red "Key changed", a line-level gather state once, or the culture summary
  and the culture strip (fixed order, merged when every culture shares a state, hidden when all
  shipped; the accessible name lists every culture). Findings lost their warning colour.
- The empty side pane shows Problems (unless grouped by them) and Folders / Assets / Origins.
- `migratePreferences` turns 0.10 toggles, lenses, origin and path filters, key-changed and
  translation-state chips into pills; presets add optional `filter` and `group`.
- Verified: 74 Game Text component tests (22 rewritten for the Filter submenus and pills), unit
  tests for pills, migration and the strip text, the Game Text recording on the fixture project,
  screenshots, precommit, Node 26 sweep and Node 24 components.
- Multi-select culture picker (4): any number of cultures, each with its missing, to-update and
  not-synced counts from the culture facet, remembered per project (`localizationCultures`, with the
  single `localizationCulture` still read). One culture shows its translations inline; several
  narrow the request's `cultures`, the strip and its summary, and translation search covers every
  picked culture. The keyboard works as in the other pickers; Enter keeps the choices open.
- Skipped by owner decision on 2026-10-08, as polish the showcase does not need: the keyboard (6)
  and saved views (7). Presets already save pills, grouping and the search.

## Phase 4: The line page (Workbench)

1. A full page for one line: the problem and the action that resolves it, every culture's
   translation (editable through the existing staged edits), where it appears, properties, and up
   and down through the list.
2. History from the baselines the project already keeps: gathered, source changed, key changed,
   translated, with the baseline or export each fact came from. Without a baseline the section
   says so. Deferred: a project keeps a baseline only when someone saves one by hand, so history
   needs a baseline store first; it is a follow-up plan, not this phase.

**Gate**: component tests for each problem's call to action; recording through open, carry, next
line and back.

**Evidence (2026-10-08)**: Phase 4 is done without history (item 2, deferred above).

- Opening a line replaces the list with its page; the list stays mounted (hidden), so "‹ Lines"
  returns to the same groups and loaded pages. The header shows the line's place across the whole
  list ("2 of 58": lines in the groups above plus its place in its group) and steps to the next or
  previous line, loading a group's next page or opening the neighbouring group when needed.
- The page states the worst problem in a sentence with what resolves it (key changed, same key
  with different text, not gathered, changed since gather, translation work), in its severity
  colour, above the existing detail: text and key, where it appears, translations with editing,
  review and carrying, and read problems. A properties column lists problems, namespace and key,
  origin, asset and folder, editing, translator notes, length and findings.
- Verified: component tests for the page (position, properties, stepping, back), crossing into a
  group's next page, and the key-change callout; the Game Text recording, which now checks the
  page layout and returns to the list before picking other rows; screenshots on the fixture
  project, including stepping from the key-changed line into the closed "Not gathered yet" group.

## Phase 5: Bulk actions

1. Select lines (click, shift-click, `X`) across groups.
2. Export the selection for translators (the all-languages CSV limited to the selection and culture
   set), mark reviewed through the existing review file, carry translations for selected key
   changes, copy keys.

**Gate**: selection survives paging and regrouping; each action's result matches its single-line
form.

**Evidence (2026-10-08)**: Phase 5 is done without the `X` key (keyboard work was skipped in
Phase 3).

- Core: search requests accept `lines`, up to 5,000 localization line ids, and keep only those
  lines; `localizationLinesCsv` takes picked cultures and keeps the native culture plus those, and
  `pickedLocalizationCultures` reads them from a selection. The Workbench export and
  `ue-shed loc export` both limit columns to the picked cultures.
- Workbench: rows have a tick box beside the row button while a target is selected; shift-click
  ticks or unticks the range from the last line ticked, in the order of the loaded rows across
  groups. The selection is kept by line id with each line as listed, so it survives paging,
  filtering and regrouping, and clears when the target changes.
- The bar under the list shows the count and the actions that apply: Export for translators (the
  ticked lines' ids with the target and picked cultures, not the list's filters), Mark reviewed
  (the same "set reviewed" change the line page writes, batched 500 per request and stopping at
  the first failure), Carry translations (the same staged edits as the line page's carry, without
  pairs whose source changed, capped at the 500 edits one write takes), Copy keys, and Clear.
- Verified: pure tests for review changes, batches, carried edits, copied keys and ranges; core
  tests for `lines` and culture-limited columns; component tests for a shift-click range, export,
  marking reviewed, clearing, and carrying a ticked key change; the Game Text recording ticks a
  range and checks the bar; screenshot on the fixture project.

## Documentation

- `docs/products/game-text.md` rewritten around problems, Filter, Display, picked cultures, the line page
  and bulk actions; the idea document marked as graduated.
- Website guides and screenshots for Game Text refreshed (see `docs/engineering/website.md`).
- Changesets for `@ue-shed/game-text`, `@ue-shed/ui` and the CLI.

## Verification

- Pure tests for problems, clauses, scope, groups and facets.
- A generated large corpus fixture (built at test time, not committed) for count and timing checks.
- Workbench main-service and IPC contract samples for the new request and page fields.
- Recording on the fixture project; screenshots at 1440 × 900.
- `pnpm run check:precommit`, Node 24 and Node 26 sweeps, `pnpm check` before handoff, PR CI green.
  The real-Unreal localization lane runs on UE 5.7 and 5.8 if any operation flow changes.

## STOP conditions

- A legacy preset or saved view no longer decodes to the same results.
- Grouped counts on the generated corpus exceed the existing query budget by more than 2×.
- The strip cannot give screen-reader users every culture's state.
