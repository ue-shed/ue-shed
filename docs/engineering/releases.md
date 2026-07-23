# Release evidence and downstream handoff

UE Shed separates portable checks, trusted Unreal evidence, candidate construction, and publication.
No workflow merges code or updates a downstream repository. Candidate publication always requires
an exact protected tag and explicit human approval.

GitHub accepts manual dispatches and schedules only after a workflow exists on the default branch.
Plan 024 remains in progress until the workflows complete their first protected hosted and trusted
runs from the canonical repository.

## Trust lanes

The `Portable` workflow runs `pnpm check` on an ephemeral Blacksmith Ubuntu runner. It receives only
read access to repository contents, persists no checkout credential, and caches only rebuildable
dependencies. Configure the repository's required checks so `pnpm check` is required on protected
integration branches. Macroscope remains advisory: install its GitHub App for this repository and
trigger an on-demand review with `@macroscope-app review`; do not make its neutral check result a
release substitute.

The `Trusted Unreal` workflow is independent and has no `pull_request` trigger. Register a dedicated
Windows runner under a non-administrator local account with the labels `self-hosted`, `Windows`,
`X64`, and `ue57`, then place it in the `trusted-unreal` runner group. Restrict that group to the
`trusted-unreal.yml` workflow. Protect the `trusted-unreal` environment with required reviewers and
allow only trusted refs. The runner must contain Unreal Engine 5.7 and Visual Studio's Unreal C++
workload, but no npm token, SSH key, cloud credential, or source-control credential.

Before dispatch, make sure no unrelated Unreal Editor process is running. The workflow launches the
generic fixture, runs `pnpm check:unreal`, records the engine and runner identity, uploads plugin
binaries and logs, and stops only editor processes that appeared during the run. Scheduled runs use
the default branch's checked-in workflow and the same protected environment.

## Dry-run a candidate

Use an exact prerelease version and, when available, the exact successful Trusted Unreal run ID:

1. Dispatch `Candidate Release` on the reviewed protected ref.
2. Enter a version such as `0.1.0-rc.1` and leave `publish` disabled.
3. Enter the numeric Unreal run ID to bind its evidence into the candidate. Omitting it is allowed
   only for a portable dry run and is represented as `null` in the manifest.
4. Download `ue-shed-<version>` and verify `SHA256SUMS`.
5. Inspect `candidate-manifest.json`: the source commit, ref, pnpm version, lockfile digest, evidence
   run, and every artifact digest must be exact. The candidate's `plugins/plugins.manifest.json`
   must bind the plugin graph and source archive to the exact `npm/packages-manifest.json` digest.
6. Verify GitHub's provenance attestation with `gh attestation verify` before promoting an artifact.

The candidate always contains immutable source and checksummed plugin-source artifacts. Its npm allowlist is
exactly `@ue-shed/protocol`, `@ue-shed/uasset-win32-x64`, `@ue-shed/unreal-assets`, and
`@ue-shed/uasset`; candidate construction fails if another workspace becomes public accidentally.
The Windows candidate job builds the native parser once, validates the packed manifests and
checksums, installs the tarballs into a clean offline consumer, and dry-runs all four publications.

For a local artifact-only dry run:

```powershell
$commit = git rev-parse HEAD
$branch = git branch --show-current
node scripts/create-release-candidate.mjs --version 0.1.0-rc.1 --commit $commit `
  --ref "refs/heads/$branch" --output out/candidate
```

Use a clean checkout of the exact requested commit and a new empty output directory for every run.
The script rejects commit/worktree drift and will not overwrite an existing candidate.

To build only the portable plugin bundle locally, use an empty output directory and then verify the
generated manifest before extraction:

```powershell
node scripts/plugin-bundle.mjs bundle --version 0.1.0-rc.1 --output out/plugins
pnpm ue-shed plugins verify out/plugins/plugins.manifest.json
pnpm ue-shed plugins list out/plugins/plugins.manifest.json
pnpm ue-shed plugins install --project fixtures/unreal-project/UEShedFixture.uproject `
  --manifest out/plugins/plugins.manifest.json
```

Installation is project-scoped under `Plugins/UEShed`. It refuses checksum failures, unsupported
graphs, modified installer-owned files, and unrelated existing content at that destination.

The initial `0.1.0-rc.1` publication bootstraps the packages before npm trusted publishers can be
configured. From a clean reviewed checkout on Windows, run `pnpm check`, then
`pnpm release:pack`. Authenticate with the public npm registry and publish the immutable tarballs in
this order, always retaining the `next` dist-tag:

```powershell
npm whoami --registry https://registry.npmjs.org
npm publish out/releases/0.1.0-rc.1/ue-shed-protocol-0.1.0-rc.1.tgz --access public --tag next
npm publish out/releases/0.1.0-rc.1/ue-shed-uasset-win32-x64-0.1.0-rc.1.tgz --access public --tag next
npm publish out/releases/0.1.0-rc.1/ue-shed-unreal-assets-0.1.0-rc.1.tgz --access public --tag next
npm publish out/releases/0.1.0-rc.1/ue-shed-uasset-0.1.0-rc.1.tgz --access public --tag next
```

If a publication fails after an earlier package succeeds, do not unpublish or rebuild that version;
fix the account or network issue and publish only the remaining byte-identical tarballs. After all
four exist, verify their exact versions and `next` tags, then repeat the consumer test against the
registry before completing Plan 025.

## Protected npm publication

Publication is deliberately narrower than candidate creation:

- dispatch `Candidate Release` from the exact `v<version>` tag;
- enable the `publish` input;
- approve the protected `npm-release` environment;
- configure each public package on npm with `candidate-release.yml` as its GitHub trusted publisher
  and allow `npm publish`;
- keep the publish job on GitHub-hosted Ubuntu, because npm trusted publishing does not accept a
  self-hosted runner;
- provide no `NODE_AUTH_TOKEN`: npm obtains a short-lived OIDC identity and creates provenance for a
  public package from a public repository.

The job publishes only the previously built `.tgz` files. It fails when the tag and exact version do
not agree or when no public package artifacts exist.

## Two-repository handshake

1. Publish the exact UE Shed candidate after portable and trusted Unreal evidence are reviewed.
2. Open a downstream pull request pinning that exact candidate version or artifact digest. Never use
   `latest`, a range, a branch, or an unverified workflow artifact.
3. Run downstream portable checks and its manually approved Unreal evidence against the pin.
4. Publish the reviewed UE Shed stable release from an exact stable tag and protected OIDC job.
5. Open a second downstream pull request replacing the candidate pin with the exact stable version
   or digest, then repeat downstream verification.

A future repository-dispatch integration may open either bump pull request. It must never approve,
merge, publish, or silently change the exact selected version.
