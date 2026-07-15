# Plan 012: Run the CLI as one Effect program

> **Executor instructions**: Preserve command syntax, stdout JSON, stderr wording where tested, and
> exit codes. Update `plans/README.md` when all CLI E2E cases pass.
>
> **Drift check (run first)**: `git diff --stat 2f7ac8b..HEAD -- apps/cli packages scripts/ue-shed.mjs`

## Status

- **Priority**: P1
- **Effort**: L
- **Risk**: MED — automation depends on stable JSON and exit behavior
- **Depends on**: Plan 011
- **Category**: migration
- **Planned at**: commit `2f7ac8b`, 2026-07-16

## Why this matters

`apps/cli/src/index.ts` is a 737-line async dispatcher with dozens of local `Effect.runPromise`
calls. It repeatedly leaves and re-enters Effect, constructs services inside commands, throws for
expected input failures, and duplicates Apply/Save orchestration. The CLI should be one Effect from
argument decoding to output, with one runtime exit.

## Current state

- `apps/cli/src/index.ts:74-96` parses options with throwing helpers.
- Lines 98-698 define Promise command functions and contain most of the repository's 105
  `Effect.runPromise` sites.
- Lines 301-307 call `Effect.runSync(makeAuthoringSessionService(...))` per command path.
- Lines 399-467 manually orchestrate Apply/Reconcile/Save with nested try/catch and multiple runs.
- Lines 701-737 dispatch async functions and catch one rejected Promise at process exit.

## Commands you will need

| Purpose       | Command                                | Expected on success |
| ------------- | -------------------------------------- | ------------------- |
| CLI typecheck | `pnpm --filter @ue-shed/cli typecheck` | exit 0              |
| CLI E2E       | `pnpm test:e2e:cli`                    | pass                |
| Fast tests    | `pnpm test:fast`                       | pass                |
| Full gate     | `pnpm check`                           | exit 0              |

## Scope

**In scope**: `apps/cli/src`, its package manifest/tests, and the source-checkout launcher only if
required for runtime wiring.

**Out of scope**: changing command names/arguments/JSON, Workbench, new commands, product behavior,
adopting a v3-only CLI package.

## Steps

### Step 1: Model CLI input and output

Define schema-owned command/option variants and typed usage/config/output failures. Parse argv into a
tagged command value in Effect. Invalid JSON values decode through the owning schema in the error
channel. Keep help text as one derived/central value.

Do not adopt `@effect/cli` unless its installed release explicitly supports the pinned v4 version;
at planning time its npm channel has no v4 beta tag.

**Verify**: unit tests cover every command variant, missing/duplicate options, malformed JSON, help,
and version.

### Step 2: Build a CLI application service

Create named command handlers that yield domain services from context. Compose command effects
directly; never run nested Effects. Move Apply/Save/reconcile behavior to the domain service from
Plan 011 and render its typed outcome.

Provide configuration, reader, repositories, Remote Control, clock, random IDs, console, and domain
services through a topologically sorted `CliLive` layer.

**Verify**: `rg -n "Effect\.run(Promise|Sync)|async function" apps/cli/src` finds only the one
approved process adapter, if the chosen v4 Node runtime requires it.

### Step 3: Establish the single runtime exit

`main(args)` returns `Effect<void, CliError, CliServices>`. The executable provides `CliLive` once and
runs once using the v4 Node runtime/main facility. Render expected errors to stderr with exit code 2;
preserve defects/interruptions as distinct exits and ensure finalizers complete.

**Verify**: instrumented tests show service layers acquire once and finalize once per CLI process.

### Step 4: Strengthen E2E parity

Extend CLI E2E coverage to representative saved inspection, session lifecycle, malformed input,
typed Remote Control failure, and help/version output. Assert exit status and parse stdout as JSON
where promised.

**Verify**: `pnpm test:e2e:cli` passes without setting live Unreal variables.

## Done criteria

- [ ] The CLI is one Effect program with one runtime exit.
- [ ] No command handler constructs/runs services or orchestrates Promises.
- [ ] Expected input/config/domain failures are typed.
- [ ] Existing command syntax, JSON, and exit behavior are preserved.
- [ ] `pnpm check` and CLI E2E pass.

## STOP conditions

- A command's current JSON contract is ambiguous or untested.
- The only proposed CLI library release depends on Effect v3.
- A domain workflow is still unavailable as a service and would have to be reimplemented in CLI.

## Maintenance note

Future commands add a schema variant and an Effect handler; they do not add an async island or a new
runtime.
