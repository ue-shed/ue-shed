# Plan 045 — Project Custodian read-only slice

Status: DONE — read-only CLI and Workbench inventory verified

## Outcome

Deliver a reusable, headless Project Custodian that discovers Unreal projects and engines beneath an
explicit root, measures regeneratable storage, resolves safety policy, builds a pressure-aware dry-run
plan, and showcases the same contract in CLI and Workbench.

## Decisions

- TypeScript + Effect owns the domain and IO workflow. A Rust worker is deferred until a benchmark
  demonstrates a native hot path worth the additional protocol and packaging surface.
- The first slice is read-only. No API in this plan deletes, trashes, renames, or moves a path.
- Scans are explicitly rooted and depth-bounded. Whole-machine indexed discovery is a later adapter.
- `.ueclean.json` is accepted as a compatibility-friendly project policy filename.

## Work

1. Define Effect Schema models for policies, projects, engines, targets, diagnostics, inventory, and
   the dry-run plan.
2. Implement pure target resolution with protected-path, symlink-containment, C++ binaries,
   autosave-age, engine-kind, and unknown-policy-key tests.
3. Implement bounded discovery, freshness measurement, unique-byte sizing, volume free-space
   measurement, concurrent scans, and largest-first planning.
4. Add `ue-shed custodian report <root>` and `ue-shed custodian plan <root>`.
5. Add validated Workbench IPC, a renderer client, and `#/project-custodian` with explicit root
   selection and report/plan presentation.
6. Document the product and fresh-clone showcase flow; run `pnpm check` immediately before handoff.

## Acceptance

- Authored paths and save games are unreachable from resolved targets.
- Symlinked targets that escape the named project are refused without aborting the rest of the scan.
- C++ project binaries remain protected by default.
- Autosaves require their independent 90-day grace period.
- Installed or unmarked engines never expose binaries/intermediate as reclaimable.
- Invalid project policy is visible and does not broaden authority.
- CLI and Workbench decode the same schema-owned result.
- The Workbench never starts Unreal to scan.
- `pnpm check` passes.

## STOP conditions

- Stop destructive work: applying a plan is not authorized by this plan.
- Stop and redesign if a client needs filesystem authority not represented in the public request.
- Stop rather than claim completion if the full repository gate is red.
