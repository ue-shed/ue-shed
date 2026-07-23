# Release evidence and downstream handoff

UE Shed separates portable checks, trusted Unreal evidence, candidate construction, and publication.
No workflow merges code or updates a downstream repository. During the judging freeze, all work and
candidate runs stay on temporary or feature refs; `main` is not a target.

GitHub accepts manual dispatches and schedules only after a workflow exists on the default branch.
Until the judging freeze ends, validate candidate construction locally and let temporary-branch push
events exercise the portable workflow. Do not copy or merge the dispatch workflows to `main` merely
to activate them early; Plan 024 remains in progress until their first protected runs complete.

## Trust lanes

The `Portable` workflow runs `pnpm check` on an ephemeral Blacksmith Ubuntu runner. It receives only
read access to repository contents, persists no checkout credential, and caches only rebuildable
dependencies. Configure the repository's required checks so `pnpm check` is required on the temporary
integration branch. Macroscope remains advisory: install its GitHub App for this repository and
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

1. Dispatch `Candidate Release` on the reviewed temporary or feature ref.
2. Enter a version such as `0.1.0-rc.1` and leave `publish` disabled.
3. Enter the numeric Unreal run ID to bind its evidence into the candidate. Omitting it is allowed
   only for a portable dry run and is represented as `null` in the manifest.
4. Download `ue-shed-<version>` and verify `SHA256SUMS`.
5. Inspect `candidate-manifest.json`: the source commit, ref, pnpm version, lockfile digest, evidence
   run, and every artifact digest must be exact.
6. Verify GitHub's provenance attestation with `gh attestation verify` before promoting an artifact.

The candidate always contains immutable source and plugin-source archives. It also packs every
workspace whose manifest is public (`private` is not `true`), but refuses to pack one unless its
package version exactly matches the candidate version. Until Plan 025 defines a public package
boundary, a dry run intentionally contains no npm tarballs and the publish job refuses to proceed.

For a local artifact-only dry run:

```powershell
$commit = git rev-parse HEAD
node scripts/create-release-candidate.mjs --version 0.1.0-rc.1 --commit $commit `
  --ref refs/heads/temp/hackathon-judging-2026-08-13 --output out/candidate
```

Use a new empty output directory for every run. The script will not overwrite an existing candidate.

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
