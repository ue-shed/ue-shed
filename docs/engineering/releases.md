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

Through `1.0.0`, every public npm package and Unreal plugin descriptor shares one suite version.
Changesets records which packages changed directly, while its fixed group advances all public npm
packages to the highest requested SemVer impact. This keeps documentation, examples, plugin
artifacts, and downstream support statements on one recognizable release train.

When a public package changes, run:

```powershell
pnpm changeset
```

Select the directly affected public packages and the SemVer impact. Do not add unchanged packages
merely for alignment; the fixed suite group handles that automatically. Do not select private
applications, extensions, examples, or tooling. Exact internal workspace dependencies are handled
by Changesets. The protected allowlist in `scripts/pack-public-packages.ts` is the authoritative
public set; [the private-package ledger](private-packages.md) explains every excluded workspace.

`pnpm test:release` resolves the accumulated plan with Changesets libraries before its release
tests. This validates all notes without Git history or a local `main` ref, so mixed
private/public entries and other invalid release metadata fail the portable gate. Private workspace
changes may be described in a note, but only the directly affected public packages belong in its
release front matter.

Preview the accumulated release at any time:

```powershell
pnpm release:status
```

To prepare a release, start from a clean checkout and consume the committed changesets:

```powershell
pnpm install --frozen-lockfile
pnpm release:version
# review the version bump, changelogs and docs/releases/<version>.md, then commit them
pnpm release:prepare
```

`release:version` updates package manifests, exact internal dependency pins, changelogs, the
lockfile, Rust/native version metadata, generated artifact metadata, and Unreal plugin descriptors.
Review those changes and commit them as the release commit. Settle the release text (open the pull
request and let review finish) before the long gates where you can; a later changelog edit is cheap
anyway, as described below.

`pnpm release:prepare` runs every release gate for the committed release under one trace
(`scripts/release-gates.ts` lists them):

| Gate                                         | Command                                          | Inputs                                         |
| -------------------------------------------- | ------------------------------------------------ | ---------------------------------------------- |
| `release-text`                               | `format:check`, `test:release`                   | every file                                     |
| `check`                                      | `pnpm check`                                     | everything except changelogs and release notes |
| `pack`                                       | `release:pack:clean-check`, keeping the tarballs | everything except release notes                |
| `engine-matrix`                              | `test:uasset-engine-matrix` (UE 5.7 and 5.8)     | as `check`                                     |
| `unreal`                                     | `check:unreal`                                   | as `check`                                     |
| `plugins-5.7`, `plugins-5.8`, `plugins-4.27` | `test:unreal-plugins` on each engine             | as `check`                                     |

The portable gates run in this checkout, the pack in its own temporary worktree, and the Unreal
gates one after another in a second worktree of the same commit (`<checkout>-unreal`, kept between
releases so its dependencies and Unreal build output are reused). UnrealBuildTool writes one log file
shared by every installed engine, and the Unreal gates rebuild package output `pnpm check` reads, so
they neither overlap each other nor share a checkout with the check. `--serial` runs every gate in
this checkout, one after another. An engine that is not installed is recorded as unavailable, not
passed. Unreal gates write their evidence and build output under the lane checkout's `out`
directory, whose path must stay within 85 characters so UnrealBuildTool's paths below it stay
under Windows' 260-character limit; `--unreal-worktree <path>` moves the lane.

Each result is recorded in `out/release-evidence/<version>.json` with a fingerprint of the files its
gate depends on. A later `release:prepare` reuses every gate whose fingerprint still matches and
reruns only the rest; `--only <gates>` narrows the run and `--force` reruns regardless. After a
changelog-only edit, only `release-text` and `pack` run again; after a release-notes-only edit, only
`release-text`. Each run writes `out/release-prepare/<version>-<time>/` with the trace
(`trace.json`, for [Perfetto](https://ui.perfetto.dev)), one log per command, `report.html` (a lane
timeline, each gate's largest steps, where the time went and the slowest commands) and
`validation.md`, the release notes' Validation section. `--record` writes that section into
`docs/releases/<version>.md`; commit it with the release.

`release:pack:clean-check` packs the committed release in a temporary worktree with no prior build
output, which proves the pack step builds packages in workspace dependency order. With `--output`
it keeps the tarballs, checksums and publication manifest with a `pack-evidence.json` naming the
commit they came from. Commit the release before running it.

Unreal evidence is required when the release changes Unreal-facing behavior, native saved-asset
evidence, or plugin artifacts. For a portable-only release, `pnpm release --without-unreal
"<reason>"` records why it was omitted.

Published Effect libraries declare `effect` and runtime `@effect/*` integrations as required
`^4.0.0` peers, with `catalog:` dev dependencies for exact workspace development and tests.
Applications must install Effect once; consumers of `@ue-shed/observability` must also install
`@effect/opentelemetry`. Internal UE Shed package dependencies remain exact suite versions.
The packed-consumer gate supplies Effect 4.0.0 to verify the peer range independently of the
workspace catalog at 4.0.4 and checks that each library resolves the application's copy.

The normal package gate builds and packs every public package, validates metadata and checksums,
installs the tarballs into a clean offline consumer, and exercises the saved-project Game Text
journey. The protected public-package allowlist remains a conformance boundary; it prevents an
accidentally non-private workspace from being published, but it does not select the release.
The staged WASM package uses pnpm's publication manifest semantics without rerunning its build, and
the gate compares that complete tarball with a normal workspace `pnpm pack`. A digest difference is
a release failure even when the runtime payloads happen to match.
Primary development and release tooling runs on Node.js 26. Public packages generally declare
Node.js 22.14 as their minimum. Game Text requires Node 22.15+ in the 22.x line, or Node 23.8+,
because its compact index uses built-in Zstd APIs. The former hosted compatibility job incorrectly
attempted to build the Node 26 monorepo under Node 22 and was removed. A replacement must build
artifacts with Node 26, then exercise the packed consumer under each package's declared minimum.

Authenticate to npm outside the repository, then publish from the clean committed release:

```powershell
npm whoami
pnpm release
git push --tags
```

After `pnpm install`, `pnpm release` needs no per-session toolchain environment setup. The private
workspace pins Node 26 through `devEngines.runtime`; pnpm installs and selects that runtime for
scripts. Release reuses the invoking pnpm CLI. It builds nothing, so it needs no Rust. Release
builds share the main checkout's Cargo `target` directory unless `CARGO_TARGET_DIR` overrides it,
so a new release worktree reuses compiled dependencies.

`pnpm release` publishes only from recorded evidence. Every required gate must have passed (or, for
a plugin gate, recorded its engine as unavailable) on inputs whose fingerprint matches the clean
release HEAD; otherwise it lists the gates that are missing, failed or stale and refuses, and
`pnpm release:prepare` reruns just those. It reruns `release-text` itself when only the release
notes changed since that gate ran. It then verifies the kept pack: `pack-evidence.json` must name
the evidence commit and every tarball must still match its recorded SHA-256. The confirmation
prompt lists each gate's evidence. It pauses indefinitely there.
No npm request or 2FA challenge begins until the operator types the exact versioned phrase shown by
the prompt, for example `publish 0.5.2`. Blank input, buffered Enter, a different version, and any
other response abort publication. After confirmation it asks Changesets for the publish plan,
points each planned package at its validated tarball and runs `changeset publish --from-pack-dir`,
which publishes those exact tarballs with `pnpm publish <tarball>` (no lifecycle scripts, no
repacking) in dependency order and creates the package tags, with the same terminal attached for
immediate npm authentication. Stay with the terminal after confirming because npm authentication may be
time-limited. A new public package uses the same command. The command refuses non-interactive
publication. Before 1.0, use interactive 2FA or the narrowest short-lived granular write token and
revoke it after verification. Never put a token in a command, tracked `.npmrc`, release manifest, or
log. Local releases do not claim hosted OIDC provenance.

Verify the published package versions and `latest` dist-tags before announcing the release. Never
unpublish or rebuild an immutable version as recovery. See Changesets' [CLI
guide](https://changesets.dev/guide/cli), npm's [access-token
guidance](https://docs.npmjs.com/about-access-tokens/), and [two-factor authentication
requirements](https://docs.npmjs.com/about-two-factor-authentication/).

The initial stable `0.1.0` release promoted the original public packages from `0.1.0-rc.4` and added
`@ue-shed/game-text` plus World Log's headless `@ue-shed/map-history` boundary. Starting with
`0.2.0`, the entire protected public set advances together. A package can be republished solely to
retain suite alignment; its changeset and release notes must say when it has no direct behavioral
change.

## Local plugin artifacts

For each supported engine, run the plugin compatibility gate with an explicit installation and a
new evidence directory whose parent already exists:

```powershell
$env:UE_SHED_UNREAL_ENGINE_ROOT = "C:\Engines\UE_5.8"
pnpm test:unreal-plugins out/plugins-5.8-evidence
```

On UE5 this builds all twelve plugins and runs all 47 native automation tests, including Game Text,
Authoring canonical JSON, world preparation, camera authoring, rendering and restoration,
map minor-version compatibility, screenshot ownership, and Niagara camera automation with real
rendering in a disposable stock template project. Repeat for Unreal 5.7. The gate retains editor
logs and the automation report and rejects missing, failed, or incomplete tests. It supplements
`check:unreal`, whose saved-asset fixture contract remains on 5.7.

`pnpm test:unreal-game-text-actions <new-evidence-directory> --source-edits` runs the cross-version
commandlet lifecycle on a fresh disposable fixture: nine key repairs followed by nine source edits
across object properties, DataTable cells and Blueprint pins. Each phase checks dry-run bytes,
compile/save receipts, a fresh editor reload, the saved-package text reader and GatherText. UE5
loads the full bundle; UE4 loads the minimal Game Text bundle. Missing offline pin occurrences are
reported explicitly as skipped, even if the reader reports complete package coverage. Without
`--source-edits`, the UE5 command retains its separate Remote Control and String Table journey.

Build a portable plugin bundle into an empty directory, verify its manifest, and inspect the exact
selection before installation:

```powershell
node scripts/plugin-bundle.ts bundle --version <version> --output out/plugins
pnpm ue-shed plugins verify out/plugins/plugins.manifest.json
pnpm ue-shed plugins list out/plugins/plugins.manifest.json
pnpm ue-shed plugins install --project fixtures/unreal-project/UEShedFixture.uproject `
  --manifest out/plugins/plugins.manifest.json
```

For Map Review, select Core, World and Cameras:

```powershell
node scripts/plugin-bundle.ts bundle --version <version> `
  --output out/plugins-map-review --plugins UEShedCore,UEShedWorld,UEShedCameras
pnpm ue-shed plugins verify out/plugins-map-review/plugins.manifest.json
```

`pnpm release:plugins:map-review` now requires `--candidate-manifest`, `--commit`, and `--ref`; its
public integrity gate rejects local refs, placeholder digests, shortened commits, version drift,
missing assets, and digest drift. It prepares future GitHub Release assets named
`ue-shed-plugins-map-review-<version>.manifest.json` and
`ue-shed-plugins-map-review-<version>.tar.gz`. Publish them only from the exact reviewed future
release commit. Do not reconstruct or replace an existing immutable release, including the
source-only `0.4.0` package release. Trusted hosts consume
those assets through `@ue-shed/plugin-distribution`, which retains them in a caller-owned cache and
leases verified absolute descriptor paths without mutating a project.

Compiled variants are downstream build products, not a side effect of acquisition. See
[Plugin distribution](plugin-distribution.md) for the exact `plugins build` command, BuildId
contract, immutable variant naming, and hosting boundary. A public compiled artifact inherits a
fully pinned source manifest; output derived from `ref: "local"` or an all-zero candidate digest is
local evidence only and cannot pass the release gate.

For a headless Observatory host, select Observatory and its headless Core dependency:

```powershell
node scripts/plugin-bundle.ts bundle --version <version> `
  --output out/plugins-observatory --plugins UEShedCore,UEShedObservatory
pnpm ue-shed plugins verify out/plugins-observatory/plugins.manifest.json
```

For Niagara Preview, select only its separately enabled Editor plugin:

```powershell
pnpm release:plugins:niagara
pnpm ue-shed plugins verify out/releases/<version>/plugins-niagara/plugins.manifest.json
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

## Post-1.0 hosted release plan

Only the portable gate on GitHub-hosted Ubuntu 24.04 runners is checked in today. Trusted Unreal and
Candidate Release workflows were removed until their hosted designs are rewritten and exercised;
prose describing a future lane is not publication authority.

The planned hosted lane consists of:

1. The existing read-only GitHub Actions portable workflow running repository checks and conditional
   UAsset lanes on ephemeral GitHub-hosted Ubuntu 24.04 runners, aggregated into the `pnpm check` status.
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
