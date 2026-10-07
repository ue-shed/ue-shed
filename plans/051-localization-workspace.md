# Plan 051: Build the Game Text localization workspace

> **Executor instructions**: Follow this plan in order. Before editing, read `AGENTS.md`,
> `docs/README.md`, `docs/vision-and-architecture.md`, `docs/products/game-text.md` (including
> "Localization workspace (proposed)"), ADR 0009, the "Localization workspace" section of
> `docs/ideas/game-text-workbench.md`, archived Plan 042, and `docs/engineering/testing.md`
> ("Unreal gate reporting"). Verify every Unreal fact against each engine's `Engine/Source` before
> relying on it. The facts recorded below are a starting point and do not replace that check. Never
> copy Epic source text into the repository. Run targeted checks while iterating, and `pnpm check`
> before handoff.
>
> **Drift check (run before each phase)**:
> `git status --short -- docs/products/game-text.md plans/051-localization-workspace.md packages/game-text packages/localization apps/cli extensions/game-text apps/workbench fixtures/unreal-project`
> and
> `git diff origin/main...HEAD -- packages/game-text extensions/game-text fixtures/unreal-project`.
> Rebase when Plan 050 (legacy property tags) or other Game Text work lands.

## Status

- **State**: IN PROGRESS. Phases 0–4 are done; Phase 5 is next.
- **Priority**: P1
- **Effort**: XL
- **Risk**: HIGH. The plan adds the first UE Shed writes to localization files and the first
  UE Shed-owned review data, over confidential text. A wrong join, a lossy PO write or an
  overclaimed state would corrupt translators' work or mislead them.
- **Depends on**: Plan 042 (quality model), Plan 033 (compact corpus), `@ue-shed/engine` discovery
  and owned process trees. Plan 050 is optional, for UE 4.27 to 5.3 live scans.
- **Category**: product
- **Planned at**: isolated `worktree-localization-tooling` worktree, 2026-10-07

## Outcome

A writing and localization team can do the following, from the CLI and from the Workbench:

- see every line with its translation and state for each culture;
- find text that is not translated, needs an update, or was not gathered;
- run Unreal's checks plus the project's own;
- run Unreal's gather, import, export and compile;
- edit translations through a reviewed change set; and
- track review progress.

Unreal's identities, files and pipeline stay authoritative.

## Owner decisions (accepted 2026-10-07)

1. **Editing authority.** Translation edits are change sets (ADR 0009). The PO writer is the
   headless default, and synchronizing through an Unreal import and compile is a separate,
   batchable step. An optional editor writer in a UE Shed plugin comes later. Direct archive writes
   are rejected: the next PO import reverts them. Translations that are not synced must be clearly
   indicated everywhere they appear: per line and culture, as a toolbar total beside "Sync with
   Unreal", as a filter, and in CLI status and reports.
2. **Review state.** One versioned JSON file per target, inside the project, keyed by culture,
   namespace and key. Each record has a fingerprint of the source and translation it was set
   against. The default path is `Config/UEShed/Localization/<Target>.review.json`, and hosts may set
   another path. PO flags and archive metadata do not survive Unreal's round trip. The owner
   accepted this as the starting design; revisit it if real use shows merge or ownership problems.
3. **Engine support window.** UE 4.27 is in for project-file evidence (Level 1 gather output) and
   Unreal processes (Level 2), because their formats match 5.x. An established production project
   uses 4.27, so 4.27 evidence is at least a reference. A 4.27 live asset scan arrives with Plan
   050's legacy property tag reader. Until then a 4.27 project shows gather evidence, with "Not
   gathered yet" and "Changed since gather" marked unavailable.
4. **Machine translation.** A review flag only. There is no translation service integration.
5. **Voice lines.** Out of scope. Dialogue waves and their dialogue scripts can be a later plan.
6. **Package boundary.** A new public `@ue-shed/localization` package owns target settings, the
   file formats, PO writing, change sets, review files and the Unreal process capability, with
   no dependency on the corpus. `@ue-shed/game-text` depends on it. Game Text owns the join with the
   corpus, the per-culture states, the queries and the checks. This keeps the formats usable for CI
   checks and gather-only 4.27 projects without an asset scan.

## Fixed decisions

These follow from current docs and engine evidence. They need no owner decision.

- Join by Unreal namespace and key only. String Table entries join through the table's namespace and
  the entry key. A line with no Unreal identity has no translations.
- UE Shed code never writes a manifest, archive, `.locres` or `.locmeta`. It writes PO files only
  through the change set writer.
- "Needs update" uses Unreal's rule: the archive entry's recorded source differs from the manifest
  source, by exact match.
- "Not gathered yet" requires the line's package to lie inside the target's gather paths and outside
  its exclude paths and classes. "Not found in the project" requires a fully read package. Without
  that coverage the state is "Unknown" with a reason.
- Manifest, archive and PO parsing accept the 4.27, 5.7 and 5.8 layouts: UTF-16LE JSON with a BOM,
  both brace styles, and manifest key `DevNotes` (5.8 only). PO parsing accepts both the Unreal and
  Crowdin formats.
- Built-in checks implement Unreal's own text syntax: the format argument grammar with backtick
  escapes and `plural`/`ordinal`/`gender`/`hpp` modifiers, Slate rich text markup, and PO escape
  round-trip safety. Project-specific budgets and glossaries remain project-authored rules.
- Unreal processes run through `@ue-shed/engine` discovery and `OwnedProcessTree`, without
  `-EnableSCC`. Before running, they report the files they may write.
- Ordinary telemetry carries counts, cultures, durations and codes only, never text, keys or paths.
- All counts shown together come from the same query, so a count never disagrees with the list
  beside it. Units with empty source are excluded from coverage counts the same way search excludes
  them.

## Phase 0 — Design and owner decisions

1. Update `docs/products/game-text.md` with the proposed localization workspace and the revised
   out-of-scope list.
2. Write this plan and register it in `plans/README.md`.
3. Write ADR 0009 (proposed): change sets, writers and the review file.
4. Bring the six recommended decisions to the owner.

**Gate**: the owner confirms or changes each decision. Accept or amend ADR 0009, update this plan's
recommended decisions into fixed decisions, and only then start Phase 3.

**Done 2026-10-07**: the owner accepted all six recommendations and asked that unsynced edits be
clearly indicated. ADR 0009 is accepted.

## Phase 1 — Localization fixture

1. Add a game localization target to `fixtures/unreal-project` with native `en` and two cultures
   (`de`, `fr`), through `+GameTargetsSettings` in `Config/DefaultEditor.ini` and generated
   per-operation configs.
2. Add or reuse fixture content that covers:
    - a String Table, a DataTable and a data asset property;
    - runtime C++ `LOCTEXT`;
    - format arguments, with a deliberate argument mismatch in one translation;
    - a plural form;
    - one untranslated entry and one outdated translation;
    - text added after the last gather; and
    - the same source under two keys.
3. Extend the fixture commandlet so that it does the following:
    - writes translations from a generic `FixtureSource/Localization` input through Unreal's own
      localization APIs;
    - runs `GatherText` to gather, import, export, compile and report;
    - changes one source after the import, to produce an outdated translation, then gathers again;
    - adds one asset after the final gather.

    The manifest, archives, PO, `.locres` and reports are never written by hand.

4. Record expected states, and source and translation evidence from Unreal's APIs, under
   `FixtureExpected/localization/` per engine version.
5. Add a matrix lane that regenerates the target on UE 5.7 and UE 5.8 in disposable copies and
   compares the results with the recorded evidence. The lane accounts for 5.8's manifest `DevNotes`.

6. Add a minimal UE 4.27 localization fixture beside the 5.7 project, generated by the UE 4.27
   `GatherText` from committed inputs (for example config text and a String Table). It needs to
   cover only the gather output formats: manifest, archives, PO and compiled resources. If 4.27
   cannot generate it on this machine without a toolchain the project does not have, record the gap
   and use the engine's shipped 4.27 localization files as format evidence instead.

**Gate**: both engines generate the target from the committed inputs. The recorded evidence covers
every state in the product contract. No generated localization file is edited by hand.

**Evidence (2026-10-07)**:

- `pnpm fixture:generate-localization` (13 fresh processes) and `pnpm fixture:verify-localization`
  passed on UE 5.7.4 in the canonical fixture and on UE 5.8.2 in a disposable copy. Each engine's
  reload evidence equals its committed `evidence.ue<version>.json`. The two differ only by 5.8's
  manifest `DevNotes`.
- `pnpm test:localization-fixture` confirms every authored state in `expected-states.json` from both
  engines' evidence without an engine.
- A second UE 5.7 regeneration reproduced the manifest, archives, `.locres`, `.locmeta` and
  evidence byte for byte. Only package save GUIDs, PO header dates and report timestamps differ.
- UE 4.27.2 generated `fixtures/unreal-427-localization` from config text without a module build.
  Its manifest uses the older brace-on-its-own-line JSON layout. It has no translations.
- `.gitattributes` keeps generated localization files byte-exact (`-text`).
- `pnpm test:uasset-engine-matrix` passed on UE 5.7 and UE 5.8. The new localization lane
  regenerated the target in each engine's disposable copy and matched the committed evidence; the
  existing native, WASM and saved-review parity lanes also passed. The run is from a worktree nested
  inside another checkout, where the excluded WASM crate needs a temporary standalone `[workspace]`
  table; the manifest was restored afterwards.

Follow-up: once Plan 050's `fixtures/legacy-unreal-project` lands, give it a localization target so
4.27 joins real asset text with translations, then retire the config-only 4.27 fixture.

## Phase 2 — Game Text workbench alignment and count fixes

This phase is read-only and independent of the localization decisions. It may run in parallel with
Phase 1.

1. Fix the counts in `@ue-shed/game-text`:
    - empty-source units are excluded from coverage, summary and role coverage counts, as search
      already excludes them;
    - lens and filter counts follow the current search text and filters, through the same query as
      search.
2. Add a "No translator notes" filter. A line counts when it has searchable source and every
   occurrence's trimmed notes are empty.
3. Make CSV export spreadsheet-safe: quote every cell, add a UTF-8 BOM and CRLF line endings, and
   prefix any text cell that starts with `=`, `+`, `-` or `@`. Text CSV has one row per occurrence.
   Quality CSV has one row per finding and occurrence. JSON keeps scan provenance.
4. Add a starter rules document. `ue-shed text rules init <project-root> [--output]` and the
   Workbench "Create rules file" write it without overwriting.
5. Rework `extensions/game-text`:
    - **Toolbar**: one row with the view tabs (`Text | Quality checks (N)`), one coverage line and a
      neutral Rescan. There is no title block, subtitle or metrics strip.
    - **Before the first scan**: one sentence and a Scan project button.
    - **Search**: one field with an icon and the live match count inside it, with an honest
      placeholder.
    - **Filters**: toggle chips and one-of-many chips, all with counts. Hide zero-count chips unless
      selected. Say when nothing needs review.
    - **Export**: actions sit on the same row as the filters.
    - **Rows**: the text, then `asset · row · field`, then "+N more", then review signals only when
      present. No coloured side accents.
    - **Detail**: the text as the title, then the key with a copy button, character, word and
      location counts, and "Where it appears" cards with translator notes or "No translator notes".
    - **Quality**: problem statements in rows, the offending term highlighted, "How to fix", "Show
      key and translator notes", and a rules overview that warns when a role matches nothing.
    - **States**: "Searching…" until the first result, never a false empty state.
    - **Memory**: search, filters and selection are remembered per project and restored without a
      rescan.
6. Use writer language throughout: "lines", "translator notes", "Used in several places", "Same
   text, different keys", "Not localizable" and "Same key, different text".

**Gate**:

- Package tests prove that counts agree with search totals, including empty-text units.
- Component tests cover chips, the search count, starting state and restored state.
- A screenshot of the real Workbench passes self-review: vertical space before content, counts that
  agree, familiar terms and no loading flash.

**Evidence (2026-10-07)**:

- `TextCorpus.coverage` keeps raw provenance counts. Searchable counts in summaries, chips, role
  coverage and the toolbar share the search filtering path and exclude empty-text lines.
- `pnpm run check:precommit`, typecheck and lint pass. 242 component tests pass. Node tests pass
  with the native reader (`UE_SHED_UASSET_EXECUTABLE`) and the staged native supervisor binary.
- `game-text-quality.recording.ts` passes against the built Electron Workbench and the fixture
  project. It asserts that the coverage line, All text chip and match count agree. It also asserts
  in-pane scrolling and compact action sizing, and it saves seven review screenshots.
- Two screenshot review rounds fixed the following:
    - the page scrolled instead of the list;
    - names were humanized instead of exact Unreal names;
    - action buttons were oversized;
    - the "1 locations" pluralization;
    - "Saved" was shown in warning orange.
- A capability audit restored Show in Unreal, copy text, saved-file details, partial-read
  warnings, the Read only filter and location paging, which the rework had dropped.
- `docs/showcase.md`, the site guide and this product contract describe the new flow. The
  published site screenshot (`apps/site/public/media/game-text.png`) still shows the old layout
  until the next `site:media` capture.

## Phase 3 — Read-only localization evidence

1. Create `@ue-shed/localization` (or the boundary the owner chose) with a browser entry. Add
   architecture rules: no corpus dependency, and no Node in the browser entry.
2. Add Effect Schema parsers, with typed and bounded failures, for:
    - localization target settings in `Config/DefaultEditor.ini`;
    - per-operation `Config/Localization/*.ini` gather configs, including destination, manifest,
      archive, PO and resource names, cultures and gather paths;
    - manifests and archives (UTF-16LE JSON, every documented layout);
    - PO files (Unreal and Crowdin formats, comments, flags, escapes, BOM).

    The PO model must reproduce the input bytes exactly on an unmodified round trip.

3. Add a pure join in `@ue-shed/game-text` from `TextCorpus` plus localization evidence to
   per-line, per-culture states, with coverage-qualified "Unknown" states and gathered-only lines.
   Expose the String Table namespace in the corpus if the join needs it.
   Translator notes must also reach 5.7 projects. Today the corpus reads `devNotes` only from
   UE 5.8 keyed text, so a String Table entry's `Comment` metadata shows as "No translator notes",
   even though Unreal exports it to translators as PO `InfoMetaData`. Read String Table entry
   metadata in the parser and inspection layers. Show manifest `InfoMetaData` and 5.8 `DevNotes` for
   gathered-only lines.
4. Extend the bounded query with target and culture selection, state lenses, translation text
   search, and focus that shows every culture. Counts come from the same query.
5. Add CLI parity:
    - `ue-shed loc targets <project-root>`;
    - `ue-shed loc status <project-root> [--target] [--culture] [--state]`;
    - search and focus that include translations;
    - schema-versioned JSON.
6. Add Workbench views:
    - a culture picker;
    - per-culture translation and state on rows;
    - a detail pane that stacks every culture with its translation, state and PO context;
    - gathered-only lines labelled as such.

**Gate**:

- Parser tests decode the committed 5.7 and 5.8 fixture targets and the engine's own 4.27 and 5.7
  shipped samples.
- Unmodified PO files round-trip byte for byte.
- Join tests reproduce `FixtureExpected/localization` states exactly and never join by text.
- The CLI and the Workbench report identical counts.

**Progress (2026-10-07)**:

- **3a done.** `@ue-shed/localization` is public and adds `ue-shed loc targets`.
    - It reads Dashboard target settings, applying config-array operations, and authored recipe
      configs.
    - It reads manifests and archives in the 4.27 and 5.x layouts, PO files in the Unreal and
      Crowdin formats with a lossless model, locmeta, and word-count reports.
    - Readers match Unreal's evidence for UE 5.7 and 5.8, including the retained `ue5.8-output`
      bytes, and every fixture PO round-trips byte for byte.
    - The packed-consumer journey passes with 20 tarballs.
- **3b done in the package and CLI.**
    - The join between the corpus and the localization evidence uses identity only.
    - Every line and culture gets one primary state, chosen in this order: `outside_target`,
      `not_gathered`, `not_found`, `gathered_only`, `changed_since_gather`, `unknown`, `not_synced`,
      `needs_update`, `not_translated`, `translated`. The facts behind the other states remain
      available.
    - The bounded localization query feeds `ue-shed loc status` and translation-aware `text search`.
    - A real-reader scan of the fixture reproduces all 54 intended states.
    - The translator-notes gap from 3d is also closed: a String Table entry's `Comment` metadata is
      merged into that occurrence's `dev_notes`. The wire shape is unchanged.
    - Verified on Node 24 and Node 26. Precommit, `uasset:check:libraries`, `uasset:check:io`, the
      packed-consumer journey and the Workbench recording pass. `pnpm test:uasset-engine-matrix`
      passes on UE 5.7 and UE 5.8.
- **3c done.** Workbench main loads the selected target's evidence, joins it with the retained
  corpus, reloads it on Rescan, and answers bounded IPC queries.
    - The toolbar gains compact target and culture menus and a warning "N not synced" indicator.
    - State chips show counts from the same query.
    - With a culture selected, rows show that culture's translation, or the state when there is
      none. With "All cultures", rows show only the cultures that need attention, and a
      culture-independent state is said once.
    - Gathered-only lines are labelled with their source location.
    - The detail's Translations section, native culture first, shows what the game uses. For
      `needs_update` and `not_translated` that is the source text, as Unreal's compiler falls back
      to it. The old translation stays visible, with the source it was written for. The PO
      translation appears only when it is a real unsynced edit. Informational states are muted and
      said once.
    - Target, culture, state and "Search translations" are remembered per project.
    - Component tests pass on Node 24 and Node 26. Recording screenshots 08–11 were reviewed in two
      rounds.
- **3d (translator notes on 5.7)** landed with 3b. Phase 3's gate is met.

## Phase 4 — Checks and reports

1. Add built-in localization findings to the quality report model:
    - format arguments missing or added, with a suggested fix when exactly one argument was
      renamed;
    - plural, ordinal and gender form problems;
    - unbalanced rich text tags;
    - escapes that will not survive a PO round trip;
    - leading or trailing whitespace and line break differences;
    - an empty translation, or missing translator notes;
    - the same source under different keys.
2. Extend project rules with per-culture character budgets and per-culture glossaries in a version 2
   rule document. Version 1 documents still decode and evaluate unchanged.
3. Add reports per culture:
    - lines and words translated, reviewed and proofread;
    - words that are new or changed since a baseline;
    - the coverage behind every number.
4. Expose these through the CLI (`ue-shed loc check`, `ue-shed loc report`) and the Workbench quality
   view, including a "Resolve all" that only stages suggested fixes and never writes them.

**Gate**: every built-in check has fixture and pure tests that match Unreal's own validators on the
same inputs. Reports carry corpus and gather coverage. A suggested fix produces a change set and
never writes a file.

**Progress (2026-10-07)**: 4a is done.

- `@ue-shed/game-text` has eight built-in checks: arguments, modifiers, rich text, PO escape
  safety, whitespace and line breaks, empty entries, missing translator notes, and duplicate
  sources. They evaluate the translation the next sync will ship. Rule documents can disable
  individual checks.
- Suggested argument renames become v1 change sets, defined in `@ue-shed/localization`.
  `ue-shed loc check --changes` writes only that proposal file.
- The fixture evidence records Unreal's own results for every line and culture, on UE 5.7 and
  UE 5.8: `FTextFormat::ValidatePattern` and argument names, `FCulture` plural forms,
  `GenerateLocRes` rich-text and safe-whitespace warnings, and PO escape conversion. Oracle tests
  require a finding wherever Unreal reports a problem. Ten new fixture lines bring the intent to
  84 entries.
- Node 26 tests, the packed-consumer journey, the recording, Data Authoring adoption, and
  `pnpm test:uasset-engine-matrix` pass on UE 5.7 and UE 5.8.
- **4b done.**
    - Rule documents gain version 2, built from version 1 with schema combinators. Roles can carry
      per-culture budgets and glossaries.
    - `ue-shed loc report` gives per-culture progress. Reviewed and proofread are marked "not
      tracked yet".
    - Word counts use Unicode line breaking through the reviewed `linebreak` dependency. They match
      Unreal's word-count report exactly on both committed UE 5.7 and UE 5.8 CSVs (62/59/62/54).
    - Baselines are created exclusively, and their deltas report new, changed and removed words.
- **4c done.** The Workbench gains the following:
    - The Quality checks tab carries localization and per-culture findings, with argument, tag,
      escape and whitespace highlights.
    - Suggested-fix diffs offer "Copy change set" and "Resolve all: copy suggested fixes". Nothing
      is written.
    - A Reports view with one row per culture, baseline save and compare, and CSV export. Its
      numbers are identical to `loc report`.
    - The rule editor edits version 2 culture rules and can upgrade version 1 documents.
    - Node 24 and Node 26 tests and the recording pass, and screenshots 12–13 were reviewed.
- Phase 4's gate is met. Phase 5 (Unreal localization processes) is next.

## Phase 5 — Unreal localization processes

1. Add an Effect service that runs `GatherText` with the project's existing per-operation configs
   for gather, import, export, compile and reports, on discovered or explicit engines. It must
   handle 4.27's `UE4Editor-Cmd` and its smaller argument set.
2. Before running, list the files the operation may write (manifest, archives, PO, `.locres`,
   `.locmeta`, reports) from the parsed configs, so a host can check them out.
3. Stream progress from the step boundaries, support cancel through the owned process tree, and
   return typed failures with recovery guidance:
    - missing config;
    - engine not found;
    - commandlet failure, with the relevant log excerpt kept private to the explicit result;
    - timeout;
    - cancellation.
4. If a project has no per-operation configs, fail with guidance to generate them from Unreal's
   Localization Dashboard. Generating configs through a UE Shed editor commandlet is optional and
   separately gated.
5. Add CLI commands:
    - `ue-shed loc gather|import|export|compile|report <project-root> --target`, with `--plan` to
      list the files without running.

    Add Workbench actions with progress and cancel.

**Gate**:

- Real runs on UE 5.7 and UE 5.8 against the fixture produce the recorded evidence.
- Cancellation leaves no orphaned process.
- The listed files cover every file that changed. 4.27 is run and reported if it is in the support
  window.

**Progress (2026-10-07)**: 5a is done.

- `@ue-shed/localization` plans operations as pure functions: gather, import, export, compile,
  reports, and sync, which runs import then compile in one `-Config=a;b` process. Each plan names
  the configs, the arguments, and every file the operation may write. It works for Dashboard
  per-operation configs and for config-only recipes.
- Runs go through `@ue-shed/engine` discovery and `OwnedProcessTree`, using `UnrealEditor-Cmd`, or
  `UE4Editor-Cmd` with the 4.27 argument set. They emit bounded step progress from a private log
  and fail with typed errors. A receipt compares file hashes and reports any unplanned write.
- UE Shed never passes source-control switches. `ue-shed loc run <operation> --plan` prints the plan
  without launching.
- `pnpm test:localization-processes` passed on UE 5.7, UE 5.8 and UE 4.27. It runs every plan and
  every supported operation, checks that every changed file was planned, and checks that a
  mid-run cancel leaves no process behind. On UE 5.7 and UE 5.8 a PO edit followed by `sync`
  turns the line from `not_synced` to `translated`.
- 5b (the Workbench actions, with progress and cancel) is next.

## Phase 6 — Translation editing

1. Add the version 1 change set schema, revalidation against current evidence, and the PO writer
   from ADR 0009:
    - writes are atomic;
    - the writer touches only the changed `msgstr` values;
    - stale changes are rejected;
    - it returns a receipt.
2. Stage edits in the Workbench detail pane and support multi-select. Show the diff before writing,
   then "Write to PO" followed by "Sync with Unreal" (import and compile).
3. Make unsynced translations unmistakable: a "Not synced" mark per line and culture, the PO and
   in-game translations side by side in the detail pane, a toolbar total beside "Sync with Unreal",
   a "Not synced" filter, and counts in CLI status and reports. Translations written to the PO by
   other tools are included.
4. Add CLI parity:
    - `ue-shed loc apply <project-root> --changes <file> [--sync]`;
    - change set output from `loc check` suggested fixes.

**Gate**:

- PO writer tests prove that every byte outside the edited values is preserved.
- Stale changes are rejected.
- A written edit shows as "Not synced" on its row, in detail, in the toolbar total, in the filter
  and in CLI status, and no surface shows it as translated in game before the sync.
- A Workbench edit followed by a UE 5.7 and UE 5.8 sync shows the line as translated after a rescan.

## Phase 7 — Review workflow

1. Add the version 1 review file schema, its reader and writer, and fingerprint invalidation.
2. Add review lenses (Not reviewed, Not proofread, Changed since review, Machine translated), plus
   accepted duplicates and dismissed findings.
3. Add review actions in the Workbench and the CLI (`ue-shed loc review set|clear`), and review
   percentages in reports.

**Gate**:

- Review state survives a gather, import, export and compile on both engines.
- An edited source or translation shows as changed since review.
- The file's diffs stay sorted and minimal.

## Phase 8 — Optional extensions (each needs separate owner approval)

- The editor writer through a UE Shed plugin and `FLocTextHelper`, with immediate apply.
- A font preview per culture through the running editor.
- A side-by-side grid mode for bulk editing a few cultures.
- Voice lines and dialogue waves.

## Verification matrix

| Scope           | Evidence                                                                                               |
| --------------- | ------------------------------------------------------------------------------------------------------ |
| Fixture         | 5.7 and 5.8 commandlet-generated target and recorded states; no hand-written outputs                   |
| Formats         | manifest, archive and PO decode for 4.27, 5.7 and 5.8 samples; unmodified PO round-trips byte for byte |
| Join and states | `FixtureExpected/localization` reproduced; coverage-qualified Unknown; no text-based joins             |
| Counts          | every count equals its query's search total; empty-text units excluded consistently                    |
| Checks          | built-in checks agree with Unreal's validators on fixture inputs                                       |
| Processes       | real gather, import, export and compile on 5.7 and 5.8; cancel; listed files cover actual writes       |
| Editing         | change set revalidation, atomic PO write, stale rejection, sync round trip                             |
| Review          | fingerprint invalidation; review state survives Unreal operations                                      |
| UI              | component tests and self-reviewed screenshots of the real Workbench                                    |
| Security        | no text, keys, paths or terms in telemetry                                                             |
| Repository      | `pnpm check`; `pnpm test:uasset-engine-matrix` on UE 5.7 and 5.8 for fixture changes                   |

## STOP conditions

Stop and report rather than weakening the contract if:

- any phase needs UE Shed code to write a manifest, archive, `.locres` or `.locmeta`;
- a join needs source text matching to link a line to a translation;
- a state such as "Not gathered yet" or "Not found in the project" cannot be qualified by coverage;
- the PO writer cannot preserve unmodified bytes exactly;
- a fixture output would have to be written by hand, or one engine cannot generate it;
- Unreal's import, export or compile behaviour differs from the facts recorded here on 5.7 or 5.8;
- review state would need to live in Unreal's files;
- a full corpus, full report or filesystem authority must cross renderer IPC;
- telemetry needs text, keys, paths or terms;
- studio-specific cultures, paths, terms or budgets would enter defaults; or
- `pnpm check` or a required Unreal lane stays red after scoped fixes.

## Out of scope

- UE Shed writes to manifests, archives, `.locres` or `.locmeta`;
- source text editing (it remains Data Authoring's live Apply and Save);
- translation memory, machine translation services, vendors, assignment and billing;
- source control operations in the core;
- rendered width measurement without a running editor; and
- live asset scans of pre-5.4 packages before Plan 050 lands.

## Reference facts (verified in engine source, 2026-10-07)

Recorded from UE 4.27, 5.7 and 5.8 `Engine/Source`. Re-verify before relying on them.

- **Dashboard configs.** The Localization Dashboard writes `Config/Localization/<Target>_Gather.ini`,
  `_Import.ini`, `_Export.ini`, `_Compile.ini` and `_GenerateReports.ini`, plus per-culture
  variants. Targets are stored as `+GameTargetsSettings` under
  `[/Script/Localization.LocalizationSettings]` in `Config/DefaultEditor.ini`.
- **Running GatherText.** `GatherText` runs each `GatherTextStepN` section in order. The 5.x
  versions accept `-Preview` and `-GatherType`; 4.27 does not. Preview writes a `_Preview` manifest
  and reports, and it is not a file-listing dry run.
- **Source control switches.** Source control is used only with `-EnableSCC`, and it submits
  unless `-DisableSCCSubmit` is also passed.
- **File formats.**
    - Manifest: `FormatVersion` 1. Archive: `FormatVersion` 2. Both are UTF-16LE with a BOM.
    - PO files are UTF-8 with a BOM. `.locres` is version 3. `.locmeta` is version 2 in 5.x and
      version 1 in 4.27.
    - The 5.8 manifest adds a key `DevNotes`, which is exported to PO as `#. DevNotes:`. 5.8 also
      writes localization files only when they changed, by atomic rename.
- **PO field mapping.** `msgctxt` is `Namespace,Key` with commas escaped, and `msgid` is the source.
  Crowdin format moves the key into `msgid` and carries no source.
- **PO import.** It reads only `msgctxt`, `msgid` and `msgstr[0]`. It skips empty and plural
  entries, ignores flags and comments, and records the translation against the PO's `msgid` source.
- **PO export.** It regenerates the file from the archives and writes no flags. Translator comments
  persist only with `ShouldPersistCommentsOnExport` and an unchanged `msgid` and `msgctxt`.
- **Outdated translations.** These are archive entries whose recorded source no longer matches the
  manifest (`FLocTextHelper::GetRuntimeText`). The compiler uses the source for them unless
  `bSkipSourceCheck` is set. Export writes an empty `msgstr` for them.
- **Escapes.** PO escapes cover `\\`, `\"`, CR, LF and TAB. A literal backslash followed by `n`,
  `r` or `t` does not survive a round trip.
- **Compile validators.** The compiler optionally validates format patterns, safe whitespace and,
  in 5.x only, rich text tag balance. All of them only warn.
