# Plan 024: Establish CI, Unreal evidence, and candidate-release provenance

> **Executor instructions**: Read docs/README.md and AGENTS.md first. Create automation only on a temporary or feature branch; main is frozen for judging. Never configure the self-hosted Windows runner to execute fork pull requests.
>
> **Drift check (run first)**: git diff --stat a1df704..HEAD -- .github package.json pnpm-lock.yaml scripts docs README.md

## Status

- **Priority**: P1
- **Effort**: L
- **Risk**: HIGH
- **Depends on**: Plans 020 and 021
- **Category**: dx
- **Planned at**: commit a1df704, 2026-07-22

## Why this matters

ElectroSwag cannot safely consume frequent UE Shed prereleases if a release is only a developer-machine result. Normal checks can run on inexpensive hosted machines, but Unreal plugin evidence needs the owner's Windows UE 5.7 machine. The release flow must make those two trust levels explicit while retaining reproducible artifacts and a human-reviewed downstream bump.

## Current state

- There is no .github workflow directory.
- package.json provides pnpm check for portable verification and pnpm check:unreal for engine-backed conformance and authoring checks.
- The local engine reference is C:\Program Files\Epic Games\UE_5.7, but code and fixtures must not depend on that path.
- Blacksmith is available for normal checks and Macroscope is an advisory code-review tool in the owner's workflow.
- Main is frozen until 2026-08-13. No workflow may auto-merge, push to, or target main during the freeze.

## Commands you will need

| Purpose                 | Command                                 | Expected on success                 |
| ----------------------- | --------------------------------------- | ----------------------------------- |
| Portable evidence       | pnpm check                              | Exit 0                              |
| Trusted engine evidence | pnpm check:unreal                       | Exit 0 on Windows UE 5.7 runner     |
| Workflow syntax         | actionlint .github/workflows            | Exit 0 when actionlint is installed |
| Package artifact check  | pnpm pack --pack-destination <temp-dir> | Candidate archives created          |

## Scope

**In scope**

- Hosted Blacksmith portable-check workflow.
- A separate manually dispatched or scheduled trusted Unreal workflow.
- Candidate release, checksum, artifact upload, npm trusted-publisher, and provenance workflow boundaries.
- Release runbook and Macroscope advisory setup guidance.

**Out of scope**

- A hosted Unreal machine, automatic downstream merge/release, or replacement of local tests.
- Secrets, SSH keys, or engine access for untrusted PR code.
- Any merge/push/PR target to main during the freeze.

## Steps

### Step 1: Add the hosted portable gate

Create a Blacksmith workflow for trusted branches and pull requests: locked pnpm install, pnpm check, rebuildable cache only, and artifact output for failures. Configure Macroscope separately as advisory initially.

**Verify**: a formatting break fails; a clean temporary branch passes pnpm check.

### Step 2: Add the trusted Unreal lane

Create a separate workflow triggered only by workflow_dispatch and optional schedule on trusted refs. Require runner group/labels self-hosted, Windows, ue57; use no secrets; upload engine version, plugin build output, fixture evidence, and pnpm check:unreal result. Document separate local user or VM and runner-group access.

**Verify**: manual trusted dispatch passes and no pull_request event can invoke the workflow.

### Step 3: Build candidates without publishing by default

A manual candidate version input runs the portable gate, builds packages/plugin artifacts, checksums them, and uploads one manifest. Add a protected human-approved publish job using npm trusted publishing OIDC and attestations; require a tag. Candidate and manifest dependencies must be exact, never latest/ranges.

**Verify**: a dry-run candidate produces named artifacts and checksums without publishing.

### Step 4: Document the two-repository handshake

Document: publish exact candidate; open downstream bump PR; run downstream portable checks and manual UE evidence; publish UE Shed stable; open a second exact stable bump. Future repository dispatch may open the PR, never merge it.

**Verify**: another reviewer can perform a dry run from the runbook and candidate artifacts.

## Test plan

- Hosted workflow invokes pnpm check.
- Trusted workflow cannot run from a fork PR and completes pnpm check:unreal on the owner machine.
- Candidate workflow emits checksummed artifacts; guarded publish refuses missing approval/tag/provenance.

## Done criteria

- [ ] Hosted portable gate is required release evidence.
- [ ] Unreal evidence is trusted, dispatch/schedule-only, and secret-free.
- [ ] Candidate manifest/artifacts/checksums are retained.
- [ ] Publish uses an explicit protected OIDC path.
- [ ] Exact-pin downstream handshake is documented.
- [ ] plans/README.md marks Plan 024 DONE.

## STOP conditions

- Runner configuration would execute public fork code.
- Runner needs persistent credentials.
- Plan 020 remains incomplete or pnpm check fails.
- Workflow would target main before the freeze ends.

## Maintenance notes

Treat the local Unreal runner as a scarce trusted release signal, not a PR test convenience. Keep the normal gate portable and inexpensive.
