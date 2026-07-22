# Plan 027: Adopt the released parser in the first downstream host

> **Executor instructions**: This is an external-consumer coordination plan. Execute it in the downstream host repository after UE Shed publishes exact packages/plugin release. Do not add host UI, studio policy, or paths to UE Shed source. Its only UE Shed-facing dependency is released artifacts.
>
> **Drift check (run first in the downstream repository)**: inspect its TableSource seam, parser process wrapper, current parser fixtures, and package manifest before changing them.

## Status

- **Priority**: P1
- **Effort**: M
- **Risk**: MED
- **Depends on**: Plans 021, 025, and 026
- **Category**: migration
- **Planned at**: commit a1df704, 2026-07-22

## Why this matters

The downstream host has a mature authoring UX and a parser lineage from which UE Shed's parser was copied. The safest first integration is a released parser replacement behind the existing TableSource seam, not a parallel data model, UI rewrite, or indefinite old/new shadow mode.

## Current state

- The host has a TableSource abstraction, disk-backed source, parser process wrapper, parser result types, and acceptance fixtures.
- Tests currently locate a legacy parser executable through a sibling checkout, which is not a product distribution mechanism.
- UE Shed will provide exact @ue-shed/uasset and @ue-shed/unreal-assets releases plus a checksummed plugin manifest where needed.
- The host uses unreal-rc. Missing Remote Control capability must be added/released upstream rather than recreated locally.

## Commands you will need

| Purpose          | Command                                                                          | Expected on success                  |
| ---------------- | -------------------------------------------------------------------------------- | ------------------------------------ |
| Pin candidate    | pnpm add --save-exact @ue-shed/uasset@<version> @ue-shed/unreal-assets@<version> | Exact lockfile entries               |
| Host check       | pnpm check                                                                       | Exit 0                               |
| Acceptance tests | pnpm test -- <existing disk-table-source test>                                   | Existing parser fixtures pass        |
| Engine evidence  | <host Unreal E2E command>                                                        | Passes with matching plugin manifest |

## Scope

**In scope in downstream host**

- Manifest/lockfile, parser executable resolution, TableSource/disk seam, existing parser acceptance fixtures, candidate/stable bump PRs.

**Out of scope**

- Copying the parser into UE Shed or UE Shed code into host.
- Two production parsers/shadow mode.
- Authoring UI/custom UI/session migration.
- Ranges, latest, Git dependencies, sibling paths, or raw HTTP Remote Control workarounds.

## Steps

### Step 1: Consume a concrete candidate

After a UE Shed candidate manifest exists, add exact candidate versions and matching plugin ID. Replace sibling executable lookup with installed uasset command or its documented locator.

**Verify**: parser resolution still succeeds after sibling checkout is absent.

### Step 2: Adapt at one seam

Translate released parser inspection into existing host TableSource/parser types at one adapter. Preserve host errors/UI. Existing fixtures are acceptance evidence; no long-lived old/new comparison is needed.

**Verify**: existing disk source/parser tests pass against installed artifacts.

### Step 3: Complete the handshake

Run host CI and selected Unreal evidence on the candidate. Report generic contract gaps upstream as versioned bugs. After stable UE Shed release, submit a second exact stable bump rather than mutating the candidate lockfile.

**Verify**: host check and engine evidence pass for matching candidate and stable pins.

## Done criteria

- [ ] No host runtime/test path needs a sibling parser checkout.
- [ ] Exact released package pins and matching manifest are recorded.
- [ ] Existing parser fixtures pass through one adapter.
- [ ] Candidate/stable evidence is recorded.
- [ ] UE Shed imports no host UI or policy.

## STOP conditions

- A passing host fixture needs parser behavior absent from released API.
- A public parser API is missing.
- Required Remote Control call is unsupported by unreal-rc.
- Candidate manifest/package versions disagree.

## Maintenance notes

File generic parser additions upstream. Keep the adapter small and versioned; downstream UX changes must not change the UE Shed boundary.
