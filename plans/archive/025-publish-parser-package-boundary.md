# Plan 025: Publish the minimal parser and protocol package boundary

> **Executor instructions**: Do not turn every workspace package public. Build and test only the headless surface below from packed artifacts in a clean consumer directory. Use exact versions.
>
> **Drift check (run first)**: git diff --stat a1df704..HEAD -- apps/cli crates/uasset-parser packages/protocol packages/unreal-assets package.json pnpm-workspace.yaml pnpm-lock.yaml scripts docs README.md

## Status

- **State**: DONE — `0.1.0-rc.1` published and verified from the public npm registry
- **Priority**: P1
- **Effort**: L
- **Risk**: HIGH
- **Depends on**: Plans 022, 023, and 024
- **Category**: migration
- **Planned at**: commit a1df704, 2026-07-22

## Why this matters

The first downstream integration needs saved-asset parsing, its stable inspection contract, and an executable. It does not need Workbench, extensions, authoring mutation, or a monorepo checkout. A minimal headless package boundary makes the dependency one-way and creates a versioned compatibility point.

## Current state

- crates/uasset-parser owns the Rust parser; root scripts expose uasset:build and uasset:check.
- packages/unreal-assets exposes inspection models but is private and currently exports src directly.
- apps/cli is private @ue-shed/cli; it contains the ue-shed command, not a separately installable uasset launcher.
- packages/protocol is private but owns public wire schema/conformance.
- There is no packing, provenance, clean-consumer, or public-version story.

## Commands you will need

| Purpose          | Command                                      | Expected on success            |
| ---------------- | -------------------------------------------- | ------------------------------ |
| Rust gate        | pnpm uasset:check                            | Exit 0                         |
| Build parser     | pnpm uasset:build                            | Release executable produced    |
| Build archives   | pnpm pack --pack-destination <temp-dir>      | Selected archives created      |
| Consumer install | pnpm --dir <temp-consumer> install --offline | Only packed archives installed |
| Full gate        | pnpm check                                   | Exit 0                         |

## Scope

**In scope**

- @ue-shed/protocol public package.
- @ue-shed/unreal-assets public library package.
- @ue-shed/uasset launcher and @ue-shed/uasset-win32-x64 platform executable package.
- Export maps, build/package scripts, exact versions, package docs, and a packed-artifact consumer conformance test.

**Out of scope**

- Workbench, extensions, UI/service package publication.
- macOS/Linux binaries in the first Windows x64 release.
- Parser format changes or downstream-host dependencies.

## Steps

### Step 1: Freeze the small public API

Document exports, supported assets, input/error behavior, Node and contract version. Make unstable internal modules unavailable through exports. Assign explicit 0.x semantic versions.

**Verify**: a TypeScript consumer imports documented entry points without workspace paths.

### Step 2: Split launcher from platform artifact

Create a launcher bin package and a Windows x64 binary package containing only the matching parser executable/metadata. Select platform deterministically with no runtime download; unsupported platforms receive a typed actionable error.

**Verify**: uasset --version from a packed Windows consumer uses the packaged binary, not target or a sibling checkout.

### Step 3: Make packing a gate

Build Rust once, assemble deterministic archives, generate checksums, then install those archives into a clean temporary consumer. That consumer imports the library and inspects DT_Scalars with the installed CLI. Pin all dependencies exactly.

**Verify**: clean consumer passes after the workspace and target path are unavailable.

### Step 4: Connect packages to candidates

Teach Plan 024 candidate release to upload these archives and their exact manifest. Only selected packages can enter the protected npm publish job; prereleases use explicit prerelease versions.

**Verify**: npm publish --dry-run succeeds for each selected archive and no unrelated workspace package is selected.

## Test plan

- Packed library import and CLI execution.
- Unsupported platform error.
- Fixture inspection through packaged uasset.
- Archive-content test excludes worktrees, dev modules, and unpromised fixtures.

## Done criteria

- [x] The four package roles have documented public names and versioned archives.
- [x] A clean consumer works from packed artifacts only.
- [x] Platform resolution never falls back to local paths.
- [x] Candidate manifest has exact versions and checksums.
- [x] pnpm uasset:check and pnpm check exit 0.
- [x] plans/README.md marks Plan 025 DONE.

## STOP conditions

- A consumer requires an unpublished internal workspace package.
- Export design exposes Workbench/extension API.
- The binary cannot run from a packed platform package.
- Clean install resolves workspace links or local files.

## Maintenance notes

Add platforms only with reproducible builds and clean-consumer tests. Breaking parser contracts require an explicit version decision, never a silent binary replacement.
