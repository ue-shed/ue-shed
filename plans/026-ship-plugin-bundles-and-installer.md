# Plan 026: Ship versioned plugin bundles through the CLI installer

> **Executor instructions**: Build source-compatible plugin bundles first. Do not use Git clone, submodules, or Fab as the installation contract. Every install is tied to one release manifest and checksum-verified artifact.
>
> **Drift check (run first)**: git diff --stat a1df704..HEAD -- apps/cli unreal/Plugins scripts package.json pnpm-lock.yaml docs README.md

## Status

- **Priority**: P1
- **Effort**: L
- **Risk**: HIGH
- **Depends on**: Plans 023, 024, and 025
- **Category**: migration
- **Planned at**: commit a1df704, 2026-07-22

## Why this matters

npm is appropriate for Node packages, not raw Unreal source/binaries. A checksummed release artifact plus CLI installer gives projects a reproducible plugin graph, works for custom/source engines, and leaves prebuilt bundles for later. Fab can become a discovery channel, never the dependency baseline.

## Current state

- Unreal plugins live under unreal/Plugins: UEShedCore, UEShedAuthoring, UEShedCameras, UEShedObservatory, UEShedAssetAudits, and UEShedScenarios.
- apps/cli has an internal ue-shed command but no public installer contract.
- There is no plugin manifest, checksum, project installation, upgrade, or artifact release model.
- Map Review needs declared Core and Cameras plugins; authoring needs its own explicit graph.

## Commands you will need

| Purpose             | Command                                                                   | Expected on success                         |
| ------------------- | ------------------------------------------------------------------------- | ------------------------------------------- |
| Build source bundle | <release script> plugins bundle                                           | Archive and manifest created                |
| Install fixture     | ueshed plugins install --project <fixture-uproject> --manifest <manifest> | Plugins appear under Project/Plugins/UEShed |
| Portable gate       | pnpm check                                                                | Exit 0                                      |
| Engine evidence     | pnpm check:unreal                                                         | Exit 0 on trusted UE 5.7 runner             |

## Scope

**In scope**

- Versioned source bundle from unreal/Plugins.
- plugins.manifest.json with release version, plugin graph, UE range, artifact identity, size, checksum, and provenance.
- Public @ue-shed/cli install, verify, and list commands.
- Atomic installation under Project/Plugins/UEShed; deliberate uproject enablement; fixture install/upgrade/integrity tests.
- Candidate release integration and docs.

**Out of scope**

- Fab publishing, prebuilt UAT bundles, silent overwrite of modified plugins, Engine/Plugins installation, and global engine assumptions.

## Steps

### Step 1: Define and validate the manifest

Specify a versioned manifest with graph, descriptor versions, UE compatibility, checksums, and provenance tied to the package candidate manifest. Validate it at the CLI boundary.

**Verify**: invalid checksum, missing dependency, cyclic graph, and unsupported UE fixtures are rejected with recovery guidance.

### Step 2: Build a portable source bundle

Produce deterministic archives containing tracked source, descriptors, necessary resources/license/provenance only. Exclude Intermediate, Binaries, local project settings, and source-engine paths. Upload bundle/manifest with the candidate release.

**Verify**: archive contains every declared plugin and no Intermediate/Binaries directory.

### Step 3: Implement deliberate installation

Validate project path, manifest, checksum, and graph before extraction. Install atomically below Project/Plugins/UEShed; write ownership/version record; update uproject plugin list without disturbing unrelated entries. Refuse modified installer-owned files and explain recovery.

**Verify**: clean install works, exact re-install is idempotent, modified plugin safely refuses.

### Step 4: Prove engine and upgrade evidence

Open/build the fixture project with the installed source bundle on the trusted UE 5.7 runner. Test manifest-to-manifest upgrade and removal only when ownership records prove installer ownership.

**Verify**: pnpm check:unreal passes after fresh install and supported upgrade.

## Test plan

- Manifest fixtures for graph/compatibility failures.
- CLI tests for local artifact, checksum mismatch, clean install, idempotency, modified-file protection, and descriptor preservation.
- Trusted Unreal lane opens/builds installed source.

## Done criteria

- [ ] One manifest ties plugin graph/artifact to matching package versions.
- [ ] CLI install is atomic, project-scoped, and recoverable.
- [ ] Fresh install/upgrade have trusted Unreal evidence.
- [ ] Source bundle works with custom/source engines and no Git.
- [ ] pnpm check and trusted pnpm check:unreal exit 0.
- [ ] plans/README.md marks Plan 026 DONE.

## STOP conditions

- Plugin needs an undeclared project/engine dependency.
- Installer must overwrite unknown user files.
- Artifact cannot be checked before extraction.
- Bundle only works because of a local machine path.

## Maintenance notes

When prebuilt artifacts arrive, publish a distinct UE-version/platform artifact in the same manifest. Keep source bundles as the compatibility fallback and Fab optional.
