# Plan 008: Make Effect v4 the repository's application core

> **Executor instructions**: Follow this plan step by step. Run every verification command and
> confirm the expected result before moving on. If a STOP condition occurs, report it rather than
> improvising. Update this plan's row in `plans/README.md` when complete.
>
> **Drift check (run first)**: `git diff --stat 2f7ac8b..HEAD -- package.json pnpm-workspace.yaml pnpm-lock.yaml apps packages extensions docs/engineering docs/vision-and-architecture.md`
> Review any changed Effect dependency, runtime convention, or architecture wording before editing.

## Status

- **Priority**: P0
- **Effort**: L
- **Risk**: HIGH — Effect v4 is `4.0.0-beta.98` at planning time, while the repository uses 3.22.0;
  execution must select the newest coherent v4 release
- **Depends on**: none
- **Category**: migration
- **Planned at**: commit `2f7ac8b`, 2026-07-16

## Why this matters

The repository already intends Effect to own application behavior, but its dependency and guidance
still permit an Effect-at-the-edges architecture. At this commit, 11 workspace manifests specify
`effect: ^3.22.0`; source contains 105 `Effect.runPromise` calls, two `Effect.runSync` calls, and no
`Context.Service`, `Layer`, or `Effect.fn` usage. This plan establishes one v4 baseline and changes
the written rule before later plans build more code on the old shape.

The target is functional programming with Effect as the application runtime and composition model.
Public workflows, service APIs, stateful modules, configuration, concurrency, resources, telemetry,
and test doubles use Effect. Immutable values, pure functions, algebraic data types, and composition
remain first-class functional building blocks inside those workflows. The rejected architecture is
the split between a privileged “pure core” and an Effect shell, not functional programming itself.

## Current state

- `docs/vision-and-architecture.md:56-74` calls Effect the default runtime but describes a
  “functional core with an observable Effect shell.”
- `docs/engineering/README.md:7` says “Use Effect at system edges.”
- `docs/engineering/functional-design.md:3-14` repeats “Pure core, Effect shell.”
- `docs/engineering/effect.md:1-24` has useful rules but does not require services, layers, named
  effects, or a single runtime exit.
- `pnpm-lock.yaml:1593` resolves `effect@3.22.0`.
- The repository gate is `pnpm check`; the fast TypeScript baseline is `pnpm typecheck` plus
  `pnpm test:fast`. Both passed at commit `2f7ac8b` (24 test files passed, 4 skipped).

## Commands you will need

| Purpose                 | Command                             | Expected on success              |
| ----------------------- | ----------------------------------- | -------------------------------- |
| Inspect release channel | `pnpm view effect dist-tags --json` | v4 beta/stable status is visible |
| Typecheck               | `pnpm typecheck`                    | exit 0                           |
| Fast tests              | `pnpm test:fast`                    | all enabled tests pass           |
| Full gate               | `pnpm check`                        | exit 0                           |

## Suggested executor toolkit

- Invoke the repository `effect` skill and read every branch relevant to files changed here.
- Treat the project-local v4 examples and installed v4 source as authoritative. Do not paste v3
  examples into v4 code.

## Scope

**In scope**:

- Root and workspace `package.json` files that declare Effect
- `pnpm-lock.yaml`
- `pnpm-workspace.yaml`
- `docs/vision-and-architecture.md`
- `docs/engineering/README.md`, `functional-design.md`, `effect.md`, `types-and-errors.md`,
  `testing.md`, and `solidjs.md`
- Mechanical v3-to-v4 compatibility edits required to restore the existing behavior
- A small architecture-check script and root package script if needed to enforce the rules below

**Out of scope**:

- Introducing service tags/layers for individual packages; Plans 010 and 011 own that work
- Redesigning CLI, IPC, or renderer APIs; Plans 012–014 own those surfaces
- Changing wire JSON, fixture data, Unreal C++, or Rust
- Adding OpenTelemetry export; Plan 015 owns runtime telemetry wiring

## Steps

### Step 1: Centralize workspace versions and select the newest Effect v4

Add a default pnpm `catalog` to `pnpm-workspace.yaml`. Move every third-party dependency used by two
or more workspace packages into that catalog, including Effect, Solid, StyleX, and their shared test
or build integrations. Each consuming package must continue declaring the dependency it imports,
but use `"catalog:"` instead of repeating a version. Do not rely on root hoisting: package manifests
must remain truthful for packaging and isolated installs.

At planning time npm reports `effect@4.0.0-beta.98` and `@effect/vitest@4.0.0-beta.98` on their beta
tags. Re-check all Effect-family dist-tags at execution. Select the newest coherent v4 release:

- use the current stable v4 when npm `latest` is major 4;
- otherwise use the newest v4 beta;
- pin prerelease Effect-family catalog entries exactly, without `^`;
- keep every Effect-family package on the same compatible v4 build/release line.

Add `@effect/vitest` to the workspace catalog and root development dependencies for the shared test
runner/configuration. As later plans migrate package tests, each package that imports it must declare
its own `catalog:` development dependency. Plan 015 must add `@effect/opentelemetry` through this
same catalog, not a direct range.

Run `pnpm install`, then inspect peer dependency warnings and the installed package source. Add an
architecture check that rejects direct Effect-family version ranges and direct ranges for any other
dependency designated as workspace-catalog-owned.

**Verify**: `pnpm list -r effect @effect/vitest` shows one synchronized v4 version and no v3 copy;
searching workspace manifests shows every Effect-family dependency uses `"catalog:"`.

### Step 2: Perform only the compatibility migration

Update existing Effect/Schema code to v4 APIs without changing public behavior. Use the installed
source to resolve renamed combinators. Preserve schema encodings, error tags, JSON output, ordering,
timeouts, and concurrency bounds. Do not introduce architecture and behavior changes in the same
hunk when they can be separated.

**Verify**: `pnpm typecheck` exits 0.

### Step 3: Rewrite the architecture rule

Replace “Effect shell” and “Effect at system edges” with these explicit rules:

1. Effect is the application core and canonical public workflow type.
2. Every stateful or effectful module exposes a `Context.Service` and layers; consumers do not pass
   ad-hoc dependency bags through workflow calls.
3. Public and non-trivial internal operations use `Effect.fn("Domain.operation")`.
4. `Effect.run*` is restricted to runtime exits and explicit foreign-framework adapters.
5. Promise is contained inside adapters for Electron, browser, Node, or third-party APIs.
6. Functional programming is the default style: immutable values, pure transformations, algebraic
   data types, exhaustive matching, and composition. Pure functions remain ordinary building blocks;
   they do not form a separate runtime or own effectful workflow policy.
7. A proposed hot-path exemption needs a benchmark and a documented boundary. The camera frame
   decoder/presentation loop is a candidate, not a pre-approved exception.

Update Solid guidance to require one Effect-to-Solid adapter with cleanup and interruption.

**Verify**: `rg -n "Effect shell|Effect at system edges|Pure core" docs` returns no stale doctrine.

### Step 4: Add migration guardrails without breaking intermediate phases

Add an `effect:architecture` check that reports (but initially allowlists) `Effect.runPromise`, `Effect.runSync`, Promise
members in public workspace interfaces, direct `process.env` reads in application source, and raw
`fetch` outside adapter files. Store exact paths in a migration allowlist so new violations fail the
gate while Plans 009–015 monotonically remove entries. Do not use a blanket count that can be gamed.

Wire the check into `pnpm check` after typecheck and document how to update it only when a reviewed
foreign-boundary exception is justified.

**Verify**: deliberately checking one temporary unallowlisted fixture makes
`pnpm effect:architecture` fail; remove the fixture and confirm the checker and `pnpm check` pass.

## Test plan

- Existing schemas must retain their encode/decode behavior after v4 compatibility edits.
- Existing typed error tests must retain their tags and fields.
- Add a focused test for the architecture checker: allowed legacy site, new forbidden site, and
  approved runtime-exit path.
- Do not convert all tests to `it.effect` here; each later plan converts the tests it owns.

## Done criteria

- [x] Exactly one Effect v4 version is installed and pinned coherently.
- [x] Shared third-party dependency versions are owned by the pnpm workspace catalog, and consuming
      packages reference them with `catalog:`.
- [x] Architecture docs state Effect-core semantics and a single-runtime-exit rule.
- [x] New architecture violations fail while known migration debt is explicitly allowlisted.
- [x] Public JSON and CLI behavior are unchanged.
- [x] `pnpm check` exits 0.
- [x] No files outside scope are changed.

## STOP conditions

- Required v4 packages do not support the repository's Vitest 4 or TypeScript versions.
- The newest Effect v4 release lacks a coherent compatible build of a required Effect-family package.
- A schema compatibility edit would change a checked-in language-neutral contract.
- Restoring typecheck would require `any`, unchecked casts, non-null assertions, or mixed v3/v4 code.

## Maintenance note

Effect upgrades are deliberate workspace-catalog events: change the central entry or synchronized
Effect-family entries, read release notes, run the full gate, and never let automation move one
Effect package without the others.
