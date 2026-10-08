# Plan 054: Check a change's text before it is submitted

> **Executor instructions**: Follow this plan in order. Before editing, read `AGENTS.md`,
> `docs/README.md`, `docs/products/game-text.md`, ADR 0009, Plans 052 and 053 and
> `docs/engineering/testing.md`. Run targeted checks while iterating and `pnpm check` before
> handoff.
>
> **Drift check (run before each phase)**:
> `git diff origin/main...HEAD -- packages/game-text apps/cli docs/products/game-text.md`.

## Status

- **State**: TODO. Waiting for the owner's answers to the open questions below.
- **Priority**: P1
- **Effort**: M
- **Risk**: LOW. The command only reads. Its risk is a check that fails good work or passes bad
  work, so the default policy is narrow and every failure names its line and a way forward.
- **Depends on**: Plan 052 (changed files, key changes), Plan 053 (problems).
- **Category**: product
- **Planned at**: `feat/localization-identity-tools`, 2026-10-08

## Context

The user interview asked for identity validation. Game Text now finds identity problems, but
nothing stops a change that creates one from being submitted. The costly case is a key change: if
someone renames a key and a gather then runs outside UE Shed, Unreal drops the earlier key's
translations and they are gone.

Fixes that write to assets are applied by Unreal (ADR 0009 addendum), so this plan only checks. It
adds one CLI command that a pre-submit step can call: given the files a change touches, it judges
the text in those files and exits non-zero when the change would lose translations or give one key
two texts. UE Shed still never submits or talks to a server; the caller supplies the file list and
decides what a failure means.

A failure is only an exit code and a printed list. It stops nothing by itself: it has
consequences only where a team wires it into a submit script or a required build.

## Decisions

1. **One command**: `ue-shed loc gate <project-root> --files <list-file> [--target <name>]...`.
   With no `--target`, every target is checked; the corpus is scanned once.
2. **What it judges**: only lines whose text lives in a listed file, using the existing
   `where.files` matching (assets by package, gathered C++ and config by source file). Deleted
   files in the list match through the manifest.
3. **Problems that fail the check by default**:
    - `key_changed` when the earlier key has a translation in at least one culture. A key change
      with nothing translated loses nothing and only warns.
    - `conflicting_source`: one key with two texts, so Unreal ships one of them everywhere.
4. **Problems that only warn**: `not_gathered`, `changed_since_gather`, lines with no reliable key,
   gathered lines a deleted file removes, and changed C++ or config files that hold gathered text
   (their key changes only show after a gather).
5. **Policy flags**: `--fail-on <problem>` and `--warn-on <problem>` (repeatable) adjust the defaults
   for a project. No policy file in this plan.
6. **Exit codes** follow the CLI: `0` passed, `1` failed, `2` could not check (unreadable list,
   missing manifest, reader failure). The docs recommend treating `2` as a failure.
7. **Output** is the CLI's usual JSON: `status` (`passed` or `failed`), per target the failing
   lines (bounded at 200 plus a count) with problem, namespace, key, source, file and a one-line
   way forward, the warning counts, and the file-scope summary. `--summary` prints the same as a
   few readable lines for people reading a pre-submit dialog.
8. **Ways forward** in the output: for a key change, "carry its translations: `loc run prepare
--carry`, then `loc apply --sync`", or keep the earlier key in Unreal; for same key with
   different text, give one of the texts a new key in Unreal.

## Open questions for the owner

1. **Pre-existing problems.** The gate has no history, so a problem already in a touched file
   fails too ("touch it, fix it"). Is that acceptable, or should known problems be accepted
   through the review file, as `loc review accept` does for checks?
2. **Default policy.** Is failing only on translated key changes and same key with different
   text right, or should `changed_since_gather` (text changed after translation) also fail?
3. **Name.** `loc gate`, or something else?

## Phase 1: Core verdict

1. `packages/game-text/src/text-gate.ts`: a pure
   `textChangeGate({ join, corpus, files, policy })` returning failing lines, warning counts and
   the file scope. It reuses `textProblems`, key-change pairs and their carried translations, and
   the file matching from Plan 052.
2. Schemas for the policy and result in `schema.ts`, exported from `browser.ts` and `index.ts`.
3. Tests: each default failure and warning, `--fail-on` and `--warn-on`, a key change with and without
   translations, a deleted file, a changed C++ file, the output bound.

**Gate**: pure tests pass; the verdict for an empty file scope is `passed` with no warnings.

## Phase 2: CLI

1. `loc gate` in `apps/cli/src/commands/localization.ts`, a `LocalizationGate` command in
   `command-model.ts`, and `workflows/localization-gate.ts` using `loadLocalizationContext` and
   `readChangedFiles`. Several targets share one corpus scan.
2. `--summary` text output.
3. Integration test against a temporary copy of the localization fixture with one renamed key, as
   the Game Text tour does: the asset's file fails with exit 1, an untouched file passes with
   exit 0, and a missing list exits 2.
4. Measure the run time on the fixture and on the generated 50,000-line project from Plan 053.
   If a full scan is too slow for a pre-submit step, record it and plan reuse of the project
   index (`scanFromProjectIndex`) separately.

**Gate**: the integration test and both Node sweeps pass.

## Phase 3: Documentation

1. `docs/products/game-text.md`: "Checking a change before submit", covering what fails, what warns, exit codes, the limits below, and two generic examples of producing the list: a
   staged Git change, and a Perforce changelist's opened files mapped to local paths. Plan 052's
   Perforce bridge would later supply the list directly.
2. A changeset for `@ue-shed/game-text`.

## Limits, stated in the docs

- It reads the workspace as it is on disk, so it must run where the change is: a client-side
  pre-submit step, or a build that has the change applied. A Perforce server trigger has no
  workspace to read.
- C++ and config key changes only show after a gather, so the gate warns about changed source
  files that hold gathered text but cannot judge them.
- A full project scan runs each time; Phase 2 measures it.

## Out of scope

- Fixing anything. Fixes are applied in Unreal.
- A Workbench view of the verdict, a policy file, and server-side triggers.
