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

- **State**: TODO. The design is a mockup with sample data; each phase earns its part against the
  fixture and a generated large corpus.
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
Display control, a culture strip with culture sets, facets in the right pane, and a page per line.

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
4. **Culture sets** are stored with the Workbench project preferences (per user) in this plan. A
   shared project file is a later decision.
5. **Filters are a list of clauses**, each `{ field, op: "is" | "is_not", values }`, decoded at the
   boundary and applied as an AND of ORs. Existing `lens`, `capability`, `withoutNotes`, `where` and
   `localization.state/review/keyChanged` map to clauses; old requests and saved presets still decode.
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

## Phase 2: Groups and facets (core and CLI)

1. `group: "problem" | "folder" | "asset" | "origin" | "namespace" | "none"` and `openGroups` with
   per-group cursors on the request; `groups: [{ key, label, count, worst }]` on the page.
2. Facets on the page, each excluding its own field: folder children under the current prefix with
   line and problem counts sorted by problems, assets, origins, problems (when not grouped by
   problem), and per-culture counts for the culture picker.
3. CLI: `--group <by>` on `text search` and `loc status` prints groups with counts.

**Gate**: group counts sum to the total; each facet count equals the total after adding its clause;
the folder facet on the generated corpus stays bounded (top 200 children, then a count).

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
7. Saved presets become saved views (name, filter, display, culture set); 0.10 presets migrate.

**Gate**: component tests for pills, groups, the strip (merged and mixed, set narrowing) and the
picker; preset migration tests; recording and screenshots on the fixture and the generated corpus;
StyleX and visual-regression checks for the strip and group header.

## Phase 4: The line page (Workbench)

1. A full page for one line: the problem and the action that resolves it, every culture's
   translation (editable through the existing staged edits), where it appears, properties, and up
   and down through the list.
2. History from the baselines the project already keeps: gathered, source changed, key changed,
   translated, with the baseline or export each fact came from. Without a baseline the section
   says so.

**Gate**: component tests for each problem's call to action; history from two fixture baselines;
recording through open, carry, next line and back.

## Phase 5: Bulk actions

1. Select lines (click, shift-click, `X`) across groups.
2. Export the selection for translators (the all-languages CSV limited to the selection and culture
   set), mark reviewed through the existing review file, carry translations for selected key
   changes, copy keys.

**Gate**: selection survives paging and regrouping; each action's result matches its single-line
form.

## Documentation

- `docs/products/game-text.md` rewritten around problems, Filter, Display, culture sets, the line page
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
