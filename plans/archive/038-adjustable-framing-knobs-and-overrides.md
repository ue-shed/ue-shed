# Plan 038: Modular framing rigs and per-view tuning

> **Executor instructions**: Define permissive headless primitives before preset helpers, authoring
> sessions, IPC, or UI. Workbench may present a deliberately smaller showcase surface, but its
> controls must never become limits in `@ue-shed/cameras`. Keep generation pure and keep repeat
> capture bound to the durable Approved Pose. Run `pnpm check` immediately before handoff.
>
> **Drift check (run first)**:
> `git status --short -- packages/cameras apps/workbench extensions/camera-review docs/products/map-review.md plans/archive/032-decouple-review-visibility-and-invocation.md`
> and inspect `FramingCandidate`, `FramingRecipe`, `ReviewAuthoringSession`,
> `ReviewAuthoringSessionPatch`, and `MapReviewAuthoringPatchIntent` before editing.

## Status

- **State**: DONE
- **Priority**: P1
- **Effort**: L
- **Risk**: MEDIUM — this changes portable recipe data, authoring-session persistence, Workbench
  IPC, and the maintained authoring experience. It does not change Unreal capture contracts,
  visibility policy, or invocation.
- **Depends on**: archived Plans 017, 018, and 032.
- **Category**: feature
- **Reconciled at**: 2026-08-06 after Plan 032 completion and operator review.
- **Completed at**: 2026-08-06 with 30-camera separate-process CLI evidence, durable recipe v2
  restart coverage, debounced Workbench controls, and the full repository gate green.

## Outcome

Map Review framing becomes a permissive, headless rig generator. A caller composes reusable single,
arc, and ring groups, generates any positive number of candidates, optionally overrides one
candidate, and persists the exact definition that produced an approved pose. Context
three-quarter, Facade front, and Cardinal orbit are convenience presets over those primitives.

Workbench remains a dogfood client. It exposes the three named presets with approachable controls,
uses 1–24 as an ergonomic slider range, and warns when a requested set may make live preview
expensive. That presentation policy is not a domain constraint. The generator never truncates a
set and does not reject a valid definition merely because it is large.

## Product decisions

- **Permissive primitives first**: group identity, camera parameters, arc/ring distribution, and
  partial candidate overrides are public domain data. Named presets are constructors.
- **No compatibility theater**: default preset poses should remain useful and recognizable, but
  candidate IDs and serialized recipes may adopt the cleaner model. There are no external users to
  justify byte-for-byte output preservation.
- **No product camera cap**: counts are positive integers. Generation returns exactly the requested
  candidates. Workbench may warn or constrain its own controls, and a producer may truthfully
  report a live-realization capability limit.
- **Exact durable provenance**: new kept preset Views use recipe v2 with the rig definition, group
  and index anchor, and only the selected candidate's explicit overrides. Existing v1 recipes stay
  readable.
- **Overrides are partial and opt-in**: absent keys inherit from the group/global definition. An
  override never changes group count or distribution.
- **Stable regeneration anchors**: generated candidates use `preset/<group-id>/<index>` (1-based).
  Overrides re-anchor only on exact group+index matches and unmappable entries are dropped.
- **Approved Pose stays authoritative**: tuning changes generated candidates; repeat capture uses
  the pose kept in the View and never silently regenerates it.
- **Simple showcase path remains simple**: select → frame → choose → Keep requires no settings work.

## Public model

All TypeScript-owned persisted models use Effect Schema and inferred types.

```ts
FramingParameters = {
	fieldOfViewDegrees: number // 5..170
	margin: number             // 0..0.45
	groups: ReadonlyArray<FramingGroup>
}

FramingGroup = {
	id: FramingGroupId
	displayName: string
	enabled: boolean
	distanceScale: number      // finite > 0
	elevation: number          // finite subject-height multiplier
	pattern:
		| { kind: "arc"; count: positive integer; yawOffsetDegrees: number; spreadDegrees: number }
		| { kind: "ring"; count: positive integer; ringOffsetDegrees: number }
}

FramingCandidateOverrides = {
	distanceScale?: number
	elevation?: number
	yawOffsetDegrees?: number
	fieldOfViewDegrees?: number
	margin?: number
}
```

An arc with count 1 emits its center yaw. Larger arcs distribute inclusive samples across the
requested spread. A ring emits evenly spaced world-yaw samples beginning at its offset. The default
rig constructor returns Context three-quarter (one-camera arc), Facade front (one-camera arc), and
Cardinal orbit (four-camera ring). The current editor view remains an optional independent
candidate.

Recipe v2 stores `parameters`, `groupId`, `groupIndex`, and optional `candidateOverrides` alongside
the existing subject-bounds and margin provenance. Recipe v1 remains a separate readable union
member. New preset approvals write v2.

## Scope

**In scope**:

- framing schemas, branded group identity, defaults, and named preset constructors;
- pure arc/ring generation and pure per-candidate overrides;
- recipe v2 plus v1 decoding;
- authoring-session parameter/override persistence, regeneration, re-anchoring, and approval;
- Workbench IPC/client plumbing and a progressive framing inspector;
- automatic preview refresh using the existing realization paths;
- a soft expensive-preview hint in Workbench;
- CLI acceptance and structured output for v2 recipes and tunable authoring patches;
- recovery, component, service, property, and process tests; product documentation.

**Out of scope**:

- Unreal capture-contract or plugin changes;
- generic spline/path camera editing;
- visibility, Clear, or invocation changes;
- automatic reframing during capture or subject movement;
- reusable organization-wide named-rig libraries.

## Steps

### Step 1: Define the durable primitives and recipe v2

Add the schemas above to `packages/cameras/src/review-schema.ts`. Add defaults and preset
constructors in `review-framing.ts`. Model v1 and v2 preset recipes explicitly and keep decoding
both. Validate finite geometry parameters and positive integer counts, without a product maximum.

**Verify**: schema rejection cases, v1 decoding, v2 round trip, preset constructor values, typecheck,
and camera contract checks.

### Step 2: Generate rigs and apply candidate overrides

Change `generateFramingCandidates(selection, parameters?)` to generate every enabled group. Use
canonical `preset/<group>/<index>` IDs. Add pure `applyCandidateOverrides` and
`generateFramingCandidateId` helpers. Preserve editor-view behavior.

**Verify**: recognizable default poses, multi-camera arcs, arbitrary-count rings, finite output,
exact requested counts, override isolation, and no mutation of neighboring candidates.

### Step 3: Persist tuning through authoring sessions

Add `framingParameters` and `candidateOverrides` to session documents and patches. Parameter patches
regenerate from stored subject bounds, retain the optional editor-view candidate, reapply exact
group+index overrides, discard unmappable overrides, and clear stale realization evidence. Override
patches update only addressed candidates. Approval persists recipe v2 provenance and the resulting
Approved Pose.

**Verify**: regeneration, re-anchoring/drop behavior, approval, restart recovery, and v1 session
compatibility.

### Step 4: Expose the workflow through clients and Workbench

Carry the patch fields through public IPC and renderer clients. Add a progressive Framing inspector
for the three showcase presets and global FOV/margin. Use sliders with an ergonomic 1–24 count range
and direct numeric controls where useful. Show a non-blocking performance hint for expensive sets.
Debounce parameter patches around 400 ms, refresh previews automatically, preserve selection where
the candidate still exists, and show explicit producer capability limitations without changing the
headless definition.

**Verify**: component actions, debounce, selection preservation, override isolation, soft hint, and
Workbench service behavior.

### Step 5: Prove durability and document the public boundary

Prove a tuned View survives restart and captures from the persisted Approved Pose. Update Map Review
product and CLI documentation only for proven behavior. Run focused tests, contract and architecture
gates, `pnpm check`, then mark this plan DONE and archive it.

## Done criteria

- [x] Public framing primitives are modular and impose no Workbench camera-count policy.
- [x] Named presets are convenience constructors over arc/ring groups.
- [x] Generation returns exactly the requested positive counts and never silently truncates.
- [x] Partial overrides affect only one exact group+index candidate and re-anchor safely.
- [x] Recipe v2 preserves exact generation provenance; v1 recipes remain readable.
- [x] Sessions regenerate, recover, and approve tuned candidates durably.
- [x] Workbench keeps the simple path, offers progressive controls, and treats 1–24 as UI guidance.
- [x] No Unreal capture-contract, visibility-policy, or invocation changes are made.
- [x] Focused tests, process tests, architecture gates, and `pnpm check` pass.

## STOP conditions

- Non-finite parameters or non-positive counts reach pose generation.
- A large valid rig is truncated or rejected by the headless generator because of showcase policy.
- Overrides attach to a different group+index after regeneration.
- Repeat capture recomputes rather than uses the persisted Approved Pose.
- Workbench becomes the only way to configure the framing definition.
- A verification gate fails twice after focused in-scope correction.
