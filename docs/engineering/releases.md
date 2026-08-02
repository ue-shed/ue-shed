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
   only for a portable dry run and is represented as `null` in the manifest. Any publication input
   without that exact successful run is rejected.
4. Download `ue-shed-<version>` and verify `SHA256SUMS`.
5. Inspect `candidate-manifest.json`: the source commit, ref, pnpm version, lockfile digest, evidence
   run, and every artifact digest must be exact. The candidate's `plugins/plugins.manifest.json`
   must bind the plugin graph and source archive to the exact `npm/packages-manifest.json` digest.
6. Verify GitHub's provenance attestation with `gh attestation verify` before promoting an artifact.

The candidate always contains immutable source and checksummed plugin-source artifacts. Its npm allowlist is
exactly `@ue-shed/protocol`, `@ue-shed/observability`, `@ue-shed/unreal-connection`,
`@ue-shed/cameras`, `@ue-shed/observatory`, `@ue-shed/uasset-inspection-wasm`,
`@ue-shed/uasset-win32-x64`, `@ue-shed/unreal-assets`, and `@ue-shed/uasset`; candidate
construction fails if another workspace becomes public accidentally. Observatory is a headless Node
host surface: it pins Observability and Unreal Connection, and its USOT v1 wire contract remains in
Protocol. The Windows candidate job builds the native parser and WASM package, validates packed
manifests, MIT license metadata, checksums, the generated WASM `dist/build-info.json` optimizer
evidence, and provenance subjects, installs the tarballs into a clean offline consumer, loads the
WASM package, and dry-runs all nine publications.

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
node scripts/plugin-bundle.mjs bundle --version 0.1.0-rc.4 --output out/plugins
pnpm ue-shed plugins verify out/plugins/plugins.manifest.json
pnpm ue-shed plugins list out/plugins/plugins.manifest.json
pnpm ue-shed plugins install --project fixtures/unreal-project/UEShedFixture.uproject `
  --manifest out/plugins/plugins.manifest.json
```

For Plan 028's first Map Review vertical, select the exact Core+Cameras graph instead of the full
candidate plugin set. That selection does not require Workbench, extension UI, Observatory, or
Authoring:

```powershell
pnpm release:plugins:map-review
# or:
node scripts/plugin-bundle.mjs bundle --version 0.1.0-rc.4 `
  --output out/plugins-map-review --plugins UEShedCore,UEShedCameras
pnpm ue-shed plugins verify out/plugins-map-review/plugins.manifest.json
pnpm ue-shed plugins install --project <project.uproject> `
  --manifest out/plugins-map-review/plugins.manifest.json
```

Installation is project-scoped under `Plugins/UEShed`. It refuses checksum failures, unsupported
graphs, modified installer-owned files, and unrelated existing content at that destination.

For a headless Observatory host such as Electroswag, select only `UEShedObservatory` from the exact
same release manifest:

```powershell
pnpm release:plugins:observatory
pnpm ue-shed plugins verify out/releases/0.1.0-rc.4/plugins-observatory/plugins.manifest.json
pnpm ue-shed plugins install --project <project.uproject> `
  --manifest out/releases/0.1.0-rc.4/plugins-observatory/plugins.manifest.json
```

The initial `0.1.0-rc.1` publication bootstrapped the parser packages before npm trusted publishers
could be configured. Later Map Review candidates add `@ue-shed/unreal-connection` and
`@ue-shed/cameras`, `@ue-shed/observability`, and `@ue-shed/observatory` to the same exact-version,
protected OIDC path. The new `@ue-shed/uasset-inspection-wasm` package is a special first-publish
case: npm cannot configure a trusted publisher until the package exists, and npm staged publishing
cannot create a brand-new package. Follow the one-time bootstrap procedure below; do not improvise a
token-based path for any other package. From a clean reviewed checkout on Windows, run `pnpm check`,
then `pnpm release:pack` to inspect the local artifacts. Confirm the local manifest and checksums:

```powershell
Get-Content out/releases/0.1.0-rc.4/npm/packages-manifest.json
Get-Content out/releases/0.1.0-rc.4/npm/SHA256SUMS
```

Do not treat local packing as publication: protected OIDC publication requires the exact candidate
tag, the protected `npm-release` environment, and human approval. If publication fails after an
earlier package succeeds, do not unpublish or rebuild that version. The protected job is retry-safe:
for every exact `name@version`, it computes SHA-512 SRI from the candidate `.tgz` and queries npm's
`dist.integrity`. It publishes an absent version, skips an existing version only when the registry
integrity exactly matches, and fails closed on a mismatch or registry-query error. Rerun the same
protected job only after resolving the account or registry issue.

## One-time WASM bootstrap

The npm registry requires the package to exist before `npm trust` can configure its GitHub trusted
publisher, while staged publishing also requires an existing package. Therefore the first
`@ue-shed/uasset-inspection-wasm` publication uses a deliberately separate, one-time path:

1. Confirm the candidate has the exact protected tag, successful portable evidence, and successful
   Trusted Unreal evidence for the same commit. The workflow refuses publication without the exact
   run ID.
2. Dispatch `Candidate Release` from `refs/tags/v<version>` with `publish=true` and
   `bootstrap=true`. Approve the protected `npm-bootstrap-release` environment.
3. Store only a narrowly scoped, short-lived `NPM_BOOTSTRAP_TOKEN` in that protected environment.
   It is used only as `NODE_AUTH_TOKEN` for the new WASM tarball; it must not be a repository-wide
   secret or be exposed to candidate construction, dry runs, or the normal publish job.
4. The bootstrap job publishes only the WASM tarball with `npm publish --provenance --access public
--tag next`. It does not use staged publishing and does not publish the existing package set.
   The later normal nine-package OIDC job queries this exact version, verifies that its registry
   integrity matches the bootstrap tarball, and skips it instead of attempting an immutable-version
   republish.
5. After the package exists, configure its GitHub trusted publisher with npm's `npm trust` command
   or package settings. The intended relationship is:

    ```powershell
    npm trust github @ue-shed/uasset-inspection-wasm --file candidate-release.yml `
      --repo ue-shed/ue-shed --env npm-release --allow-publish --yes
    npm trust list @ue-shed/uasset-inspection-wasm
    ```

6. Verify a protected OIDC candidate dry run, revoke/delete `NPM_BOOTSTRAP_TOKEN`, remove it from
   `npm-bootstrap-release`, and enable npm's “require two-factor authentication and disallow
   tokens” setting for the package. Only then is the normal OIDC publish path allowed.

The bootstrap job completes successfully after the first publish, but writes a prominent
`GITHUB_STEP_SUMMARY` handoff and workflow warning. Green status is not the steady-state release
postcondition: a human must configure the trusted publisher, verify OIDC, revoke/delete the
`NPM_BOOTSTRAP_TOKEN` at npm, and remove the `npm-bootstrap-release` secret before any later
publication. Re-running with `bootstrap=true` is not a recovery strategy: the package version is
immutable and the one-time token must not be reused. If bootstrap prerequisites are not ready, leave
`publish=false`; the workflow fails closed.

See npm's [trusted publishers](https://docs.npmjs.com/trusted-publishers/), [`npm trust`](https://docs.npmjs.com/cli/v11/commands/npm-trust/),
[provenance](https://docs.npmjs.com/generating-provenance-statements/), and
[staged publishing](https://docs.npmjs.com/staged-publishing/) documentation for the registry rules.

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
- the steady-state job rejects any `NODE_AUTH_TOKEN` or `NPM_TOKEN` in its environment; token
  authentication is reserved for the one-time protected bootstrap job above.

The job reconciles only the previously built `.tgz` files in the exact manifest order. Before each
package, it queries the exact registry `name@version`: an absent version is published, an existing
version with byte-identical SHA-512 SRI is skipped, and an integrity mismatch fails closed. This also
makes a rerun safe after a partial multi-package publication. The job still fails when the tag and
exact version do not agree, Trusted Unreal evidence is not bound, token auth is present, the registry
query is ambiguous or fails, or no public package artifacts exist.

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
