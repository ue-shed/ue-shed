# Release evidence and downstream handoff

UE Shed separates portable checks, trusted Unreal evidence, candidate construction, and publication.
No release process merges code or updates a downstream repository. Publication always requires an
exact reviewed version, an exact source commit, and explicit human approval.

## Policy through and after 1.0

**Through and including `1.0.0`, releases are built and published from the trusted local Windows
development machine.** GitHub-hosted builders, the self-hosted Trusted Unreal runner, protected
environments, OIDC publication, and hosted provenance are a post-1.0 plan. They are not prerequisites
for any `0.x` release or for `1.0.0` itself.

Starting with the first release after `1.0.0`, UE Shed intends to move publication to the GitHub
trust lanes described at the end of this document. That migration is not complete merely because
workflow files exist. The hosted lane becomes authoritative only after its runners, npm trusted
publishers, protected environments, and recovery procedure have all been exercised successfully.

Until then:

- `pnpm check` on the trusted local machine is the portable release gate;
- `pnpm check:unreal` on that machine supplies trusted Unreal evidence when a release touches Unreal
  behavior or plugin artifacts;
- local candidate manifests, checksums, and packed-consumer tests are the release evidence;
- npm publication uses interactive 2FA or a short-lived granular write token configured outside the
  repository;
- local releases do not claim npm OIDC provenance.

## Pre-1.0 local release lane

Public npm packages are independently versioned with Changesets. Package selection belongs in a
small Markdown changeset committed with the implementation, not in a release-time feature list or
custom bundle command.

When a public package changes, run:

```powershell
pnpm changeset
```

Select the directly affected public packages and the SemVer impact. Do not select private
applications, extensions, examples, or tooling. Exact internal workspace dependencies are handled
by Changesets: if a dependency moves out of range, the affected public dependent receives the
required patch release. The native launcher, Windows artifact, and WASM package form one fixed
version group because they share the Rust release line.

Preview the accumulated release at any time:

```powershell
pnpm release:status
```

To prepare a release, start from a clean checkout and consume the committed changesets:

```powershell
pnpm install --frozen-lockfile
pnpm release:version
pnpm check
pnpm check:unreal
```

`release:version` updates package manifests, exact internal dependency pins, changelogs, the
lockfile, and the Rust/native version metadata. Review those changes and commit them as the release
commit. `pnpm check:unreal` is required when the release changes Unreal-facing behavior, native
saved-asset evidence, or plugin artifacts. For a portable-only release, record why it was omitted.

The normal package gate builds and packs every public package, validates metadata and checksums,
installs the tarballs into a clean offline consumer, and exercises the saved-project Game Text
journey. The protected public-package allowlist remains a conformance boundary; it prevents an
accidentally non-private workspace from being published, but it does not select the release.
Primary development and release tooling runs on Node.js 26. A separate portable CI lane installs
the packed public artifacts and runs their consumer journeys on Node.js 22.14, the declared minimum
for those packages.

Authenticate to npm outside the repository, then publish from the clean committed release:

```powershell
npm whoami
pnpm release
git push --tags
```

`pnpm release` reruns the complete gate and delegates dependency-ordered publication and package
tag creation to Changesets. A new public package uses the same command. Before 1.0, use interactive
2FA or the narrowest short-lived granular write token and revoke it after verification. Never put a
token in a command, tracked `.npmrc`, release manifest, or log. Local releases do not claim hosted
OIDC provenance.

Verify the published package versions and `latest` dist-tags before announcing the release. Never
unpublish or rebuild an immutable version as recovery. See Changesets' [CLI
guide](https://changesets.dev/guide/cli), npm's [access-token
guidance](https://docs.npmjs.com/about-access-tokens/), and [two-factor authentication
requirements](https://docs.npmjs.com/about-two-factor-authentication/).

The initial stable `0.1.0` release promotes the existing public packages from `0.1.0-rc.4` and adds
`@ue-shed/game-text` plus World Log's headless `@ue-shed/map-history` boundary. Later Texture Audit
or other public features follow the same flow and release only themselves plus genuinely affected
dependencies.

## Local plugin artifacts

Build a portable plugin bundle into an empty directory, verify its manifest, and inspect the exact
selection before installation:

```powershell
node scripts/plugin-bundle.ts bundle --version <version> --output out/plugins
pnpm ue-shed plugins verify out/plugins/plugins.manifest.json
pnpm ue-shed plugins list out/plugins/plugins.manifest.json
pnpm ue-shed plugins install --project fixtures/unreal-project/UEShedFixture.uproject `
  --manifest out/plugins/plugins.manifest.json
```

For Map Review, select only Core and Cameras:

```powershell
node scripts/plugin-bundle.ts bundle --version <version> `
  --output out/plugins-map-review --plugins UEShedCore,UEShedCameras
pnpm ue-shed plugins verify out/plugins-map-review/plugins.manifest.json
```

For a headless Observatory host, select only Observatory:

```powershell
node scripts/plugin-bundle.ts bundle --version <version> `
  --output out/plugins-observatory --plugins UEShedObservatory
pnpm ue-shed plugins verify out/plugins-observatory/plugins.manifest.json
```

Installation is project-scoped under `Plugins/UEShed`. It refuses checksum failures, unsupported
graphs, modified installer-owned files, and unrelated existing content at that destination. Game
Text requires no Unreal plugin.

## Two-repository handshake

1. Publish the exact UE Shed candidate locally after portable and applicable trusted Unreal evidence
   are reviewed.
2. Open a downstream pull request pinning that exact candidate version or artifact digest. Never use
   `latest`, a range, a branch, or an unverified workflow artifact.
3. Run downstream portable checks and its manually approved Unreal evidence against the pin.
4. Publish the reviewed UE Shed stable release locally from the exact stable commit and tag.
5. Open a second downstream pull request replacing the candidate pin with the exact stable version
   or digest, then repeat downstream verification.

No automation may approve, merge, publish, or silently change the selected downstream version.

## Post-1.0 GitHub release plan

The checked-in GitHub workflows record the intended release architecture after `1.0.0`; they are not
the current publication authority.

The planned hosted lane consists of:

1. A read-only portable workflow running `pnpm check` on an ephemeral hosted runner.
2. A separately protected Trusted Unreal workflow on a dedicated non-administrator Windows runner
   with Unreal Engine 5.7, no npm token, and no unrelated editor process.
3. Candidate construction on GitHub-hosted Windows from an exact protected tag.
4. Checksummed artifact and source attestations.
5. Publication on GitHub-hosted Ubuntu through npm trusted publishing and OIDC, with no
   `NODE_AUTH_TOKEN` or `NPM_TOKEN` present.
6. Protected human approval, exact registry-integrity reconciliation, and retry-safe partial-release
   recovery.

Before this lane replaces local publication, it must complete successful dry runs and one protected
release rehearsal from the canonical repository. Every public npm package must have the exact
workflow configured as its trusted publisher, the environments must require reviewers, and the
published recovery procedure must be tested. A workflow file, neutral check, or unexercised runner
does not satisfy that gate.

New packages in the post-1.0 lane may require a one-time protected bootstrap because npm cannot
configure a trusted publisher before the package exists. That future bootstrap must publish only an
explicitly allowlisted package with a narrow short-lived token, record a manual handoff, configure
and verify the package's trusted publisher, and revoke the token before normal OIDC publication.

When the hosted lane becomes authoritative, update this document in the same reviewed change: move
the local token lane to emergency recovery, name the proven workflows and environments, and require
hosted provenance for normal releases. See npm's
[trusted-publisher documentation](https://docs.npmjs.com/trusted-publishers/) and
[provenance documentation](https://docs.npmjs.com/generating-provenance-statements/) for that future
lane.
