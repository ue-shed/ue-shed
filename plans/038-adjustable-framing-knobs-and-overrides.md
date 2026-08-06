# Plan 038: Adjustable framing knobs and per-camera overrides in Review View authoring

> **Executor instructions**: Follow this plan in order. Define the parameters and override schemas
> before touching generation, the authoring session, or the maintained UI. Keep the simple
> select -> frame -> Keep path byte-identical when defaults are used. Run every verification gate
> before advancing. If a STOP condition occurs, stop and report it rather than weakening evidence
> or exposing unbounded camera sets.
>
> **Drift check (run first)**:
> `git status --short -- packages/cameras packages/protocol apps/workbench extensions/camera-review docs/products/map-review.md plans/032-decouple-review-visibility-and-invocation.md`
> and
> `git diff --stat 8adaaad -- packages/cameras packages/protocol apps/workbench extensions/camera-review docs/products/map-review.md`.
> Then inspect the current `FramingCandidate`, `FramingRecipe`, `ReviewAuthoringSession`,
> `ReviewAuthoringSessionPatch`, and `MapReviewAuthoringPatchIntent` schemas. If recipe versioning,
> candidate identity, or the authoring-session patch surface changed, reconcile this plan before
> editing.

## Status

- **State**: TODO
- **Priority**: P1
- **Effort**: L
- **Risk**: MEDIUM — this changes portable Review View recipe data, framing candidate identity,
  authoring-session documents and patches, Workbench IPC intents, and the maintained authoring UX.
  It does not change Unreal capture contracts, visibility policy, or immutable evidence. Defaults
  must reproduce today's candidates exactly.
- **Depends on**: archived Plans 017 and 018, and the in-progress Plan 032 (schema foundations for
  `target`/`viewpoint`/Visibility Policy). Plan 032's visibility work is orthogonal; this plan
  layers framing parameters on top of its Review View and authoring-session schema.
- **Category**: feature
- **Planned at**: 2026-08-05, based on the framing implementation in `review-framing.ts` and the
  authoring session/Workbench surfaces.

## Why this matters

Map Review's authoring flow generates candidate views from three preset families plus the current
editor view. The presets are pure and deterministic, but every knob is a module constant in
`presetDefinitions` (`packages/cameras/src/review-framing.ts:193-236`): `distanceScale`,
`elevation`, `yawOffsetDegrees`/`worldYawDegrees`, plus global `fieldOfViewDegrees = 60` and
`margin = 0.12`. `generateFramingCandidates(selection)` takes no parameters, so an author cannot
tune the rig for a target without hand-editing the final pose numbers.

The live fast-preview loop (Plan 018) is precisely the affordance that makes tuning useful: change a
knob, regenerate the candidate set, re-provision the transient cameras, and the contact sheet
streams new frames. The durable model must keep the generated rig reproducible: parameters used to
generate a kept View must be baked into its Framing Recipe so repeat capture and later review can
explain the framing exactly as today's recipe explains preset lineage and manual offsets.

The product contract already names "preset parameters" as an input to framing generation
(`docs/products/map-review.md`, Framing section). This plan realizes that input and makes it
adjustable per target without turning framing into a generic camera editor.

## Enablement boundary

UE Shed's north star is what its libraries, protocols, CLI, and Unreal capabilities enable another
application to build. Framing is host-side pure transformation over normalized spatial inputs
(subject bounds, orientation signals, aspect, purpose, parameters). The Workbench is a dogfood
client for the tuning UX; the parameters and recipe schema are the durable public surface.

The parameters are durable definition data, not engine behavior. No Unreal plugin change is
required: the engine already realizes any `ApprovedPose`. The preview path (provisioned cameras and
live BGRA frames, or PNG fallback) already exists and is reused unchanged for regenerated sets.

## Product decisions fixed by this plan

- **Set-level knobs**: generation takes one `FramingParameters` value covering global FOV and
  margin plus per-preset controls (enabled, camera count, distance scale, elevation, yaw offset,
  spread or ring offset).
- **Keep the preset families**: Context three-quarter, Facade front, Cardinal orbit remain named
  presets. No generic free-form camera rig is introduced. Non-cardinal presets may generate more
  than one camera through a count and spread knob.
- **Defaults reproduce today**: with default parameters, `generateFramingCandidates` emits exactly
  the current candidate set (Context 1, Facade 1, Cardinals 4, plus optional editor view). Existing
  Review Sets and authoring sessions keep their behavior.
- **Per-target, baked on Keep**: parameters tuned during an authoring session are session state.
  Only when an author keeps a View are the effective parameters and any per-camera overrides baked
  into that View's Framing Recipe.
- **Per-camera overrides are additive and opt-in**: a candidate may carry a partial override of the
  set-level knobs. Overrides are disabled by default, the UI for them appears only when enabled, and
  only explicitly changed fields are stored; everything else inherits from the set knobs.
- **Candidate identity is generation-scoped**: `FramingCandidateId` becomes `preset/<n>/<index>`
  when a preset generates more than one camera. Overrides re-anchor by preset and index on
  regenerate; overrides that no longer map to a candidate are discarded, never guessed.
- **Approved-pose changes still bump View revision**: a per-camera override or manual pose edit that
  moves the approved pose changes the viewpoint and therefore the View revision, exactly as today.
  Parameter-only changes that keep the same approved pose are recipe provenance, not a new revision.
- **The simple path stays simple**: an author who never opens framing settings generates the default
  rig, sees live previews, and Keeps a View with no extra interaction.

## User stories and acceptance language

### Tune the rig for a target

A level artist opens Framing settings for a selected actor, raises the orbit elevation, widens the
Context yaw spread, and increases Facade to two cameras. The contact sheet updates live and the kept
View reproduces the same rig on every capture.

### Keep the default flow untouched

An author selects an actor, accepts a generated angle, and Keeps the View without opening Framing
settings. The candidate set, poses, recipe, and capture results are identical to today.

### One camera needs special treatment

A foreground element makes one orbit camera useless. The author enables per-camera overrides, moves
only that camera, and Keeps. The other cameras are untouched and the recipe records only the delta.

### Survive a parameter change mid-session

After adjusting the set-level distance knob, the candidate set regenerates. Cameras whose
preset+index still exist keep their per-camera overrides; overrides for cameras that no longer
exist are dropped without error.

### A revised rig is explainable

Reviewing history, a viewer opens a kept View's recipe and reads the exact parameters and per-camera
overrides used to generate the approved pose, in addition to the existing preset lineage and manual
adjustment note.

## Target model

The exact schemas must use Effect Schema, branded identifiers, and derived types. Defaults are the
single source of backward compatibility and must equal the current constants exactly.

### Framing parameters

```ts
FramingParameters = {
	fieldOfViewDegrees: number   // 5..170, default 60
	margin: number               // 0..0.45, default 0.12
	presets: {
		contextThreeQuarter: PresetKnobs
		facadeFront: PresetKnobs
		cardinalOrbit: OrbitKnobs
	}
}

PresetKnobs = {
	enabled: boolean             // default true
	count: number                // 1..6, default 1
	distanceScale: number        // finite > 0, defaults 1.8 / 1.25
	elevation: number            // finite, defaults 0.5 / 0.08
	yawOffsetDegrees: number     // finite, defaults 42 / 0
	spreadDegrees: number        // 0..180, default 0 (single camera has no spread)
}

OrbitKnobs = {
	enabled: boolean             // default true
	count: number                // 1..12, default 4
	distanceScale: number        // default 1.45
	elevation: number            // default 0.18
	ringOffsetDegrees: number    // 0..360, default 0 (current cardinals at 90/0/-90/180)
}
```

A generation is additionally bounded by a total camera cap (`maxFramingCameras`, default 24). If the
sum of enabled preset counts exceeds the cap, generation fails with a typed domain error rather than
silently truncating.

### Per-camera overrides

```ts
FramingCandidateOverrides = {
	distanceScale?: number
	elevation?: number
	yawOffsetDegrees?: number
	fieldOfViewDegrees?: number
	margin?: number
}
```

Only present keys override the set-level parameters. `spreadDegrees`/`ringOffsetDegrees` and `count`
are set-level only; a per-camera override never changes how many cameras exist.

### Recipe and candidate identity

- `PresetFramingRecipe` advances to `version: 2` with optional `parameters?: FramingParameters` and
  `candidateOverrides?: FramingCandidateOverrides`. A v1 recipe decodes with defaults, preserving
  today's meaning. Both fields are baked on Keep and are durable provenance, not capture inputs.
- `FramingCandidateId` becomes `preset/<preset>/<index>` (1-based) when the preset generates more
  than one camera, and keeps the stable name for single-camera presets where practical. Candidate
  IDs are valid only within one generated set.

### Authoring session

- `ReviewAuthoringSession` gains optional `framingParameters` and
  `candidateOverrides: ReadonlyArray<{ candidateId, overrides }>`.
- `ReviewAuthoringSessionPatch` gains optional `framingParameters` and `candidateOverrides`.
- A patch carrying `framingParameters` regenerates the candidate set from the stored subject bounds
  and the new parameters, re-anchors surviving overrides by preset+index, and returns the refreshed
  set. A patch carrying only `candidateOverrides` updates the selected candidate in place without
  regenerating the set.
- `approve` bakes the effective parameters and the kept candidate's overrides into the View recipe.

### Workbench IPC and client

- `MapReviewAuthoringPatchIntent` carries the optional `framingParameters` and `candidateOverrides`.
- `WorkbenchMapReview` authoring flows regenerate or patch candidates and preserve the existing
  preview/provisioning behavior, so the contact sheet streams live frames for changed cameras and
  keeps bindings for unchanged ones where the producer allows.

## Current state

- `packages/cameras/src/review-framing.ts:193-236` holds `presetDefinitions` with frozen
  `distanceScale`, `elevation`, and yaw values; `candidateFromPreset` reads them plus
  `defaultFieldOfViewDegrees`/`defaultMargin` and `fitDistance`/`aimAt`.
- `generateFramingCandidates(selection)` takes only the selection; the editor-view candidate is
  appended when `selection.editorView` is present.
- `FramingCandidate.recipe` is `PresetFramingRecipe` version 1 with `preset`, `margin`,
  `subjectBounds`, and optional `manualAdjustment`.
- `FramingCandidateId` is the preset name (e.g. `cardinal_north`, `editor-view`).
- `ReviewAuthoringSession` stores candidates, discarded IDs, `draftPose`, `manualReason`, selected
  ID, and realizations; `ReviewAuthoringSessionPatch` covers discarded IDs, draft pose, manual
  reason, and selected ID.
- The Workbench authoring service generates candidates (`apps/workbench/src/main/services/map-review.ts:1096`,
  `:1230`, `:1529`, `:1594`) and the extension renders a contact sheet with live per-candidate
  previews (`extensions/camera-review/src/map-review-authoring.tsx`).
- The product contract names preset parameters as a framing input but ships no adjustable surface;
  `docs/products/map-review.md` status claims do not cover framing parameters.

## Commands you will need

| Purpose                   | Command                                                                                                       | Expected success result           |
| ------------------------- | ------------------------------------------------------------------------------------------------------------- | --------------------------------- |
| Focused framing/session   | `pnpm test packages/cameras/src/review-framing.test.ts packages/cameras/src/review-authoring-session.test.ts` | focused portable tests pass       |
| Contracts                 | `pnpm --filter @ue-shed/cameras contract:check`                                                               | fixtures and parity pass          |
| Workbench/extension tests | `pnpm test apps/workbench/src/main/services/map-review.test.ts extensions/camera-review/src`                  | service and component tests pass  |
| Type checking             | `pnpm typecheck`                                                                                              | exit 0                            |
| Architecture gates        | `pnpm effect:architecture && pnpm test:architecture`                                                          | exit 0                            |
| Full repository gate      | `pnpm check`                                                                                                  | exit 0 immediately before handoff |

Note: full `pnpm check` is currently blocked outside this plan by an untracked Enhanced Input
browser entrypoint importing a missing `./atlas.js` module. That must be resolved before a green
handoff; report it rather than silently skipping gates.

## Suggested executor toolkit

- Read `docs/engineering/effect.md`, `types-and-errors.md`, `testing.md`, and `agent-adoption.md`
  before changing public schemas, the session service, or the maintained UI.
- Use the `effect` skill for the session regeneration flow, typed failures, and debounce/cancellation.
- Use `quality-code` for schema derivation and bounded discrimated parameter values.
- Use `frontend-design` and `emil-design-eng` for the progressive-disclosure knob UI and live
  preview updates.

## Scope

**In scope**:

- `FramingParameters`, `PresetKnobs`, `OrbitKnobs`, and `FramingCandidateOverrides` Effect Schemas
  with bounded defaults equal to current constants.
- Parameterized `generateFramingCandidates(selection, parameters?)` with an explicit total camera
  cap and typed failure.
- `applyCandidateOverrides` pure helper for additive per-camera overrides.
- Recipe v2 with optional parameters/overrides and v1 decoding; `FramingCandidateId` update.
- Authoring-session `framingParameters`/`candidateOverrides`, patch surface, regenerate with
  override re-anchoring, and baking on approve.
- Workbench IPC/client plumbing and the maintained authoring UX (set knobs + opt-in per-camera
  overrides) with live preview refresh.
- Component/service/property tests, fixtures, and product-doc updates after evidence passes.

**Out of scope**:

- Any Unreal plugin or capture-contract change; the engine realizes `ApprovedPose` unchanged.
- Visibility Policy, Clear capture, or invocation changes (Plan 032 owns those).
- Generic free-form camera rigs, arbitrary splines, or camera-editor tooling.
- Changing `ApprovedPose`, `SubjectLocator`, `ReviewTarget`, or `ReviewViewpoint` meaning.
- Scheduling, timers, or automatic reframing on subject movement.

## Git workflow

- Branch: `feat/map-review-framing-knobs`.
- Use logical commits that leave focused tests green: schemas/recipe, generation, session,
  IPC/Workbench, UI, then docs.
- Do not push, open a PR, or publish unless the operator asks.

## Steps

### Step 1: Add Framing Parameters and override schemas; freeze defaults

Add `FramingParameters`, `PresetKnobs`, `OrbitKnobs`, and `FramingCandidateOverrides` to
`packages/cameras/src/review-schema.ts` with the bounds above. Export `defaultFramingParameters()`
from `review-framing.ts` whose values exactly equal today's `presetDefinitions` and
`defaultFieldOfViewDegrees`/`defaultMargin`. Add a `maxFramingCameras` bound and a typed
`framing_camera_limit_exceeded` domain error.

Advance `PresetFramingRecipe` to version 2 with optional `parameters` and `candidateOverrides`;
v1 recipes decode with defaults. Update `FramingCandidateId` generation so multi-camera presets use
`preset/<preset>/<index>` while single-camera presets keep the stable name where practical.

**Verify**:

- `defaultFramingParameters()` matches the constants table exactly (a test asserts each value);
- `FramingParameters` rejects out-of-bounds knobs and invalid counts;
- v1 recipe fixtures decode without loss; v2 recipes round-trip;
- a generation whose total count exceeds `maxFramingCameras` fails with the typed error;
- `pnpm --filter @ue-shed/cameras contract:check` and `pnpm typecheck` pass.

### Step 2: Parameterize generation and add pure per-camera overrides

Change `generateFramingCandidates(selection, parameters = defaultFramingParameters())`. Spread
semantics: Context and Facade distribute `count` cameras across `[yawOffsetDegrees - spreadDegrees/2,
yawOffsetDegrees + spreadDegrees/2]` around the facing axis (single camera at `yawOffsetDegrees`);
the Cardinal orbit places `count` cameras evenly at `360/count` steps starting at
`ringOffsetDegrees`. Keep the editor-view candidate behavior unchanged.

Add `applyCandidateOverrides(candidate, overrides)` that recomputes only that candidate's pose from
its recipe `subjectBounds`, the generation parameters, and the override deltas. It must be pure and
leave the candidate ID, diagnostics, and recipe provenance intact except for the recorded overrides.

**Verify**:

- default parameters produce the exact current candidate set (pose-for-pose assertion);
- Context count 3 with spread 60 produces three distinct angles within the arc;
- orbit count 8 produces 45-degree steps from `ringOffsetDegrees`;
- per-camera override changes only the target camera's pose and only for present fields;
- property tests cover finite output, no NaN, and candidate-count bounds;
- `pnpm test packages/cameras/src/review-framing.test.ts` passes.

### Step 3: Carry parameters and overrides through the authoring session

Extend `ReviewAuthoringSession` and `ReviewAuthoringSessionPatch` with optional
`framingParameters` and `candidateOverrides`. Implement session regeneration: a patch with
`framingParameters` regenerates candidates from the stored subject bounds with the new parameters,
re-anchors overrides by `preset/<preset>/<index>`, drops unmappable overrides, and returns the
refreshed session. A patch with only `candidateOverrides` updates the selected candidate in place.

On `approve`, bake the effective parameters and the kept candidate's overrides into the View recipe
(v2) before saving the Review Set. Keep the simple approve path unchanged when no parameters were
tuned.

**Verify**:

- parameter-only patches regenerate the set and preserve resumability;
- overrides survive regeneration when their preset+index still exists and are dropped otherwise;
- approved Views carry v2 recipes with parameters/overrides; untuned approvals carry v1-equivalent
  meaning and pass the existing migration tests;
- `review-authoring-session.test.ts` and `map-review.test.ts` pass.

### Step 4: Plumb through Workbench IPC and the maintained UX

Extend `MapReviewAuthoringPatchIntent` with optional `framingParameters`/`candidateOverrides` and
the Workbench authoring service accordingly (`apps/workbench/src/main/services/map-review.ts`).
Add a progressive "Framing" disclosure in `extensions/camera-review/src/map-review-authoring.tsx`:

- set-level knobs per preset (enabled, count, distance, elevation, yaw offset, spread/ring offset)
  plus global FOV and margin;
- an opt-in **Per-camera overrides** toggle, hidden until enabled, showing the selected candidate's
  knob panel initialized from the set values and saving only deltas;
- debounced (about 400 ms) regeneration that reuses the existing preview/provisioning path; the
  contact sheet keeps live bindings where the producer allows and falls back to PNG when the editor
  is stopped;
- visible framing-camera-limit errors instead of truncated sets.

The default flow must render and behave identically to today's contact sheet.

**Verify**:

- knob changes produce refreshed previews without requiring a manual reframe click;
- per-camera overrides apply only to the selected candidate and stay additive;
- the limit error is shown and no partial set is presented as complete;
- component tests cover knob editing, the overrides toggle, and debounced regeneration;
- `pnpm test apps/workbench/src/main/services/map-review.test.ts extensions/camera-review/src` passes.

### Step 5: Prove durability, restart recovery, and update the product contract

Test that a kept View with tuned parameters and overrides survives a restart, reproduces the same
rig on capture, and that a v1 Review Set remains valid and captures identically. Record the framing
parameter surface in the CLI docs and product contract only after the above evidence passes: the
framing recipe now carries parameters/overrides; CLI validation must accept v2 recipes.

**Verify**:

- restart/recovery tests pass with tuned parameters;
- `pnpm typecheck`, `pnpm effect:architecture`, `pnpm test:architecture`, and focused gates pass;
- product and CLI docs claim only the surfaces actually proven;
- `pnpm check` passes immediately before handoff once the external `atlas.js` blocker is resolved.

## Test plan

### Pure/property

- defaults equal current constants and reproduce current candidates exactly;
- parameter bounds and total-camera cap;
- spread/ring distributions for varied counts;
- per-camera override additivity and non-mutation of other cameras;
- v1 recipe decoding and v2 round-trip;
- candidate ID scheme stability within a generated set.

### Session/service

- parameter patches regenerate; override re-anchoring and dropping;
- approve bakes v2 recipes; untuned approvals keep v1-equivalent meaning;
- restart resumes tuned sessions; stale/bounds-changed recovery unchanged.

### Contract

- `MapReviewAuthoringPatchIntent` round-trips optional parameters/overrides;
- fixtures accept v1 and v2 recipes;
- malformed knobs and over-cap generations fail with typed errors.

### Component

- simple path identical; knob panel disclosure; per-camera override toggle;
- debounced regeneration; limit error rendering; live-bindings preservation.

## Done criteria

- [ ] `generateFramingCandidates` accepts parameters; defaults reproduce today's candidates exactly.
- [ ] Context/Facade support count+spread; Cardinal orbit supports count+ring offset; all knobs
      bounded and set-level.
- [ ] Per-camera overrides are additive, opt-in, keyed by preset+index, and re-anchor on regenerate.
- [ ] Kept Views bake effective parameters/overrides into a versioned Framing Recipe; v1 recipes
      remain readable and valid.
- [ ] The Workbench tuning UX updates live previews and keeps the default flow unchanged; the
      framing-camera limit is an explicit error, never a silent truncation.
- [ ] Parameter/override changes that move an approved pose bump the View revision; parameter-only
      changes are recipe provenance.
- [ ] No Unreal capture-contract, visibility-policy, or invocation change is made.
- [ ] Focused tests, contract gates, architecture gates, and `pnpm check` pass; the external
      `atlas.js` blocker is resolved or explicitly reported as remaining.

## STOP conditions

- Defaults fail to reproduce the current candidate set, changing existing authoring behavior.
- Parameter or override values can reach Unreal unbounded or produce non-finite poses.
- Overrides are applied to the wrong camera after regeneration, or unmappable overrides are
  guessed rather than dropped.
- Approve silently changes an approved pose or recipe meaning for untuned Views.
- The Workbench becomes the only way to configure framing; the durable recipe and library
  generation must remain usable headless and from the CLI.
- A verification gate fails twice after focused in-scope correction.

## Maintenance notes

- New knobs are additive optional fields with defaults; never reinterpret existing recipe fields.
- Keep generation pure; do not move parameter math into the session service or UI.
- Candidate identity is generation-scoped; never persist candidate IDs as durable View identity.
- A future plan may add reusable named parameter presets; this plan deliberately stores parameters
  per target on Keep instead.
