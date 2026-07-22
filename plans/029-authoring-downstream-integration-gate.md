# Plan 029: Gate authoring integration behind finished generic slices

> **Executor instructions**: This is a readiness and thin-slice plan. The downstream authoring rewrite and UE Shed Plan 007 are both in progress. Do not start broad migration or duplicate contracts until prerequisites are complete, released, and accepted.
>
> **Drift check (run first)**: compare released authoring contract, UEShedAuthoring plugin manifest, completed Plan 007 result, and downstream host's active authoring service seams.

## Status

- **Priority**: P2
- **Effort**: L
- **Risk**: HIGH
- **Depends on**: Plans 007, 022, and 026
- **Category**: direction
- **Planned at**: commit a1df704, 2026-07-22

## Why this matters

The downstream host is farther along on authoring UX, but UE Shed's generic conflict resolution, rich types, composites, views, package contract, and plugin distribution remain unfinished. Premature deep integration would either make UE Shed depend on Electron state or freeze the rewrite around unstable APIs. The correct next move is a narrow released capability seam with explicit go/no-go evidence.

## Current state

- Plan 007 is IN PROGRESS after demo cutoff; it owns generic conflicts, rich types, composites, views, and release conformance.
- Authoring JSON Schemas are language-neutral authority; Effect, Rust, and C++ conform. Plan 022 makes public exceptions/parity explicit.
- UEShedAuthoring is delivered through Plan 026 manifest/installer.
- Downstream owns Electron UX, custom UI, session/state policy, and product workflow. It must never become an upstream dependency.

## Commands you will need

| Purpose             | Command                                        | Expected on success             |
| ------------------- | ---------------------------------------------- | ------------------------------- |
| Contract gate       | pnpm --filter @ue-shed/protocol contract:check | Exit 0                          |
| Portable evidence   | pnpm check                                     | Exit 0                          |
| Plugin evidence     | pnpm check:unreal                              | Exit 0 on trusted runner        |
| Downstream evidence | pnpm check                                     | Exit 0 in downstream repository |

## Scope

**In scope**

- A downstream decision record naming exact released contracts, packages, manifest, and one first workflow.
- One adapter at the downstream authoring-service boundary.
- Contract, recovery, engine, and upgrade acceptance for that workflow.
- Versioned upstream proposals for missing generic capability.

**Out of scope**

- Porting downstream UI/custom UI into UE Shed or embedding UE Shed extension UI in Electron.
- Replacing the downstream rewrite wholesale.
- Direct Remote Control calls to work around unreal-rc.
- Publishing authoring integration before Plan 007 and release evidence.

## Steps

### Step 1: Hold readiness review

Confirm Plan 007 is DONE, contract gate is green, public packages/UEShedAuthoring manifest are released, and downstream rewrite has a stable service boundary. Create compatibility matrix: discovery, snapshot, rich values, drafts, conflicts/recovery, apply results, plugin version. Mark supported/deferred/release-blocker.

**Verify**: first slice needs no unfinished Plan 007 item or undocumented host contract.

### Step 2: Choose smallest compatible vertical slice

Prefer read-only discovery/snapshot or one explicit draft/apply path with conflict/recovery evidence. Pin exact UE Shed versions/install matching manifest. Adapt released wire contract once; keep UI decisions local.

**Verify**: host adapter tests cover valid, invalid, stale, conflict, and indeterminate-operation cases.

### Step 3: Feed gaps upstream, never around it

If a generic contract or Remote Control capability is missing, stop integration and create a versioned upstream proposal. Implement/release it in UE Shed or unreal-rc with fixtures, then resume on a new exact pin.

**Verify**: every boundary operation has a released contract and no direct raw Remote Control fetch path.

## Done criteria

- [ ] Plan 007 and public authoring release evidence are complete.
- [ ] Downstream uses exact released package/plugin tuple.
- [ ] One thin workflow has contract, recovery, real-Unreal evidence.
- [ ] UX/policy remain downstream and UE Shed remains headless-first.
- [ ] No unreal-rc or language-neutral-contract workaround exists.

## STOP conditions

- Plan 007 or release conformance is incomplete.
- Required plugin/package is not a released compatible version.
- Slice needs custom UI hosting or undocumented authoring state.
- Published typed failure contract cannot represent the failure.

## Maintenance notes

Grow integration from proven generic seams, not from Electron UI outward. Keep compatibility matrix with every package/plugin release so both products evolve independently.
