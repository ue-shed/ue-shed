# Plan 021: Consume the published unreal-rc 0.5.3 dependency

> **Executor instructions**: Replace the temporary tarball only after the owner confirms unreal-rc 0.5.3 is available from npm. Run every verification command and update the plan index when done.
>
> **Drift check (run first)**: git diff --stat a1df704..HEAD -- packages/unreal-connection package.json pnpm-lock.yaml extensions/data-authoring/adoption.manifest.json

## Status

- **Priority**: P0
- **Effort**: S
- **Risk**: LOW
- **Depends on**: Plan 020
- **Category**: migration
- **Planned at**: commit a1df704, 2026-07-22

## Why this matters

UE Shed now delegates Remote Control transport behavior to unreal-rc. It temporarily vendors an unreleased tarball because the upstream client needed to preserve explicit transaction false. Public UE Shed packages must resolve the maintained published version, not a local bridge artifact.

## Current state

- packages/unreal-connection/package.json uses file:vendor/unreal-rc-0.5.2-rc.0.tgz.
- packages/unreal-connection/vendor/README.md records that bridge and says to replace it after publication.
- extensions/data-authoring/adoption.manifest.json copies the tarball into the materialized kit.
- The upstream release was prepared as unreal-rc core 0.5.3. This plan does not publish it.
- The adapter must retain explicit retry false and transaction false behavior. A raw-fetch fallback is not acceptable.

## Commands you will need

| Purpose          | Command                                     | Expected on success     |
| ---------------- | ------------------------------------------- | ----------------------- |
| Confirm release  | npm view unreal-rc@0.5.3 version            | Prints 0.5.3            |
| Refresh lockfile | pnpm install --frozen-lockfile=false        | Exit 0                  |
| Adapter tests    | pnpm test -- packages/unreal-connection/src | All selected tests pass |
| Full gate        | pnpm check                                  | Exit 0                  |

## Scope

**In scope**

- packages/unreal-connection/package.json
- packages/unreal-connection/vendor and its README
- pnpm-lock.yaml
- extensions/data-authoring/adoption.manifest.json and its adoption test

**Out of scope**

- Rewriting the Remote Control adapter or its API.
- Publishing unreal-rc or changing its repository.
- Direct HTTP workarounds for missing unreal-rc capability.

## Steps

### Step 1: Confirm the exact artifact

Query npm for exactly 0.5.3. Inspect published metadata; do not treat a local checkout as proof of publication.

**Verify**: npm view unreal-rc@0.5.3 version prints exactly 0.5.3.

### Step 2: Replace the bridge

Pin unreal-rc to exact 0.5.3, refresh pnpm-lock, remove the tarball and its adoption-manifest copy, then remove or rewrite the vendor README so it cannot imply a supported vendor path.

**Verify**: rg -n unreal-rc-0.5.2-rc.0 returns no matches outside Git history.

### Step 3: Preserve transport semantics

Run focused adapter tests and inspect their request assertions: transaction false must emit generateTransaction false and retries must remain disabled.

**Verify**: adapter tests and pnpm check pass.

## Test plan

- Existing request-shape tests cover explicit false transactions and disabled retries.
- Adoption materialization still passes after its copied closure changes.
- Full portable gate passes.

## Done criteria

- [ ] Registry dependency is exact unreal-rc 0.5.3, not a range or file path.
- [ ] Tarball and adoption-manifest copy are absent.
- [ ] Focused transport tests pass.
- [ ] pnpm check exits 0.
- [ ] plans/README.md marks Plan 021 DONE.

## STOP conditions

- npm does not return exactly 0.5.3.
- Published 0.5.3 lacks explicit false transaction behavior.
- Replacement requires a raw-fetch workaround.
- Adoption cannot express the new dependency cleanly.

## Maintenance notes

Remote Control gaps belong in unreal-rc first. Upgrade UE Shed only after a released upstream version and pin exact tested versions.
