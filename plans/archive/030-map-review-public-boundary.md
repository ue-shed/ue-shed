# Plan 030: Prepare the Map Review headless package boundary

> **Executor instructions**: Read docs/README.md, AGENTS.md, docs/engineering/releases.md, Plan
> 024, Plan 028, and archived Plans 019/022/025/026 first. Do not tag, push, publish, dispatch
> workflows, target `main`, or mark Plans 024/028 DONE. Preserve protected OIDC publication and the
> 2026-08-13 freeze language. If a required generic contract is missing, leave this plan
> IN PROGRESS with a precise blocker instead of inventing API.
>
> **Drift check (run first)**: git diff --stat f675d53..HEAD -- packages/cameras
> packages/unreal-connection packages/protocol packages/observatory packages/observability
> packages/plugin-bundles scripts/pack-public-packages.mjs scripts/test-public-packages.mjs
> scripts/plugin-bundle.mjs scripts/create-release-candidate.mjs .github/workflows/candidate-release.yml
> docs/engineering/releases.md docs/products/map-review.md unreal/Plugins/UEShedCameras package.json
> plans/028-compose-map-review-downstream.md

## Status

- **Status**: DONE on 2026-07-23 — constructed and verified the Map Review public npm +
  Core/Cameras plugin selection boundary at exact `0.1.0-rc.2` without publication
- **Priority**: P1
- **Effort**: M
- **Risk**: HIGH
- **Depends on**: Plans 017, 018, 019, 022, 025, and 026
- **Category**: migration
- **Planned at**: commit f675d53, 2026-07-23

## Why this matters

Plan 028 cannot compose Map Review downstream until released headless packages and an exact
Core+Cameras plugin graph exist. Plan 025 published only the parser/protocol slice. Cameras and its
required connection dependency remain private source exports, so a clean offline consumer cannot
install the Map Review vertical flow at the current candidate version.

## Current state

- Public npm allowlist is exactly `@ue-shed/protocol`, `@ue-shed/uasset-win32-x64`,
  `@ue-shed/unreal-assets`, and `@ue-shed/uasset` at `0.1.0-rc.2`.
- `@ue-shed/cameras` and `@ue-shed/unreal-connection` are private, version `0.0.0`, and export `src`
  directly through workspace protocols.
- `@ue-shed/cameras` depends only on `@ue-shed/protocol` and `@ue-shed/unreal-connection` (plus
  Effect). It does not import `@ue-shed/observatory` or `@ue-shed/observability`.
- Plan 019's USOT v1 transform wire contract already lives under
  `packages/protocol/contracts/observatory/v1`. Observatory package APIs remain monorepo-local.
- Plan 028's first vertical flow is select → frame → capture → artifact/recovery with Core/Cameras
  plugins only; World Scout streaming is not that first vertical.
- Plugin bundling can request a subset via `--plugins`, but `UEShedCameras.uplugin` does not declare
  `UEShedCore`, so a Core+Cameras product graph is not enforced by descriptor dependencies.
- Candidate publish dry-run/OIDC allowlists and release docs still describe the Plan 025 set only.
- The 2026-08-13 freeze still blocks landing workflows on `main`; Plan 024 remains activation-gated.

## Decision: defer Observatory / observability publication

`@ue-shed/observatory` and `@ue-shed/observability` remain private for this Map Review
release-readiness slice.

Evidence to weigh:

1. Plan 019's durable cross-language promise for transform streaming is the USOT binary contract in
   protocol, not an npm package publication checklist.
2. `@ue-shed/cameras` has zero dependency edges into observatory/observability.
3. Plan 028's first vertical installs only Core/Cameras and consumes cameras/protocol contracts.
4. Publishing observability would drag OpenTelemetry SDK packages into the Map Review consumer graph
   without being required by that vertical.

Record the decision in this plan, `docs/engineering/releases.md`, and `docs/products/map-review.md`.

## Commands you will need

| Purpose                 | Command                                                                                                          | Expected on success                                       |
| ----------------------- | ---------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------- |
| Focused pack evidence   | `pnpm test:release:packages`                                                                                     | Exit 0; offline consumer imports cameras/review-contracts |
| Focused release tests   | `pnpm test:release`                                                                                              | Exit 0; Core+Cameras selection proven                     |
| Package builds          | `pnpm --filter @ue-shed/unreal-connection --filter @ue-shed/cameras build`                                       | `dist/` emitted                                           |
| Map Review plugin graph | `node scripts/plugin-bundle.mjs bundle --version 0.1.0-rc.2 --output <empty> --plugins UEShedCore,UEShedCameras` | Manifest contains only Core+Cameras                       |
| Full portable gate      | `pnpm check`                                                                                                     | Exit 0                                                    |

## Scope

**In scope**

- Make `@ue-shed/unreal-connection` and `@ue-shed/cameras` constructible public packages at exact
  `0.1.0-rc.2`, with production `dist` exports, MIT metadata/license/READMEs, and exact non-workspace
  packed dependencies.
- Extend pack/create/publish allowlists, deterministic graph validation, and clean offline consumer
  evidence to exercise real Map Review schema/service exports.
- Enforce selectable Core+Cameras plugin graph without requiring Observatory, Authoring, Asset Audits,
  Workbench, or extension UI.
- Document the Observatory/observability publicity decision and keep freeze/OIDC language intact.

**Out of scope**

- Tagging, pushing, publishing, workflow dispatch, or targeting `main`.
- Claiming Plan 024 or Plan 028 DONE.
- Publishing `@ue-shed/observatory`, `@ue-shed/observability`, Workbench, extensions, CLI, or UI.
- Inventing missing generic Map Review contracts.
- Changing USOT wire layout or Observatory runtime behavior.

## Steps

### Step 1: Freeze the Map Review public package graph

Promote `@ue-shed/unreal-connection` and `@ue-shed/cameras` to the Plan 025 packaging pattern:
version `0.1.0-rc.2`, MIT, repository metadata, `dist` exports (including
`@ue-shed/cameras/review-contracts`), exact peer/runtime dependency pins after pack, and no
workspace/catalog/file protocols in packed manifests.

**Verify**: packed manifests reject local protocols; exports resolve from `dist`.

### Step 2: Decide Observatory / observability publicity

Using the evidence above, document whether those packages must join the allowlist now. Prefer
deferral when Plan 028's first vertical and cameras' dependency closure do not require them and USOT
v1 already ships in protocol.

**Verify**: decision is explicit in this plan and matching docs; pack allowlist matches the
decision.

### Step 3: Extend candidate pack/create/publish allowlists

Update `PUBLIC_PACKAGES`, graph validation, offline consumer conformance, candidate workflow dry-run
and OIDC publish arrays, and release docs so accidental extra public packages still fail and the new
packages are included in construction/validation. Do not publish.

**Verify**: `pnpm test:release:packages` installs only packed tarballs offline and imports Map Review
exports.

### Step 4: Make Core+Cameras selectable and explicit

Declare `UEShedCore` as a dependency of `UEShedCameras`, prove `--plugins UEShedCore,UEShedCameras`
produces a valid graph that excludes Observatory/UI packages, and document the Map Review install
selection. Candidate full-plugin artifacts may still include other plugins; Map Review consumers must
be able to select Core+Cameras only.

**Verify**: focused plugin-bundle test and docs show Core+Cameras without Workbench UI requirement.

### Step 5: Gate and hand back without release claims

Run focused pack/release tests and `pnpm check`. Update this plan and `plans/README.md`. Leave Plans
024/028 unchanged except notes that this boundary unblocks later composition/publication work.

**Verify**: checks pass; no tag/push/publish/dispatch occurred.

## Test plan

- Packed `@ue-shed/unreal-connection` and `@ue-shed/cameras` validate like Plan 025 packages.
- Exact graph pins: cameras → unreal-connection → protocol; no observatory/observability edge.
- Clean offline consumer imports protocol, unreal-connection, cameras root, and
  `cameras/review-contracts`, and exercises schema/service exports.
- Plugin bundle with Core+Cameras only validates and excludes Observatory.
- Candidate workflow allowlists include the new tarballs in dependency-safe order.
- `pnpm check` remains green.

## Done criteria

- [x] `@ue-shed/cameras` plus required public dependency closure are constructible at `0.1.0-rc.2`.
- [x] Observatory/observability publicity decision is documented with evidence.
- [x] Pack/create/publish allowlists and offline consumer evidence cover Map Review exports.
- [x] Core+Cameras plugin selection works without silently requiring Workbench UI.
- [x] Protected OIDC and freeze language remain intact; no publication occurred.
- [x] Focused pack/release tests and `pnpm check` exit 0.
- [x] Plans 024 and 028 are not marked DONE by this work.

## STOP conditions

- A required generic Map Review contract/export is missing and would need invention.
- Cameras cannot pack without pulling Workbench, extension UI, or an unpublished workspace package.
- Observatory/observability must be public for the Plan 028 first vertical, but cannot be made
  constructible within this bounded slice.
- Workflow/docs changes would weaken OIDC, attestation, or freeze wording.
- Implementation would require tagging, pushing, publishing, or targeting `main`.

## Maintenance notes

Add future Map Review surfaces (World Scout host package, observability helpers) only with their own
exact dependency closure, offline consumer evidence, and an explicit allowlist change. Do not grow
the public set by proximity inside the monorepo.
