# Plan 042: Add project-authored Game Text quality rules

> **Executor instructions**: Follow this plan in order. Read `AGENTS.md`, `docs/README.md`,
> `docs/vision-and-architecture.md`, `docs/products/game-text.md`, the complete Game Text idea,
> engineering adoption guidance, and Plan 033 before editing. Preserve Plan 033's single project
> enumeration, compact extraction, query ownership, and bounded renderer contracts. Open a draft PR
> after committing only this plan/product-contract bootstrap. Run `pnpm check` after substantive
> edits and immediately before handoff.
>
> **Drift check (run before each implementation phase)**:
> `git status --short -- docs/products/game-text.md plans/042-project-authored-game-text-quality.md packages/game-text apps/cli extensions/game-text apps/workbench/src/main apps/workbench/src/renderer`
> and
> `git diff origin/main...HEAD -- packages/game-text apps/cli extensions/game-text apps/workbench/src/main apps/workbench/src/renderer`.
> Rebase after parallel release work lands. Preserve package metadata, root README, release metadata,
> and adoption changes unless this slice has an unavoidable contract dependency.

## Status

- **State**: DONE — typed rules, pure evaluation, CLI review, and portable gates verified
- **Priority**: P1
- **Effort**: L
- **Risk**: MEDIUM — adds a project-authored rules boundary and CLI workflow over confidential text
  evidence; must not create a second scanner, broaden invalid scopes, leak data to telemetry, or
  bypass bounded Workbench queries.
- **Depends on**: Plan 033 compact corpus/query ownership
- **Category**: product
- **Planned at**: isolated `feat/game-text-quality` worktree, 2026-08-11

## Outcome

Add explainable, project-authored roles, character budgets, and terminology findings over the
existing `TextCorpus`. The pure evaluator, schemas, and report contract live in
`@ue-shed/game-text`; the CLI supplies file and reader authority. Coverage and unsupported evidence
survive evaluation unchanged. No source or localization mutation is introduced.

## Fixed decisions

- A version-1 Effect Schema document is the TypeScript-owned rules authority.
- Roles use non-empty, explicit occurrence-evidence scopes. Matchers compose with AND inside a scope
  and OR across scopes; a role is never an implicit match-all.
- Role matchers cover location kind, object path, DataTable row/property, asset class/property, and
  String Table identity without project-specific defaults.
- Rules reference roles by branded IDs. Duplicate role/rule IDs and unknown role references are
  semantic decode failures, not ignored configuration.
- The evaluator is a pure function over a decoded rule document and an existing `TextCorpus`.
- Findings retain rule, role, unit, affected occurrence, actual, expectation, and recovery evidence.
- Reports copy corpus status, coverage, and diagnostics; zero findings do not strengthen coverage.
- `ue-shed text review <project-root> --rules <file>` scans through `TextCorpusService`; it performs
  no direct project enumeration.
- The hardcoded `long` lens and configured budgets coexist. `long` remains the existing 40-character
  browsing heuristic and never becomes a configured finding or changes with a rule document.
- Explicit review output may contain authored evidence. Telemetry, spans, metrics, and ordinary
  errors contain no source text, project paths, identities, rule contents, or terms.
- Workbench presentation is optional for this first slice. Any integration uses only the existing
  trusted-host `GameTextClient`/query boundary and bounded browser-safe schemas; no full report or
  corpus crosses renderer IPC.

## Phase 1 — Bootstrap contract and draft PR

1. Add the focused Game Text product contract covering the shipped read-only corpus and this quality
   slice.
2. Register Plan 042 and record the `long`-lens coexistence decision.
3. Commit only the plan/product-contract bootstrap, push the isolated branch, and open a draft PR
   against `main`.

**Gate**: the branch is based on `origin/main`, the worktree is clean before edits, the bootstrap
commit contains documentation only, and the remote draft PR exists before substantive code.

## Phase 2 — Versioned rules and findings

1. Add branded role/rule identifiers and version-1 Effect Schemas in new Game Text source files.
2. Model non-empty role scopes and discriminated generic evidence matchers.
3. Model character-budget and terminology rules, including forbidden terms and preferred
   replacements with explicit case sensitivity.
4. Add report/finding schemas with structured actual and expectation variants, affected occurrence
   evidence, recovery guidance, coverage, and diagnostics.
5. Provide a typed decoder that translates structural and semantic failures into actionable
   `Schema.TaggedErrorClass` values without logging rule contents.
6. Export only browser-safe schemas and pure helpers from the browser entry point.

**Gate**: tests prove malformed documents, empty scopes, duplicate IDs, unknown roles, and empty path
or term values fail through the typed channel. No invalid configuration can produce an unscoped
role.

## Phase 3 — Pure evaluator and deterministic fixtures

1. Implement occurrence-role matching and pure evaluation over `TextCorpus`.
2. Emit character-budget findings using the documented version-1 character measure.
3. Emit exact forbidden/preferred terminology matches and offsets without mutating text.
4. Aggregate affected occurrences without erasing distinct Unreal identities or locations.
5. Sort roles, rules, text units, matches, and findings by explicit stable keys.
6. Add a generic rules fixture and corpus tests for overlapping roles, non-matches, conflicting
   sources, case behavior, and deterministic order.
7. Prove a partial corpus's status, coverage, unsupported count, and diagnostics survive unchanged.

**Gate**: evaluator tests are pure and deterministic; the report decodes against its public schema;
coverage equality is asserted rather than reconstructed.

## Phase 4 — Headless CLI review

1. Add the `TextReview` CLI command and `--rules` flag beside current text scan/search commands.
2. Read the rule file through the Node CLI boundary, decode it through the public typed decoder, scan
   with `TextCorpusService`, evaluate, and print schema-versioned JSON.
3. Translate unreadable-file, malformed-JSON, invalid-rule, and corpus-scan failures into actionable
   typed CLI failures. Do not include source text or rule contents in messages.
4. Add focused command-model, workflow, and CLI tests using temporary generic files and the existing
   reader/test seams where practical.

**Gate**: `ue-shed text review <project-root> --rules <file>` uses the existing scan service, emits a
decodable report, and distinguishes rule decoding failure from scan failure.

## Phase 5 — Bounded host/query seam

1. Add browser-safe finding summary/page/focus query helpers only where needed for host presentation.
2. If Workbench presentation is included, retain the corpus and evaluated findings in Workbench main
   and extend the existing client/IPC query seam with enforced page limits.
3. Never send the rule document, complete corpus, or unbounded report to the renderer.
4. Keep the existing `long` lens counts and behavior unchanged; configured budgets appear under an
   explicit quality surface only.

**Gate**: browser dependency tests and IPC contract tests reject Node authority and oversized pages;
existing scan/search/focus behavior remains compatible.

## Phase 6 — Verification, rebase, and handoff

1. Run focused Game Text and CLI tests throughout development.
2. Run formatting, lint, typecheck, architecture, and contract checks after substantive edits.
3. Run `pnpm check`; fix and rerun until green.
4. Fetch and rebase onto updated `origin/main` after parallel release work lands, preserving both
   change sets. Rerun focused tests and `pnpm check` immediately before handoff.
5. Update this plan with completed gates and exact evidence, commit all work, push, add verification
   evidence to the PR, and mark it ready only while green.

## Verification matrix

| Scope          | Evidence                                                                      |
| -------------- | ----------------------------------------------------------------------------- |
| Schema         | valid v1 decode; structural and semantic typed failures; browser-safe export  |
| Domain pure    | scope matching, budgets, forbidden/preferred terms, ordering, partial report  |
| Domain fixture | generic corpus and rules retain identity, locations, and unsupported evidence |
| CLI            | file/read/decode/scan/evaluate/output journey and actionable failures         |
| Query/host     | bounded pages and focus if presentation is added; unchanged legacy lenses     |
| Security       | no authored text, paths, identities, terms, or rule contents in telemetry     |
| Repository     | `pnpm check`                                                                  |

## Completion evidence

- Added version-1 branded Effect Schemas, typed structural/semantic failures, and browser-safe
  exports for authored roles, character budgets, terminology rules, findings, and reports.
- Added a pure deterministic evaluator over `TextCorpus`; it preserves corpus status, coverage, and
  diagnostics and scopes every finding to matched occurrence evidence.
- Added `ue-shed text review <project-root> --rules <file>` through `TextCorpusService`, with safe
  boundary errors and no second scanner or persistence path.
- Added a generic rule fixture plus domain, command, workflow, and real saved-corpus CLI tests. The
  tests prove invalid scopes cannot broaden, failures stay typed/actionable, affected occurrences
  remain precise, and partial/unsupported coverage remains visible.
- Verified with focused Vitest runs, the real reader-backed Game Text CLI E2E,
  `pnpm run check:precommit`, and `pnpm check` on 2026-08-11. Three unrelated CLI E2E cases timed
  out once under native-build load and then passed together in isolation before the final full
  green run.

Focused commands:

```powershell
pnpm exec vitest run packages/game-text/src
pnpm exec vitest run apps/cli/src
pnpm run check:precommit
pnpm check
```

## STOP conditions

Stop and report rather than weakening the contract if:

- evaluation requires another filesystem enumeration, generic full inspection, or corpus store;
- empty or invalid role configuration can match the whole corpus;
- findings lose rule, role, unit, occurrence, actual, expectation, or recovery evidence;
- partial/unsupported corpus coverage is dropped or upgraded to complete;
- a complete corpus, rule document, or unbounded report must cross renderer IPC;
- Workbench or its renderer becomes the evaluator or rules authority;
- telemetry requires source text, project paths, identities, terms, or rule contents;
- project-specific roles, paths, terminology, cultures, or budgets enter product defaults; or
- `pnpm check` remains red after scoped corrections.

## Out of scope

- localization PO import/export, translation editing, Apply, Save, or source mutation;
- rendered font/layout measurement;
- persistence or background watching;
- a generic asset/property rule engine;
- automatic replacements or fixes; and
- redefining the existing `long` review lens.
