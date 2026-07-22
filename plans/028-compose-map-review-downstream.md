# Plan 028: Compose finished Map Review capabilities downstream

> **Executor instructions**: Do not start until Plans 017, 018, and 019 are DONE and their public contracts are released. Implement composition in the downstream repository; keep UE Shed headless and do not reuse Workbench/camera-review extension UI.
>
> **Drift check (run first)**: compare released Map Review exports, plugin manifest, contract fixtures, and downstream host's existing Map Actors feature before adding an adapter.

## Status

- **Priority**: P2
- **Effort**: XL
- **Risk**: HIGH
- **Depends on**: Plans 017, 018, 019, 022, and 026
- **Category**: direction
- **Planned at**: commit a1df704, 2026-07-22

## Why this matters

Map Review can expose review-set, framing, capture, artifact, and recovery capabilities without sharing a grid/custom authoring UI. The downstream product owns Electron interaction and studio workflow; UE Shed owns generic contracts, engine capability, and plugin transport.

## Current state

- Plans 017–019 are still completing realized framing, PIE previews, and World Scout transforms; they are not stable external promises.
- packages/cameras has schema-first Map Review domain/IPC. Plan 022 adds language-neutral conformance.
- Plan 026 supplies Core/Cameras through installed manifest, not manual folder copies.
- The host has a Map Actors page, useful UX context but not a Map Review contract.

## Commands you will need

| Purpose         | Command                                                                      | Expected on success       |
| --------------- | ---------------------------------------------------------------------------- | ------------------------- |
| Pin capability  | pnpm add --save-exact @ue-shed/cameras@<version> @ue-shed/protocol@<version> | Exact lockfile entries    |
| Install plugins | ueshed plugins install --project <project> --manifest <map-review-manifest>  | Core/Cameras installed    |
| Adapter tests   | pnpm test -- <map-review-adapter tests>                                      | Pass                      |
| Host check      | pnpm check                                                                   | Exit 0                    |
| Engine evidence | <host Unreal E2E command>                                                    | Real review flow succeeds |

## Scope

**In scope**

- Downstream adapter from released contracts to Electron services/UX.
- Exact pins and matching manifest install.
- Product-specific navigation, presentation, workflow, policy, contract and recovery tests.

**Out of scope**

- Importing extensions/camera-review UI, Workbench state/styles, or copying host UI into UE Shed.
- Generic capability work merely to mirror an Electron screen.
- Starting before prerequisite plans are released.

## Steps

### Step 1: Confirm released capability boundary

Read product contract, exports, fixtures, manifest. Record mapping from host states to generic review session, framing, capture, artifact, recovery operations; leave product-only policy local.

**Verify**: every cross-process payload decodes through released contracts, not a duplicate schema.

### Step 2: Build one vertical flow

Install exact packages/plugins. Implement select subject, obtain/approve framing, request capture, observe artifact/recovery, and present it. Adapter service owns typed failures/retries/logs; it must not reach plugin internals.

**Verify**: tests cover success, unavailable capability, malformed payload, and interrupted/recovered capture.

### Step 3: Validate a real project

Run host CI/trusted Unreal evidence against installed bundle. Send generic gaps upstream; keep product UX/policy fixes local. Promote candidate to stable only with a second exact stable bump.

**Verify**: documented real-project review produces/presents an artifact then recovers after interruption.

## Done criteria

- [ ] Released headless contracts and installed Core/Cameras only.
- [ ] One full Map Review flow has contract/recovery/Unreal evidence.
- [ ] UX/studio policy remain downstream.
- [ ] No Workbench/extension UI import.
- [ ] Candidate/stable pins/manifests match exactly.

## STOP conditions

- Any Map Review prerequisite plan is not DONE/released.
- Released contract cannot express a required generic operation.
- Manifest omits dependency/engine compatibility.
- Implementation needs a UE Shed UI component.

## Maintenance notes

Add product workflow one released capability at a time. Generic contract changes go upstream with fixtures; presentation/policy stays downstream.
