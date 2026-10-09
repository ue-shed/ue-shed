# Plan 054: Check a change's text before it is submitted

> **Executor instructions**: Follow this plan in order. Before editing, read `AGENTS.md`,
> `docs/README.md`, `docs/products/game-text.md`, ADR 0009, Plans 052 and 053 and
> `docs/engineering/testing.md`. Run targeted checks while iterating and `pnpm check` before
> handoff.
>
> **Drift check (run before each phase)**:
> `git diff origin/main...HEAD -- packages/game-text apps/cli docs/products/game-text.md`.

## Status

- **State**: IN PROGRESS. Phases 1–3 are done; the plan closes when PR #58 merges.
- **Priority**: P1
- **Effort**: M
- **Risk**: LOW. The command only reads. Its risk is a check that fails good work or passes bad
  work, so every failure names its line and a way forward, and a project can change the policy.
- **Depends on**: Plan 052 (changed files, key changes), Plan 053 (problems).
- **Category**: product
- **Planned at**: `feat/localization-identity-tools`, 2026-10-08

## Context

The user interview asked for identity validation. Game Text finds identity problems, but nothing
checked a change that creates one before it was submitted. The costly case is a key change: if
someone renames a key and a gather then runs outside UE Shed, Unreal drops the earlier key's
translations and they are gone.

Fixes that write to assets are applied by Unreal (ADR 0009 addendum), so this plan only checks. It
adds one CLI command that a pre-submit step can call: given the files a change touches, it judges
the text in those files and exits 1 when the change fails. UE Shed never submits or talks to a
server; the caller supplies the file list and decides what a failure means.

A failure is only an exit code and a printed list. It stops nothing by itself: it has
consequences only where a team wires it into a submit script or a required build. UE Shed does
not manage source control enforcement (owner decision, 2026-10-08).

## Decisions (owner answers, 2026-10-08)

1. **One command**: `ue-shed loc gate <project-root> --files <list-file> [--target <name>]...`.
   With no `--target`, every target is checked from one corpus scan, and a target Unreal has never
   gathered is skipped and listed; a named target must have a readable manifest.
2. **What it judges**: every line whose text lives in a listed file, through the existing
   `where.files` matching. There is no history, so a problem already in a touched file counts
   too ("touch it, fix it").
3. **Fails by default**:
    - `key_changed`: the earlier key has a translation in at least one culture. A key change that
      loses nothing is new text, and warns as `not_gathered`.
    - `conflicting_source`: one key with two texts.
    - `translated_text_changed`: text changed after it was translated, so those languages show it
      untranslated until it is translated again.
4. **Warns**: `text_changed` (untranslated), `not_gathered`, `unresolved_key`, `removed` (gathered
   text its file no longer has, or a file that could not be read) and `gathered_source` (a
   changed C++ or config file, whose key changes show only across a gather).
5. **Policy flags**: `--fail-on <check>` and `--warn-on <check>` (repeatable); passing one check to
   both is an error. No policy file.
6. **Exit codes**: `0` passed, `1` failed, `2` could not check. A run that could not check prints
   `status: "not_checked"`, never `failed`, so a script cannot mistake it for a verdict.
7. **Output**: JSON with `status`, `failOn`, `skipped`, and per target the lines checked, a count
   per check, up to 200 lines (failures first) with check, severity, key, text, file and a way
   forward, the omitted count and the changed-file summary. `--summary` prints the same as lines.
8. **Name**: `loc gate`.

## Phase 1: Core verdict

1. `packages/game-text/src/localization-gate.ts`: `LocalizationGateCheck`,
   `DEFAULT_GATE_FAILURES`, `localizationGateFailures(failOn, warnOn)`, a pure
   `localizationGateTarget({ corpus, query, join, files, failOn })` and
   `localizationGateResult(targets, failOn, skipped)`. Lines come from the existing query with
   `where.files` and problem clauses, so the verdict reuses the same problems as the list.
2. Tests: each default failure and warning, a key change with and without translations, removed
   text and a changed source file, untouched files, the policy, and the 200-line bound.

**Evidence (2026-10-08)**: done. `localization-gate.test.ts` (8 tests). At 50,000 lines in 14
cultures, a change touching all 1,000 tables takes about 1.2 s for the verdict, against 0.27 s for
a plain page; `query-scale.test.ts` keeps a loose bound.

## Phase 2: CLI

1. `loc gate` with `--files`, `--target`, `--fail-on`, `--warn-on`, `--summary` and `--reader`;
   `LocalizationGate` in `command-model.ts`; `workflows/localization-gate.ts`. The corpus scan
   moved into a shared `scanProjectText`, so several targets share one scan.
2. Integration test on a temporary fixture copy with one renamed key: the table's file fails with
   exit 1 and names the earlier key, `--summary` prints `FAIL  Key changed`, `--warn-on` relaxes
   it, a file without text passes with exit 0, and a missing list, a contradictory policy, the
   never-gathered `Game` target named explicitly and an unknown target each exit 2.

**Evidence (2026-10-08)**: done. Writing the test found that checking every target stopped on the
fixture's never-gathered `Game` target; such targets are now skipped and listed. The fixture run
takes about a second end to end. A project-scale scan was not measured: the scan is the same one
`loc status` runs, and reusing the project index stays a follow-up if pre-submit runs prove slow.

## Phase 3: Documentation

1. `docs/products/game-text.md`: "Checking a change before submit", with the checks and their
   defaults, the flags and output, exit codes, producing the list with Git
   (`git diff --cached --name-only --relative`) or a Perforce changelist, where it must run, and
   that fixes are made in Unreal.
2. Changeset `check-text-before-submit.md` for `@ue-shed/game-text`.

**Evidence (2026-10-08)**: done.

## Limits, stated in the docs

- It reads the workspace as it is on disk, so it must run where the change is: on the
  submitter's machine, or in a build that has the change applied. A Perforce server trigger has
  no workspace to read.
- C++ and config key changes show only across a gather UE Shed runs, so changed source files that
  hold gathered text only warn.
- A full project scan runs each time.

## Out of scope

- Fixing anything. Fixes are applied in Unreal.
- A Workbench view of the verdict, a policy file, and source control enforcement.
