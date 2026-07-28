# Plan 032: Decouple Review Views, visibility policy, and capture invocation

> **Executor instructions**: Follow this plan in order. Define and migrate the contracts before
> changing Unreal capture behavior or UI. Keep the primary authoring path simple while preserving
> explicit advanced visibility controls. Run every verification gate before advancing. If a STOP
> condition occurs, stop and report it rather than weakening evidence, hiding interventions, or
> broadening Map Review into a scheduler.
>
> **Drift check (run first)**:
> `git status --short -- docs/products/map-review.md docs/ideas/map-review-cameras.md docs/ideas/live-camera-feeds.md packages/cameras packages/protocol apps/cli apps/workbench extensions/camera-review unreal/Plugins/UEShedCameras fixtures/unreal-project`
> and
> `git diff --stat 8adaaad -- docs/products/map-review.md docs/ideas/map-review-cameras.md docs/ideas/live-camera-feeds.md packages/cameras packages/protocol apps/cli apps/workbench extensions/camera-review unreal/Plugins/UEShedCameras fixtures/unreal-project`.
> Then inspect the current `ReviewSet`, `ReviewView`, `CaptureProfile`, provisioned-camera,
> `CaptureReviewView`, and Capture Run schemas. If durable View identity, Pure capture semantics, or
> the editor/runtime module boundary changed, reconcile this plan before editing.

## Status

- **State**: TODO
- **Priority**: P1
- **Effort**: XL
- **Risk**: HIGH — this changes portable Review Set data, public TypeScript APIs, TypeScript/C++
  capture contracts, transient Unreal visibility state, immutable evidence, CLI behavior, and the
  maintained authoring/review UX. Incorrect intervention or restoration could contaminate captures
  or leave the editor world modified.
- **Depends on**: archived Plans 017, 018, and 022
- **Category**: direction
- **Planned at**: commit `8adaaad`, 2026-07-28, plus the in-progress provisioned/authored camera
  terminology refactor in the same workspace

## Why this matters

Map Review's north star is a durable visual memory of actors and areas. A user should be able to
approve a visual intent once, recapture it manually or through another system, and understand change
over time. Natural world state often makes the intended target partially or completely illegible:
foliage grows, props move, vehicles park in front of structures, construction adds permanent
geometry, or an area becomes cluttered during simulation.

The current implementation cannot express that intent cleanly:

- a provisioned camera is a thin pose/FOV/resolution spawn request with a Map Review candidate ID;
- a Review View supports one actor path and one world-space Approved Pose;
- Capture Profile owns the only `variantPolicy`, fixed to `pure_only`;
- projected bounds diagnose framing and near-plane problems but do not measure rendered occlusion;
- Capture Runs produce one Pure PNG per View and cannot explain visibility or interventions;
- no contract distinguishes a world-fixed view from a camera pose anchored to a moving actor;
- capture orchestration does not record why a run was invoked;
- the product document describes Pure/Clear policy, but the shipped schema and engine path do not
  implement paired visibility evidence.

The solution is not to put every concern on `ReviewView` or expose engine algorithms in the main UI.
The durable model must separate:

1. **Review View** — what must remain visually meaningful;
2. **Capture Profile** — reusable rendering, readiness, and environment expectations;
3. **Visibility Policy** — how occlusion is assessed and whether a labeled Clear companion is made;
4. **Capture Invocation** — which Views are requested and why capture is happening now; and
5. **Capture Run / View Result** — immutable evidence of what actually happened.

The provisioned camera and one-shot editor `ASceneCapture2D` remain disposable realizations. They do
not become a second durable camera database.

## Product decisions fixed by this plan

- The durable primary entity remains **Review View**. Do not introduce **Watch** as a Map Review
  domain noun.
- Scheduling mechanisms are out of scope. Map Review accepts an explicit invocation and records its
  cause; cron, CI, capture farms, scenario runners, simulation timers, and state-change detectors
  remain separate callers.
- **Pure** is the unmodified rendered world from the approved View. **Clear** is an optional,
  explicitly modified companion from that same View after an allowed visibility intervention.
- Every visibility-modified artifact has a Natural/Pure companion captured first from the exact same
  effective pose and projection.
- `pure` remains the stable evidence variant name. The UI may label it **Natural** for clarity.
- `clear` remains the stable companion variant name. The UI must call it a modified companion and
  state whether it isolated the target or hid blockers.
- Occlusion **assessment** and visibility **intervention** are separate. Detecting a blocker never
  grants permission to hide it.
- The primary UI uses project defaults and named presets. Exact assessment algorithms, thresholds,
  protected objects, explicit hidden objects, and automatic-intervention guardrails live under
  Advanced settings.
- Visibility Policies are immutable named presets. Multiple Views may reference one preset, but
  Advanced changes for one View create a replacement preset/reference for that View. Editing a
  shared preset in place never silently changes other Views; applying one change to several Views
  is an explicit bulk action.
- Paired capture is one bounded host-visible Unreal operation per View. Unreal owns any temporary
  visibility intervention and restoration and returns structured stage outcomes. The host owns
  capture planning and evidence finalization, but it never holds authored actors in a modified
  state between independently recoverable requests.
- Repeat capture never silently changes an Approved Pose. A revised pose starts a visible View
  revision/history boundary.
- World-fixed and target-relative viewpoints are distinct durable meanings:
    - **Watch this place** uses a fixed world pose.
    - **Follow this actor** uses a pose relative to the resolved actor.
- Area targets default to Natural capture. Objects inside the reviewed area are not automatically
  considered occluders.
- Automatic occluder handling must be explainable, bounded, explicitly enabled, and proven against
  real rendered evidence before it appears as a selectable policy. A negative feasibility result
  leaves that strategy unsupported and does not block the rest of this plan.

## User stories and acceptance language

### Author one ordinary View

A level artist selects an actor, accepts a generated angle, and keeps the View without opening
Advanced settings. The View inherits the default Capture Profile and default Natural-only Visibility
Policy. The existing select → frame → preview → Keep flow remains recognizable.

### Choose whether place or actor stays fixed

An author explicitly chooses:

- **Watch this place** to retain a world-space camera and expose actor movement; or
- **Follow this actor** to retain a target-relative composition and normalize world movement.

The UI explains the historical consequence before approval. Area targets support place-fixed mode in
the first implementation. An invalid area/follow-target combination is unrepresentable in the
schema.

### Capture a daily historical image without owning a scheduler

An external job invokes the same public CLI or service on successive days. Each Capture Run records
an automation cause and optional external correlation ID. Map Review neither stores a cron
expression nor launches a scheduling daemon. Missing subjects, unavailable Unreal, readiness
failure, and interrupted capture produce explicit results rather than unexplained gaps.

### Keep truth and legibility together

A foreground actor obscures a reviewed structure. The run first captures Natural/Pure, preserving
the obstruction as real change. If the View's Visibility Policy requests a companion, it then
captures Clear from the same pose. The reviewer can toggle or compare the pair and inspect every
hidden/shown object plus restoration status.

### Art-direct a stable blocker

An author selects a known foreground object and adds it to **Hide in Clear**. Future Clear captures
hide that object only after Pure succeeds. If the object cannot be resolved, Clear fails truthfully
while the valid Pure artifact remains. The author may also mark an object **Never hide**.

### Receive an occlusion warning without modification

Visibility assessment reports that the target is heavily occluded. A Natural-only policy records the
assessment and warns; it does not fail or alter the world unless the policy explicitly requests that
threshold behavior.

### Handle a permanent world change

A new wall blocks the canonical View. The system does not silently reframe or hide it. The reviewer
can preserve the historical View, add an alternate View, or explicitly revise the pose. History
shows the revision boundary so images from different poses are not presented as one continuous
comparison.

### Review an area

An author defines a bounded area and a fixed viewpoint. The Natural capture treats contents of that
area as review subject matter, not disposable blockers. Visibility assessment may report whether the
area's expected screen region is legible, but automatic hiding is unavailable unless a narrower
target and explicit policy make intervention meaningful.

### Capture during a future simulation

A future Observatory or Scenario caller may invoke a View at world-time intervals, scenario events,
or state changes and record that cause. This plan proves the invocation/evidence seam only. It does
not implement timers, event subscriptions, sequence storage, or scenario orchestration.

## Target model

The exact schemas must use Effect Schema, branded identifiers, discriminated unions, and derived
types. The following shapes express required semantics; executors may adjust field names when tests
or existing compatibility conventions demand it, but may not collapse the boundaries.

### Review target and viewpoint

```ts
ReviewTarget =
	| ActorTarget
	| AreaTarget

ReviewViewDefinition =
	| {
			target: ActorTarget
			viewpoint:
				| WorldFixedViewpoint
				| TargetRelativeViewpoint
	  }
	| {
			target: AreaTarget
			viewpoint: WorldFixedViewpoint
	  }
```

`ActorTarget` begins from the current layered actor Subject Locator and remains extensible to
components/actor groups later. `AreaTarget` v1 is a portable, map-scoped oriented box with finite
center, extent, and rotation. It does not imply a dynamic query for all actors inside the box.
Framing and visibility code treat the oriented bounds as the subject geometry.

`WorldFixedViewpoint` stores the approved world pose. `TargetRelativeViewpoint` stores the approved
pose relative to a resolved actor transform plus the target snapshot used at approval. Each View
also retains Framing Recipe, adjustment reason, capture-profile reference, visibility-policy
reference, and optional visibility overrides.

### Visibility policy

```ts
VisibilityPolicy = {
	id: VisibilityPolicyId
	name: string
	assessment:
		| { method: "automatic" }
		| { method: "ray_samples"; samplePreset: VisibilitySamplePreset }
		| { method: "subject_mask" }
		| { method: "depth_compare" }
	output:
		| { mode: "natural_only" }
		| {
				mode: "natural_and_clear"
				clearStrategy:
					| { type: "isolate_target" }
					| { type: "hide_explicit" }
					| { type: "hide_detected_occluders"; guardrails: AutomaticHideGuardrails }
		  }
	onLowVisibility:
		| { action: "record" }
		| { action: "warn"; threshold: number }
		| { action: "fail"; threshold: number }
}
```

Only implemented strategies may decode as supported. Do not ship a UI option that the connected
plugin cannot execute. `automatic` means capability-negotiated selection; the View Result always
records the effective assessment algorithm and version so history is explainable.

Visibility Policies are immutable reusable presets. Changing assessment/output/intervention
settings for one View creates a new preset identity and moves only that View's reference unless the
author explicitly applies the change to other selected Views. Per-View overrides remain separate
because object locators are map/target-specific:

```ts
VisibilityOverrides = {
	hideInClear: ReadonlyArray<ObjectLocator>
	neverHide: ReadonlyArray<ObjectLocator>
}
```

Cross-reference validation rejects duplicate IDs, overlap between hidden/protected sets, a
Natural-only policy with hidden-object overrides, an automatic-hide policy without bounded
guardrails, and unsupported intervention on an area target.

### Capture invocation

`CaptureInvocation` is a validated command value, not a stored scheduler:

```ts
CaptureInvocation = {
	id: CaptureInvocationId
	reviewSetId: ReviewSetId
	viewIds?: ReadonlyArray<ReviewViewId>
	cause:
		| { type: "manual" }
		| { type: "external_automation"; correlationId?: string }
		| {
				type: "runtime_trigger"
				namespace: string
				schemaVersion: number
				provenance: BoundedJsonObject
		  }
}
```

This plan must support manual and external-automation invocation end to end. Runtime-trigger causes
must round-trip as bounded, versioned, namespaced provenance if explicitly supplied, but no
caller, timer, scenario integration, or universal event vocabulary is added here. A future runtime
or live-frame producer may add a typed cause after its sequence, time, and identity semantics are
earned by that producer. `BoundedJsonObject` must impose explicit encoded-size, nesting, key-count,
and scalar-type limits; it is an interchange envelope, not an unbounded domain-model escape hatch.

### Execution and realization

The host derives a bounded capture plan from Review View + Capture Profile + Visibility Policy +
current world resolution. That plan is ephemeral and need not become another repository entity.
For paired evidence, the host submits the resolved plan as one editor operation. Unreal may report
assessment, Pure capture, intervention, Clear capture, restoration, and verification stages, but
those reports describe one guarded operation rather than a durable host-side capture session.

Provisioned camera identity must stop overloading `candidateId`:

- `FramingCandidateId` identifies an authoring candidate;
- `ReviewViewId` identifies durable intent;
- `ProvisionedCameraId` identifies a temporary runtime camera;
- `CaptureInvocationId` and `CaptureRunId` identify request and evidence lifecycles.

The runtime provisioning request uses an explicit correlation union for authoring candidates versus
durable View realization. It carries only data Unreal needs: temporary identity/correlation, pose,
projection, resolution, and optional resolved target/visibility operation. Purpose, tags, history,
schedule, owner, and Review Set organization remain host-side.

### Visibility evidence

Visibility evidence is a discriminated result, never a nullable metric bag:

```ts
VisibilityResult =
	| { status: "not_assessed"; reason: string }
	| {
			status: "assessed"
			method: EffectiveVisibilityMethod
			visibleFraction: number
			classification: "clear" | "partial" | "blocked" | "not_visible"
			occluders: ReadonlyArray<OccluderEvidence>
	  }
	| { status: "assessment_failed"; failure: TypedFailure }
```

`visibleFraction` is finite and bounded from 0 through 1. The result records subject sample/mask
coverage, effective algorithm/version, and bounded blocker evidence where attribution is supported.
It must distinguish occlusion from subject-resolution failure, clipping, near-plane crossing, and
unloaded/incomplete world state. `not_assessed` keeps legacy evidence explicit; lack of a required
current capability is an `assessment_failed` result rather than a fabricated percentage.

Every Clear result records:

- its Pure artifact relationship;
- exact pose/projection equivalence;
- requested and effective strategy;
- resolved subject actors/components;
- every hidden/shown actor/component with stable evidence identity and reason;
- unresolved or rejected interventions;
- visibility state before and after where available;
- restoration outcome; and
- whether the map dirty state changed.

## Current state

- `packages/cameras/src/review-schema.ts` owns Effect Schemas for one actor `SubjectLocator`,
  perspective `ApprovedPose`, `CaptureProfile`, `ReviewView`, `ReviewSet`, Capture Run, and View
  Result. `CaptureProfile.variantPolicy` accepts only `pure_only`.
- `ReviewView` stores `approvedPose`, `captureProfileId`, Framing Recipe, ID/name, and actor subject.
  It has no viewpoint anchoring, area target, visibility-policy reference, or View revision.
- `packages/cameras/src/review-capture.ts` derives one `ReviewCaptureRequest` per View, serializes live
  capture by default, stores `pure.png`, and finalizes immutable runs. It has no invocation value,
  paired variant lifecycle, visibility evidence, or restoration stage.
- `packages/cameras/src/provisioned-cameras-live.ts` uses a TypeScript interface rather than an
  Effect Schema for camera provisioning. Its spec carries candidate ID, location, rotation, FOV, and
  dimensions; its response binding carries generated camera ID, candidate ID, index, and dimensions.
- `AUEShedCameraSource` adds runtime index/GUID, capture dimensions, optional observation target,
  actor-POV offset, transient-provisioned flag, and provisioning key to `ASceneCapture2D`. Runtime
  scheduler/readback state remains external to the actor.
- `UUEShedCameraSubsystem::EnsureProvisionedCameras` spawns temporary sources during PIE/Game, assigns
  random IDs, forces posed Observation rendering, and clears them as one session. It does not resolve
  subjects or assess occlusion.
- `UEShedCamerasEditor::CaptureReviewView` realizes a separate one-shot transient
  `ASceneCapture2D`, writes one Pure PNG, reports projected subject bounds, destroys the actor, and
  checks map dirty state.
- The fixture already contains `ReviewSubject` plus `Review Occluder`, but tests do not prove
  visibility assessment, paired variants, intervention restoration, or historical explanation.
- Workbench provides candidate contact sheets and Capture Run history, but no Visibility Policy
  presets, advanced visibility editor, paired Natural/Clear viewer, or View revision boundary.
- The CLI can validate Review Sets, manage authoring sessions, capture sets/views, and list/open
  history. It does not accept a Capture Invocation/cause or expose visibility-policy diagnostics.
- `docs/products/map-review.md` defines Pure/Clear and defers automatic occluder policy; its shipped
  status correctly stops before full paired visibility evidence.

## Commands you will need

| Purpose                   | Command                                                                                      | Expected success result                                                |
| ------------------------- | -------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------- |
| Focused camera tests      | `pnpm test packages/cameras/src packages/protocol/src/cameras.test.ts`                       | all focused portable tests pass; environment skips remain visible      |
| Workbench/extension tests | `pnpm test apps/workbench/src/main/services/map-review.test.ts extensions/camera-review/src` | service and component tests pass                                       |
| Type checking             | `pnpm typecheck`                                                                             | exit 0                                                                 |
| Architecture gates        | `pnpm effect:architecture && pnpm test:architecture`                                         | exit 0                                                                 |
| Contracts                 | `pnpm --filter @ue-shed/cameras contract:check`                                              | valid/invalid fixtures and TS/C++ parity pass                          |
| Fixture build             | `pnpm fixture:build`                                                                         | UE fixture and plugins compile                                         |
| Launch authoring fixture  | `pnpm fixture:launch-authoring`                                                              | UE 5.7 fixture editor starts with Remote Control available             |
| Real Map Review evidence  | `pnpm test:unreal-review`                                                                    | gate reports `RUN`; real paired/assessment/restoration assertions pass |
| Full Unreal gate          | `pnpm check:unreal`                                                                          | all environment-dependent Unreal conformance passes                    |
| Workbench E2E             | `pnpm test:e2e:workbench`                                                                    | authoring, capture, pair inspection, and history flows pass            |
| Full repository gate      | `pnpm check`                                                                                 | exit 0 immediately before handoff                                      |

Use `C:\Program Files\Epic Games\UE_5.7\Engine\Source` to verify Scene Capture visibility lists,
depth/capture sources, component identity, collision queries, render target formats, and restoration
APIs. Do not guess at Unreal APIs or copy engine implementation.

## Suggested executor toolkit

- Read `docs/engineering/effect.md`, `types-and-errors.md`, `testing.md`, and
  `agent-adoption.md` before changing public services, schemas, CLI, or maintained UI.
- Use the `effect` skill for services, scoped intervention/restoration, cancellation, concurrency,
  and typed failures.
- Use `quality-code` for end-to-end schema/type derivation and discriminated state.
- Use `frontend-design` and `emil-design-eng` for the maintained Solid/StyleX progressive-disclosure
  UX and paired evidence viewer.
- Verify all unfamiliar UE 5.7 rendering and visibility behavior against installed engine source
  before implementing C++.

## Scope

**In scope**:

- Versioned Review Set migration from current actor/world-pose/`pure_only` data to explicit target,
  viewpoint anchoring, Visibility Policies, per-View overrides, and View revision identity.
- Actor and map-scoped oriented-box area targets, with world-fixed area framing and capture.
- World-fixed and target-relative actor viewpoints with explicit historical semantics.
- Immutable reusable Visibility Policy presets with supported assessment/output/intervention
  unions, project defaults, validation, explicit reassignment/bulk application, and advanced
  per-View override data.
- Capture Invocation/cause through headless service, CLI, Workbench, Capture Run manifest, and
  portable interchange.
- Separation of framing-candidate, durable-View, provisioned-camera, invocation, and run identities.
- Versioned TypeScript/C++ contracts for resolved subject inputs, visibility assessment/evidence,
  paired capture, intervention, and restoration.
- At least one render-truthful quantitative visibility assessment suitable for evidence, plus a
  cheaper authoring diagnostic if it is clearly labeled and tested.
- Natural/Pure plus Clear capture with `isolate_target` and `hide_explicit`.
- A non-blocking `hide_detected_occluders` feasibility decision. The strategy ships only if
  assessment quality, attribution, bounded guardrails, and restoration pass Step 6; otherwise it
  remains an explicitly unsupported future capability.
- Immutable paired evidence, partial failure, map-cleanliness proof, and history compatibility.
- Headless/CLI parity and a maintained Workbench/extension UX with simple defaults and advanced
  settings.
- Generic fixture additions and real UE 5.7 conformance for actor/area, partial/full occlusion,
  intervention, failure, and restoration.
- Product and protocol documentation updated only after implementation evidence passes.

**Out of scope**:

- Cron expressions, calendar scheduling, Windows services, CI configuration, capture-farm queues,
  retries across machines, distributed execution, or a **Watch** repository/entity.
- Implementing simulation timers, world-state subscriptions, Scenario events, Observatory triggers,
  sequence/timelapse storage, or automatic live-frame promotion.
- Continuous video, WebRTC, remote transport, or changing the bounded BGRA data plane.
- Computer-vision/ML subject or occluder inference.
- Arbitrary polygons, splines, geographic regions, dynamic “all actors in volume” queries, or
  component/actor-set target identity in the first area vertical.
- Silent reframing, hiding without Pure, unlabeled modified evidence, or treating pixel difference
  as automatic approval.
- Persistent map cameras as the definition authority.
- Studio-specific actor IDs, tags, classes, paths, environment scripts, source control, or
  scheduling assumptions.
- A universal trigger/event system shared across Cameras, Observatory, and Scenarios.

## Git workflow

- Branch: `feat/map-review-visibility-policy`
- Use logical commits that leave focused tests green: contracts/migration, invocation/identity,
  target/viewpoint, assessment, paired intervention, UX, then conformance/docs.
- Do not push, open a PR, publish packages, or update candidate versions unless the operator asks.

## Steps

### Step 1: Freeze vocabulary, schemas, migrations, and compatibility

Add branded IDs and Effect Schemas for `VisibilityPolicyId`, `CaptureInvocationId`,
`ProvisionedCameraId`, View revision identity, Review Target, anchored
Viewpoint, Visibility Policy, Visibility Overrides, Capture Invocation/cause, Visibility Result,
Occluder Evidence, intervention evidence, and restoration result.
Reuse the existing `FramingCandidateId` brand.

Refactor Review Set so:

- Capture Profile no longer owns variant policy;
- Review Set contains one or more Visibility Policies;
- every Review View explicitly references one Capture Profile and one Visibility Policy;
- Visibility Policies are immutable presets: changing one View's Advanced settings creates a new
  policy identity/reference, while multi-View reassignment is explicit;
- View target/viewpoint combinations are represented by a discriminated union;
- per-View hidden/protected overrides are schema-validated;
- existing `pure_only` Review Sets migrate to one generated/default Natural-only Visibility Policy,
  preserving Approved Pose, IDs, and capture behavior;
- migration assigns an initial revision identity to each View for new captures, while old immutable
  View Results with no stored revision decode as an explicit `legacy_unversioned` history state;
  legacy results are never silently comparison-compatible with numbered revisions;
- encode after migration emits only the new version; and
- invalid cross-references and impossible policy combinations fail with actionable typed errors.

Do not hand-copy interfaces. Infer types from schemas and derive IPC/persistence variants. Add
representative valid and invalid fixtures before changing engine code. Decide whether the portable
Review Set remains TypeScript-owned for this version or earns a language-neutral schema freeze;
record the decision in the product contract. Shared TypeScript/C++ messages remain language-neutral
JSON Schema first.

**Verify**:

- old Review Set fixture migrates without pose or ID drift;
- old Capture Runs remain readable and appear under the distinct legacy revision boundary;
- round-trip fixtures cover actor fixed, actor relative, area fixed, Natural-only, isolated Clear,
  explicit-hidden Clear, protected-object conflicts, and automatic guardrail rejection;
- malformed policies, duplicate IDs, unsupported combinations, and future versions fail;
- `pnpm --filter @ue-shed/cameras contract:check`, focused schema tests, and `pnpm typecheck` pass.

### Step 2: Add invocation provenance and separate temporary identities

Replace `CaptureReviewSetOptions`' implicit “capture now” semantics with an explicit decoded
Capture Invocation accepted by the public `ReviewCapture` service. Preserve ergonomic helpers that
construct a manual invocation, but make the service and Capture Run carry invocation ID/cause.

Extend CLI capture commands with:

- generated/manual invocation by default;
- explicit external-automation cause and optional bounded correlation ID;
- machine-readable invocation ID and cause in output; and
- no scheduling flags or daemon behavior.

Refactor provisioned-camera TypeScript interfaces into Effect Schemas and version the Remote Control
request. Replace overloaded `candidateId` with an explicit correlation union. Unreal assigns or
validates `ProvisionedCameraId`; status and frames retain enough identity to join a temporary camera
to an authoring candidate or Review View without treating array index as identity. Preserve old
request compatibility through a bounded decoder/migration for the current candidate release, then
emit only the new shape.

Capture Runs record invocation provenance without making external correlation semantic identity.
Bounded, versioned, namespaced runtime-trigger provenance supplied by tests or future callers
round-trips, but no trigger vocabulary or trigger source is implemented.

**Verify**:

- manual CLI behavior remains one command and returns invocation/run identity;
- two external invocations with the same correlation remain distinct attempts;
- candidate, View, provisioned camera, invocation, and run IDs cannot be interchanged in TypeScript;
- old provisioning request fixture is accepted during the compatibility window;
- Workbench and CLI use the same public service, and focused tests/typecheck pass.

### Step 3: Implement actor/world anchoring and the first area target

Keep framing calculations pure. Add explicit transformations between:

- an actor target's approved target-relative pose and the current resolved actor transform;
- a fixed world pose and capture realization; and
- an oriented-box area's bounds/orientation and framing inputs.

Approval stores the selected anchoring mode and the exact snapshot/provenance used. Existing Views
migrate to world-fixed. A target-relative View resolves the actor on every capture and derives the
effective world pose; it never overwrites the stored relative pose. The View Result records both
durable relative pose and effective world pose so reviewers can understand movement.

Add a narrow area-authoring operation. It may begin with numeric/current-selection bounds or a
fixture-supported region rather than a complex gizmo, but it must produce a portable map-scoped
oriented box and real preview/capture. Before changing Unreal behavior, extend the authoritative
capture-request contract under `packages/protocol/contracts/cameras/review` with a versioned
`oriented_bounds` resolved-subject variant, keep TypeScript/C++ fixtures conformant, and then teach
the editor capability to project supplied bounds without requiring an actor. Area visibility policy
defaults to Natural-only and rejects automatic hiding in this plan.

Add View revision metadata and a deliberate revise-pose operation. Changing target, anchoring,
pose, projection, or visibility meaning creates a new revision boundary. Existing immutable runs
continue referencing the revision captured. Pre-migration results without stored revision identity
remain readable under `legacy_unversioned`; history and comparison never silently group them with a
new numbered revision.

**Verify**:

- fixed actor View does not move when the actor moves;
- target-relative View derives a new world pose without mutating its durable relative pose;
- area/follow-target is rejected by construction;
- an area View survives restart and captures the same oriented bounds;
- history queries group by View and revision, and comparison across incompatible revisions returns a
  typed incompatibility instead of presenting one continuous history;
- the oriented-bounds wire contract, TypeScript decoder, C++ request model, and fixtures remain
  conformant before real area capture is enabled;
- real Unreal evidence matches expected transforms and leaves the map clean.

### Step 4: Establish a visibility-assessment capability and evidence contract

Implement assessment behind a narrow engine/host port so policy does not depend directly on one
algorithm. Verify UE 5.7 surfaces and measure at least:

1. bounded line/ray sampling from camera to subject sample points for cheap authoring feedback; and
2. a render-truthful image-space method based on a subject mask, depth comparison, or another
   verified Scene Capture technique.

Ray/collision results must be labeled diagnostic unless fixture evidence proves their correspondence
to rendered visibility for the supported subject. The durable capture default must use the
render-truthful method when its capability is available. Capability negotiation reports supported
methods; `automatic` resolves to an effective method and version recorded in the View Result.

Assessment must:

- operate from the exact effective capture pose/projection;
- distinguish subject missing, clipped, behind camera, unloaded/incomplete, assessment failed, and
  rendered occlusion;
- emit finite visible fraction and bounded classifications;
- attribute likely occluders only when evidence supports it;
- bound sample count, render target size, readback, object lists, and diagnostic payloads;
- avoid metric labels containing actor IDs/names; and
- remain useful without Workbench through library and CLI output.

Instrument assessment duration, auxiliary captures/readbacks, failures, and bounded counts through
structured spans/metrics. Do not log image bytes or unbounded object identity.

**Verify**:

- fixture cases cover clear, partial, full, missing, clipped, translucent/unsupported classification,
  and area behavior;
- quantitative results have tolerance-based real-Unreal assertions, not exact fragile pixels;
- assessment cannot report a valid percentage for missing/unloaded subjects;
- method/version and limitations appear in evidence;
- benchmark records added render/readback cost at supported resolutions;
- portable tests, fixture build, and real-Unreal integration pass.

### Step 5: Implement paired Pure/Clear capture with Unreal-owned restoration

Refactor one-View capture into one bounded host-visible Unreal operation with explicit reported
stages:

```text
resolve target
  -> derive effective pose
  -> wait for readiness
  -> assess visibility
  -> capture Pure
  -> prepare Clear intervention (if requested)
  -> capture Clear
  -> restore visibility
  -> verify restoration/map state
  -> finalize View Result
```

Unreal owns the intervention lifetime and an engine-side restoration guard; it restores before the
operation returns and reports every stage outcome. A streamed progress surface, if added, reports
the same operation and does not turn the stages into separately recoverable host commands. Use
Effect scoped resource ownership for host-side staging and atomic evidence finalization. Snapshot
only the visibility state the operation may modify. Do not mutate durable map/package state.

Implement:

- `natural_only`;
- `natural_and_clear` with `isolate_target`; and
- `natural_and_clear` with `hide_explicit`.

Pure always completes first. Clear uses the exact same pose, projection, resolution, effective
environment, and readiness snapshot or fails pairing validation. A Clear failure preserves valid
Pure evidence and completes the run with a typed partial failure. A restoration failure is prominent
even if both images were written, blocks baseline promotion of the pair, and retains diagnostics.

Store artifacts as stable `pure` and `clear` variants with hashes and relationship identity. Record
requested/effective visibility policy, resolved subject, interventions/reasons, assessment, and
restoration. Never infer Clear from a filename alone.

**Verify**:

- isolate target and explicit hide work against the fixture occluder;
- Pure visibly retains the occluder while Clear removes only the requested content;
- pose/projection mismatch invalidates the pair;
- missing explicit blocker fails Clear without discarding Pure;
- injected failures before, during, and after Clear restore original actor/component visibility;
- map dirty state is unchanged and no transient actor/render target leaks;
- immutable run finalization and repository recovery tests pass.

### Step 6: Evaluate detected-occluder policy without blocking the dependable path

Do not expose `hide_detected_occluders` merely because the union has a planned shape. First compare
assessment attribution with the deterministic fixture and at least one richer generic case. Produce
an evidence note covering false positives/negatives, collision/render disagreement, foliage,
translucency, compound subjects, large environment actors, and attribution uncertainty.

If the method is explainable enough, implement explicit opt-in with guardrails:

- maximum hidden actor/component count;
- protected-object locators and subject self-protection;
- deny broad environment objects/classes by generic capability, not project names;
- minimum attribution confidence/coverage;
- no automatic intervention for area targets in this plan;
- fail closed to Natural-only when guardrails reject candidates;
- full hidden-object/reason evidence and restoration; and
- capability/unsupported states in CLI and UI.

The main UI defaults to suggestion:

> A likely blocker has repeatedly obscured this target. Add it to Hide in Clear?

Automatic hiding is available only in Advanced settings after explicit policy selection. If the
evidence is not trustworthy, leave the strategy unsupported, retain diagnostic suggestions, update
the plan and product capability table with the rejected decision, and complete Plan 032 without
advertising or decoding that strategy as executable. A negative result is a valid completion of
this step; it does not weaken the assessment, explicit-hide, paired-capture, or restoration
criteria.

**Verify**:

- every outcome produces the evidence note and an explicit supported/rejected capability decision;
- a rejected outcome does not decode or display `hide_detected_occluders` as executable and retains
  diagnostic suggestions only;
- if enabled, the detected blocker matches the fixture occluder and never includes the subject;
- if enabled, protected and over-budget candidates are not hidden;
- if enabled, uncertain attribution produces warning/suggestion rather than intervention;
- if enabled, Pure remains valid, interruption restores all modified state, and diagnostics explain
  every accepted/rejected candidate;
- the applicable real-Unreal and targeted recovery gates report `RUN` and pass.

### Step 7: Build progressive-disclosure authoring and paired-review UX

Use the maintained extension as a client of public services. Preserve the simple path:

1. choose actor or area;
2. choose generated viewpoint;
3. choose **This place** or **This actor** where applicable;
4. Keep View using project defaults; and
5. Capture now.

Add a secondary Capture/Visibility summary showing named Capture Profile and Visibility Policy.
Advanced settings expose:

- assessment method;
- low-visibility threshold/action;
- Natural-only versus Natural + Clear;
- isolate/explicit/detected Clear strategy;
- Hide in Clear and Never hide lists;
- automatic guardrails; and
- capability/unsupported explanation.

Saving Advanced policy changes for one View creates an immutable replacement preset and reassigns
only that View. Applying the same preset to other Views is a separate, explicit bulk action that
shows the affected Views before confirmation. The ordinary path does not expose policy lifecycle
management.

Do not expose engine terms such as show-only arrays, Scene Capture flags, readback slots, or depth
capture sources. Provide direct object-selection handoff to Unreal and an inspectable list with
stable labels plus identity diagnostics.

History/review UX treats Pure/Clear as one result:

- Natural is visually primary;
- Clear carries a persistent **Modified visibility** label;
- instant toggle and side-by-side preserve matched framing;
- visibility status/fraction and assessment limitations are concise;
- an explainability panel lists interventions and restoration;
- failed/missing Clear remains visible beside valid Pure;
- View revision boundaries divide incompatible poses/policies; and
- capture cause distinguishes manual, external automation, and supplied runtime provenance without
  implying UE Shed scheduled it.

Use StyleX-local styles, existing accessibility/action patterns, keyboard access, reduced motion,
and no Workbench-only domain state.

**Verify**:

- ordinary actor authoring requires no Advanced interaction;
- defaults are visible before Keep and survive restart;
- advanced policy replacement and explicit multi-View application round-trip through the headless
  service without silently changing unrelated Views;
- unsupported options are disabled with explanation;
- Natural/Clear labels cannot be confused;
- visibility and restoration diagnostics are accessible;
- component tests and Workbench service tests pass.

### Step 8: Close CLI, automation, runtime-seam, and end-to-end evidence

Extend CLI commands to:

- validate/list Visibility Policies and View overrides;
- replace a View's immutable policy preset and explicitly apply a preset to selected Views;
- author or revise fixed/relative actor Views and fixed area Views;
- capture with manual or external-automation cause;
- inspect visibility assessment, interventions, restoration, and paired artifacts;
- return typed partial-failure exit behavior; and
- emit only schema-validated JSON.

Prove external automation without building a scheduler: run the same CLI capture twice from fresh
processes with explicit automation causes/correlations and show two immutable runs tied to the same
View revision and Approved Pose.

Prove the future runtime seam without building triggers: submit a validated runtime-trigger cause
through the public service/test port and show that its bounded namespaced provenance reaches the
finalized Capture Run. This proof uses the supported editor-world capture path and does not claim
PIE capture support. Do not add interval loops, event listeners, or sequence semantics.

Build one deterministic Workbench E2E:

1. author a fixed actor View through the simple path;
2. capture Natural with a known occluder and see a warning;
3. enable Natural + Clear with explicit blocker in Advanced;
4. capture and inspect the paired result/intervention;
5. simulate a Clear failure and prove Pure/restoration survive;
6. revise the View pose and see a history boundary; and
7. reopen Workbench and recover the same durable definitions/history.

Add a smaller area E2E or real-Unreal integration proving fixed area capture and Natural-only
semantics.

Update product delivery status, user vocabulary, supported/unsupported strategy table, CLI docs, and
showcase only after corresponding evidence passes. Record scheduling and simulation trigger
mechanisms as callers outside Map Review, not implemented features.

**Verify**:

- focused tests and contract parity pass;
- `pnpm fixture:build` and real Map Review integration pass on UE 5.7;
- `pnpm test:e2e:workbench` passes;
- `pnpm check` passes immediately before handoff;
- `git diff --check` reports no errors;
- only in-scope files plus Plan 032/index coordination are changed.

## Test plan

### Pure/schema tests

- old Review Set migration preserves IDs, Approved Pose, and Natural-only behavior;
- valid/invalid target/viewpoint unions;
- fixed versus target-relative transform derivation;
- oriented area validation and projection inputs;
- policy references/defaults/overrides and impossible combinations;
- invocation causes and branded identity separation;
- visibility classification thresholds and View revision compatibility;
- paired artifact invariants and partial-failure folds.

### Contract tests

- language-neutral provisioning and capture requests/responses;
- malformed/future versions;
- bounded list/count/string/path inputs;
- old provisioning compatibility fixture;
- assessment, intervention, restoration, and invocation round trips;
- TypeScript/C++ fixture parity.

### Unreal integration

- fixed actor, moved actor with fixed View, and target-relative actor;
- fixed oriented area;
- clear/partial/full occlusion;
- missing/clipped/unloaded distinctions;
- Pure + isolated Clear;
- Pure + explicit-hidden Clear;
- protected/automatic guardrails if Step 6 is earned;
- cancellation/failure at every intervention stage;
- restoration and unchanged map dirty state;
- no leaked actors, components, render targets, or readback resources.

### Service/repository/CLI

- invocation/run identity and provenance;
- two fresh-process external captures;
- immutable run finalization with paired and partial results;
- corrupt/interrupted staging recovery;
- typed exit behavior;
- no Workbench dependency;
- supplied runtime-trigger provenance without scheduling behavior.

### Component/Workbench

- unchanged simple path;
- fixed/follow explanation;
- policy presets and Advanced disclosure;
- object override editing;
- unsupported capability states;
- Natural/Clear inspection and labels;
- visibility/restoration explanation;
- View revision boundary;
- restart/recovery.

### Performance and observability

- assessment auxiliary capture/readback cost by method and resolution;
- Clear capture/intervention/restoration duration;
- bounded object/sample/mask payloads;
- no actor/object identity in metric labels;
- no recurring work without an invocation or live consumer;
- camera data-plane regression for authored and provisioned cameras.

## Done criteria

- [ ] Existing Review Sets migrate without View ID, Approved Pose, or Pure behavior drift.
- [ ] Review View supports actor fixed, actor target-relative, and fixed oriented-area semantics
      through discriminated schema variants.
- [ ] Capture Profile, immutable reusable Visibility Policy presets, and per-View object overrides
      are separate, validated concepts with simple defaults and no silent shared-policy mutation.
- [ ] Capture Invocation records why capture occurred without implementing or persisting a scheduler.
- [ ] Candidate, View, provisioned-camera, invocation, run, and artifact identities are not
      interchangeable.
- [ ] At least one render-truthful visibility assessment produces bounded, explainable evidence and
      distinguishes occlusion from missing/clipped/unready targets.
- [ ] Pure plus isolated/explicit-hidden Clear captures run as one guarded Unreal operation, share
      the exact pose/projection, retain immutable relationship metadata, and restore Unreal state on
      success, failure, and cancellation.
- [ ] Automatic detected-occluder behavior is either proven with guardrails and explicitly enabled,
      or rejected and recorded as unsupported; either result completes its non-blocking feasibility
      step, and an unsupported strategy is never exposed as a promise.
- [ ] The main authoring path remains select → frame → Keep with defaults; advanced visibility
      strategy remains available without becoming mandatory.
- [ ] Workbench history clearly labels Natural versus modified Clear, shows visibility/intervention/
      restoration evidence, and separates incompatible View revisions.
- [ ] CLI and public services provide full parity for definitions, invocation, capture, evidence,
      failures, and recovery.
- [ ] External automation is proven by explicit repeated invocation; no scheduling mechanism or
      **Watch** entity is added.
- [ ] Future runtime-trigger provenance can pass through the public seam without introducing timers,
      scenario coupling, or a universal event model.
- [ ] Fixture build, real UE 5.7 integration, Workbench E2E, contract gates, architecture gates, and
      `pnpm check` all pass.
- [ ] Product and showcase claims match only the strategies and UX actually proven.

## STOP conditions

- A Clear capture cannot guarantee that its Unreal-owned operation restores visibility on
  cancellation, timeout, editor teardown, or failure without mutating durable map/package state.
- UE 5.7 public Scene Capture/depth/visibility APIs cannot produce a render-truthful visibility
  assessment without copying engine implementation, relying on undefined behavior, or introducing
  unbounded GPU/readback cost.
- Pure and Clear cannot be proven to share the exact effective pose, projection, readiness, and
  environment.
- Area-target semantics require an implicit dynamic actor query or automatic hiding that the durable
  model cannot explain.
- Target-relative capture would silently rewrite Approved Pose or erase meaningful movement without
  an explicit author choice.
- Migration would reinterpret existing Pure evidence, change existing Approved Poses, or make old
  immutable Capture Runs invalid.
- Capture Invocation begins owning cron, CI, scenario timers, Observatory subscriptions, or a generic
  trigger bus.
- Workbench becomes the only way to configure policy, invoke capture, or inspect evidence.
- A new public schema is implemented as duplicated interfaces rather than Effect Schema/language-
  neutral authority.
- Any verification gate fails twice after focused in-scope correction.

## Maintenance notes

- New assessment/intervention variants are additive versioned capabilities. Never decode a planned
  but unsupported variant as executable.
- Keep algorithm choice out of the main user path, but retain exact effective method/version in
  evidence for historical interpretation.
- Area subjects, actor subjects, and future component/group subjects may share framing/visibility
  ports but must not share ambiguous identity semantics.
- A future automation runner consumes Capture Invocation; it does not add scheduling fields to
  Review View.
- A future sparse-observation/scenario plan may create repeated invocations or promote live frames.
  It must decide whether multiple samples form independent Capture Runs or a time sequence and add
  typed invocation provenance only after those semantics are earned; this plan deliberately does
  not.
- Reviewers should scrutinize schema migration, View revision identity, target-relative transforms,
  render/collision disagreement, visibility restoration, artifact pairing, cancellation, and any
  code path that could omit Pure or mislabel modified evidence.
