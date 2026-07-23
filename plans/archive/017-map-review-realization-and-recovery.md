# Plan 017: Verify realized framing and recover in-progress Map Review authoring

> **Executor instructions**: Follow this plan in order. Run each verification gate before moving
> to the next step. If a STOP condition occurs, stop and report it; do not broaden the feature.
> Update this plan's status row in `plans/README.md` only after all done criteria pass.
>
> **Drift check (run first)**:
> `git diff --stat b4a938f..HEAD -- packages/cameras extensions/camera-review apps/workbench fixtures/unreal-project unreal/Plugins/UEShedCameras docs/products/map-review.md`
> If the current code no longer matches the excerpts below, stop and reconcile the plan before
> editing.

## Status

- **State**: DONE — post-realization projection and authoring-session recovery verified on UE 5.7 fixture
- **Priority**: P0
- **Effort**: L
- **Risk**: MED — this extends a TypeScript/C++ Remote Control contract and persists a new local
  session document. Incorrect projection math could create false confidence; bad recovery must
  never silently approve or overwrite a Review View.
- **Depends on**: none
- **Category**: direction
- **Planned at**: commit `b4a938f`, 2026-07-20

## Why this matters

Map Review now takes an author from a selected actor through generated framing candidates, transient
previews, numeric adjustments, and an approved pose. The candidate only proves that the pure
framing algorithm produced a pose from a bounds snapshot, though: the Unreal capture response does
not report whether the realized view clipped or poorly framed the subject. In addition, the
renderer holds the entire in-progress authoring session in Solid signals, so a Workbench restart
loses the work before approval. This plan adds explicit, inspectable post-realization diagnostics
and a headless, project-local authoring-session service that can truthfully resume or invalidate
the draft.

The product decision is explicit: a changed subject must warn and require an intentional Reframe;
it must not silently move an Approved Pose. The durable unit remains a **Review View**, while
transient cameras, preview PNGs, and Workbench state must not become a second authority.

## Current state

- `docs/products/map-review.md:52-55` identifies post-realization projected-bounds diagnostics and
  restart-level authoring-session recovery as the remaining Slice 2 work. The same document's
  Slice 2 acceptance criteria at `:671-686` require a kept candidate to survive restart with the
  same Approved Pose and changed bounds to warn rather than silently reframe.
- `packages/cameras/src/review-framing.ts:93-145` derives candidates from a `SubjectBounds` snapshot
  and emits only the `bounds_snapshot` diagnostic. `framingDriftDiagnostics` at `:203-222` compares
  persisted and live bounds but is not fed by a post-realization projection.
- `packages/cameras/src/review-schema.ts:93-107` limits `FramingDiagnostic.code` to
  `bounds_snapshot`, `subject_bounds_changed`, and `manual_adjustment`. Its `ReviewCaptureSuccess`
  at `:212-238` returns staging path, resolution, and dirty-state evidence but no realized-subject
  framing result.
- `unreal/Plugins/UEShedCameras/Source/UEShedCamerasEditor/Private/UEShedCameraReviewLibrary.cpp:208-420`
  resolves the actor, creates an `ASceneCapture2D`, captures once, exports a PNG, destroys the
  transient actor, and returns the success JSON. It has the necessary actor bounds, pose,
  resolution, and transient capture component in one capability boundary.
- `packages/cameras/src/review-authoring-live.ts:102-171` calls `CaptureReviewView` for a candidate
  preview and returns only PNG bytes and dimensions. It is an Effect service (`ReviewAuthoring`),
  so new stateful workflow authority belongs below this interface, not inside a Solid component.
- `apps/workbench/src/main/services/map-review.ts:282-469` creates candidates, previews them, then
  re-inspects the current selection before approval. It correctly rejects actor or pose drift but
  has no persisted authoring-session identifier or resume operation.
- `extensions/camera-review/src/map-review-authoring.tsx:82-215` owns `state`, `selectedId`,
  `discarded`, `draftPose`, and `manualReason` only as `createSignal`s. Restarting Workbench loses
  them. Preview PNG bytes are intentionally renderer-only and must not be persisted.
- `packages/cameras/src/review-unreal.integration.test.ts:67-107` is the existing real-Unreal test
  pattern: select `ReviewSubject`, call the public TypeScript adapter, assert the result, and clean
  up. `extensions/camera-review/src/map-review-route.component.test.tsx:151-194` is the component
  test pattern for authoring state and explicit diagnostics.

### Repository conventions to follow

- TypeScript uses tabs, double quotes, semicolons, no trailing commas, and ~100-character lines.
- Effect owns workflows, services, resource safety, typed failures, and telemetry. Keep projection
  calculations and session transition functions pure. Use Effect Schema as the TypeScript runtime
  schema authority; infer types from it.
- Expected failures must be discriminated typed values with recovery guidance. Do not throw from a
  recoverable session path.
- `docs/products/map-review.md:133-141` defines user vocabulary. Use **Review View**, **Approved
  Pose**, **Reframe**, **Capture Run**, and **Review Set** in schemas, diagnostics, and UI; do not
  rename durable intent to a camera.
- Workbench is a complete client, never a privileged architecture layer. The CLI must be able to
  exercise any new headless session lifecycle introduced here.

## Commands you will need

| Purpose               | Command                                                                                                                                      | Expected success result                                                 |
| --------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------- |
| Fast TypeScript tests | `pnpm test:fast`                                                                                                                             | exit 0; all non-Unreal Vitest projects pass                             |
| Type checking         | `pnpm typecheck`                                                                                                                             | exit 0; no diagnostics                                                  |
| Architecture gates    | `pnpm effect:architecture && pnpm test:architecture`                                                                                         | exit 0                                                                  |
| Full repository gate  | `pnpm check`                                                                                                                                 | exit 0                                                                  |
| Fixture build         | `pnpm fixture:build`                                                                                                                         | exit 0; UE fixture plugins and project build successfully               |
| Real Map Review test  | `$env:UE_SHED_REMOTE_CONTROL_ENDPOINT='http://127.0.0.1:30001'; pnpm exec vitest run packages/cameras/src/review-unreal.integration.test.ts` | exit 0 after launching the fixture editor with Remote Control available |
| Workbench E2E         | `pnpm test:e2e:workbench`                                                                                                                    | exit 0; smoke and Map Review flows pass                                 |

The Unreal command assumes the fixture is open at the endpoint. Use `pnpm fixture:launch` or the
existing Workbench fixture launcher first; do not add a machine-specific engine path to code or
tests.

## Suggested executor toolkit

- Read `docs/engineering/effect.md`, `docs/engineering/types-and-errors.md`, and
  `docs/engineering/testing.md` before changing the TypeScript contracts or services.
- Verify Unreal APIs against `C:\\Program Files\\Epic Games\\UE_5.7\\Engine\\Source` before writing
  projection code. Use public engine APIs only; do not copy engine source.
- Use the `effect` skill when composing the authoring-session service and the `frontend-design`
  skill when updating the maintained Solid/StyleX authoring surface, if those skills are available.

## Scope

**In scope**:

- `packages/cameras/src/review-schema.ts`, `review-framing.ts`, `review-authoring-live.ts`,
  `review-repository.ts`, `review-ipc.ts`, `index.ts`, and focused tests — versioned schema,
  projection diagnostics, a project-local headless authoring-session repository/service, and IPC
  result shapes.
- `packages/cameras/src/review-session*.ts` — create focused pure lifecycle and persistence modules
  if the existing review modules would otherwise become incoherent.
- `apps/cli/src/command.ts`, `application.ts`, and tests — headless start/resume/show/discard or
  equivalent minimal session commands using the public service.
- `apps/workbench/src/main/services/map-review.ts`, the Map Review IPC/preload/client boundary, and
  focused tests — create/resume/update/discard the same session service; no renderer-owned source
  of truth.
- `extensions/camera-review/src/map-review-authoring.tsx`, client contract, component tests, and
  only directly-needed route wiring — render persisted session state, retain local blob URLs only,
  show diagnostics, and expose explicit Reframe/resume/discard actions with StyleX-local styles.
- `unreal/Plugins/UEShedCameras/Source/UEShedCamerasEditor/*` — emit bounded post-realization
  subject-projection diagnostics from the existing review capability.
- `fixtures/unreal-project/*` only if a deterministic subject move/scale or an explicit conformance
  fixture assertion is needed for these tests.
- `docs/products/map-review.md` — update Delivery status and Slice 2 acceptance only after the
  implementation and real-Unreal tests prove the claims.
- `plans/README.md` — mark Plan 017 DONE only when every done criterion holds.

**Out of scope**:

- Capture profiles, readiness/warm-up, multi-view cancellation, targeted retry, and run monitoring
  (Slice 3).
- Pure/Clear visibility interventions, automatic occluders, paired inspection (Slice 4).
- Baselines, image comparison, annotations, review decisions, hosted ingestion, or live-frame
  promotion (Slices 5–7).
- Persistent map actors, arbitrary environment scripting, studio-specific project conventions,
  filesystem locations, identities, or source-control assumptions.
- Persisting preview PNG bytes or temporary Unreal staging paths. They are disposable and must be
  regenerated after resume.

## Git workflow

- Branch: `feat/map-review-realization-recovery`.
- Follow the recent conventional history, for example `feat(map-review): add guided capture workflow`.
- Commit logical, verifiable slices only. Do not push or open a PR unless the operator asks.

## Steps

### Step 1: Define the projection and recoverable-session contracts first

Extend `packages/cameras/src/review-schema.ts` with a strict, versioned representation for a
post-realization result. It must describe the actor's eight local-bounds corners projected through
the actual transient perspective camera, including normalized screen rectangle, visible/fully
clipped/near-plane-crossing status, and explicit margin/clipping diagnostics. Use a discriminated
result rather than nullable coordinate bags: an unprojectable subject must say why and must be a
warning/error diagnostic, never a fabricated successful rectangle.

Add diagnostic codes and severity values narrowly. The minimum observable cases are: fully within
the requested framing margin, below requested margin, partially outside the viewport, fully outside
the viewport, and behind/crossing the near plane. Preserve `bounds_snapshot`,
`subject_bounds_changed`, and `manual_adjustment` unchanged for compatibility. Do not turn an
advisory projection warning into a capture failure: it blocks keeping an unreviewed candidate until
the author explicitly Reframes, but a durable existing Review View remains stable.

Define `ReviewAuthoringSession` with Effect Schema and branded session IDs. Persist only durable
draft intent: contract/version, Review Set path/reference and expected revision or content identity,
subject locator plus captured bounds/map snapshot, generated candidates and candidate poses,
selected candidate ID, discarded candidate IDs, draft pose/manual reason, diagnostics, lifecycle
(`active`, `stale`, `approved`, `discarded`), timestamps/provenance, and no preview bytes or local
absolute staging paths. Define discriminated recovery outcomes for: resumable, subject/map/bounds
stale (with Reframe guidance), missing Review Set, and malformed/corrupt session.

Update `review-ipc.ts` from the domain schema rather than independently duplicating a second
unvalidated TypeScript interface. Add the session ID and lifecycle/recovery data to authoring
responses and the required intents for resume/update/discard. Keep existing client paths additive
or migrate all call sites atomically.

**Verify**: add schema and pure transition tests covering valid decode; rejection of missing/invalid
projection fields; no preview bytes/staging paths in encoded session; stale bounds/map outcomes;
explicit discard; and an Approved Pose that never changes during a stale recovery. Run
`pnpm exec vitest run packages/cameras/src/review*.test.ts` → all pass.

### Step 2: Implement and prove engine-side post-realization projection evidence

In `UEShedCameraReviewLibrary.cpp`, retain the existing capture lifecycle: resolve the actor,
create a transient `ASceneCapture2D`, capture/export, detach target, destroy actor, and check map
dirty state. Before destroying the capture actor, calculate the actor bounds with the same
`GetActorBounds` semantics used by `InspectReviewSelection`; transform all eight world-space bounds
corners into the transient capture component's actual view/projection. Return only finite,
validated normalized coordinates and explicit status/diagnostics in the successful
`ue-shed-review-capture` response.

Use verified UE 5.7 public math/view APIs. Match the capture's FOV, aspect ratio, location,
rotation, and near-plane behavior. Treat a point behind the camera or crossing the near plane as a
truthful non-successful-projection diagnostic; do not clamp it to look valid. Use conservative,
documented margin thresholds in TypeScript (as product policy) rather than hard-coding a hidden
approval rule in C++.

Keep the existing major version 1 wire contract compatible by adding an optional minor-version
field, then make the new TypeScript decoder require it only for code paths that request/consume
post-realization evidence. Bump the response minor only when the new field is emitted. Update
`ReviewCaptureResponse`, `captureReviewView`, and `ReviewCandidatePreview` so the evidence reaches
the headless authoring service without a renderer-specific decoder.

**Verify**: `pnpm typecheck` → exit 0. Then `pnpm fixture:build` → exit 0. With the fixture editor
running, expand `packages/cameras/src/review-unreal.integration.test.ts` to assert: the normal
fixture candidate returns finite projected bounds with no clipping warning; a deliberately poor
pose returns a warning/invalid projection result rather than fake in-frame bounds; staging PNG
remains valid; and the map dirty state remains unchanged. Run the real Map Review command above →
all assertions pass.

### Step 3: Build the headless project-local authoring-session service

Create a narrowly scoped repository/service under `packages/cameras/src/` using the existing
`ReviewRepository` pattern in `review-repository.ts`: atomic staged writes, Effect Schema decode at
the filesystem boundary, typed `ReviewStorageError`-style failures, and structured spans. Store
sessions under a generic project-local path such as `.ue-shed/review/authoring-sessions/<id>.json`;
keep the path API configurable through the existing project-root boundary, never a studio path.

Implement pure lifecycle functions separately from filesystem effects. The service must:

1. start a session from an inspected actor/subject and generated candidates;
2. update selected candidate, discards, numeric draft pose, and manual-reason draft atomically;
3. record post-realization diagnostics for each preview without treating preview pixels as durable;
4. resume by loading the session, querying the persisted subject rather than trusting the current
   Workbench renderer selection, and compare map/actor/bounds against the stored snapshot;
5. return `stale` with explicit Reframe/discard guidance when the subject, map, or bounds changed;
6. mark an approved session immutable/complete only after `approveFramingCandidate` saves the
   Review Set successfully; and
7. discard sessions atomically without touching the Review Set or capture history.

If resuming a named actor requires a new Unreal capability, add one bounded `InspectReviewSubject`
method adjacent to `InspectReviewSelection`, with the same selection result shape but explicit
actor-path input. Validate the safe actor path at the TypeScript schema boundary and return typed
not-found/map-mismatch failures. Do not depend on the user's current editor selection to resume.

Expose this service through `@ue-shed/cameras`, then add minimal CLI parity: create/inspect/resume
or status/discard for a session, plus an explicit `reframe` path. CLI output must be JSON and use
the same discriminated results as Workbench. Do not add a CLI-only workflow.

**Verify**: add unit tests modelled on `review.test.ts` for atomic save/load, no previews on disk,
resume after constructing a fresh service instance, map/actor/bounds staleness, corrupt-session
diagnostics, successful approval, and discard. Add CLI command/parser/application tests. Run
`pnpm exec vitest run packages/cameras/src/review*.test.ts apps/cli/src/command.test.ts apps/cli/src/application.test.ts apps/cli/src/index.e2e.test.ts`
→ all pass.

### Step 4: Make Workbench and the maintained extension clients of that service

Replace renderer-only authoring authority in
`extensions/camera-review/src/map-review-authoring.tsx`. It may retain ephemeral blob URLs and
in-flight UI action state, but selected candidate, discarded candidates, pose edits, manual reason,
diagnostics, and session lifecycle must round-trip through the IPC-backed session service. On mount
or after an explicit recovery affordance, load the active authoring session. Re-request previews on
resume; never render persisted binary image data.

Extend `WorkbenchMapReview` and the typed IPC contract/preload/renderer client additively to start,
load/resume, patch, reframe, approve, and discard sessions. Each endpoint validates Effect Schema
input and returns a decoded discriminated result. Maintain the existing `coordinator.exclusive`
guard around Unreal interaction and Review Set writes; do not allow overlapping preview/reframe/
approve effects to race.

Render post-realization diagnostics on each candidate and the currently edited pose. Warn clearly
when a framing margin is insufficient or a subject clips; disable **Keep View** for a stale/invalid
session and guide the author to **Reframe selected actor**. Make resuming an active session visible
and make discard deliberate. Continue using local StyleX styles, `createEffectAction`, keyboard-
accessible native controls, existing visual vocabulary, and no global selectors.

**Verify**: add main-service tests to `apps/workbench/src/main/services/map-review.test.ts` for
fresh-service recovery, stale bounds/map responses, and no approval on stale input. Expand
`extensions/camera-review/src/map-review-route.component.test.tsx` to prove a refreshed component
loads the saved pose/discards/manual note, requests fresh previews, exposes diagnostics accessibly,
and only Reframe can clear a stale warning. Run
`pnpm exec vitest run apps/workbench/src/main/services/map-review.test.ts extensions/camera-review/src/map-review-route.component.test.tsx`
→ all pass.

### Step 5: Close the end-to-end proof and documentation

Extend `apps/workbench/e2e/workbench.smoke.e2e.ts` or a focused Map Review E2E with a deterministic
fixture flow: select the review subject; create a session; adjust one pose and discard one
candidate; restart/recreate Workbench; resume the same session and prove the draft survives while
previews regenerate; alter fixture subject bounds through a supported fixture action; prove the
session becomes stale, cannot Keep View, and requires an explicit Reframe; reframe and approve;
then verify the Review Set contains only the explicitly approved pose and no map modifications.

Update the product status only with the commands that actually passed. State that Slice 2 includes
realized projected-bounds diagnostics and session recovery; leave richer orientation, viewport
manipulation, Slice 3 capture policy, Clear, comparison, and review decisions as later work.

**Verify**: run `pnpm test:e2e:workbench` → exit 0, then `pnpm check` → exit 0. Inspect
`git diff --check` → no whitespace errors, and `git status --short` → only in-scope files plus the
Plan 017 index update are changed.

## Test plan

- Pure schema/lifecycle tests: accepted/rejected projection outcomes, session serialization, restart
  recovery, staleness, immutable approved pose, and discard.
- Contract tests: TypeScript decoder accepts the new success shape and preserves v1 failure shape;
  all IPC request/response schemas validate.
- Engine integration: normal fixture framing, deliberately bad framing, no false in-frame result,
  valid PNG, transient actor cleanup, and unchanged map dirty state.
- Service and CLI tests: recovery uses the same public camera session service; corrupt/missing/
  stale sessions return typed actionable results.
- Component tests: diagnostics are visible and accessible, recovered intent reloads, previews are
  regenerated, stale sessions cannot approve, and Reframe is explicit.
- Workbench E2E: one complete restart-and-stale/reframe flow using the deterministic fixture.

## Done criteria

- [x] A successful `CaptureReviewView` response carries finite, actual post-realization subject
      projection evidence, or a typed non-successful-projection diagnostic; no fake/clamped success.
- [x] Projection evidence is available to the headless camera authoring service and shown in the
      maintained Map Review extension without a Workbench-only decoder.
- [x] An unapproved Map Review authoring session survives a Workbench/service restart with pose,
      selected candidate, discards, manual reason, and diagnostics intact; preview media is regenerated
      and does not persist.
- [x] Changed subject/map/bounds returns a stale state with recovery guidance and cannot alter an
      Approved Pose until the author explicitly Reframes.
- [x] The public CLI exposes the same basic session recovery/discard/reframe lifecycle.
- [x] Real-Unreal fixture test, Workbench E2E, `pnpm typecheck`, `pnpm effect:architecture`,
      `pnpm test:architecture`, and `pnpm check` all exit 0.
- [x] `docs/products/map-review.md` status claims match the completed evidence.
- [x] No files outside the declared scope are modified; `plans/README.md` marks Plan 017 DONE.

## STOP conditions

- UE 5.7 public APIs cannot calculate a perspective projection that matches the `SceneCapture2D`
  used for the PNG without copying engine implementation or guessing its projection behavior.
- The C++ capability cannot distinguish behind/near-plane-crossing corners from a valid screen
  rectangle with a reliable public API.
- An authoring session cannot safely resume against a persisted subject without relying on ambient
  current selection, and a bounded actor-path inspection endpoint cannot be defined within the
  existing Remote Control security/contract boundary.
- A session update would need to change the Review Set before explicit Keep View, or approving a
  stale session could overwrite an Approved Pose.
- The implementation requires adding studio-specific schemas, paths, policies, or persistent map
  actors.
- Any verification gate fails twice after a focused, in-scope correction.

## Maintenance notes

- Capture Profile and Slice 3 work must consume projected diagnostics as evidence, not reinterpret
  them as automatic capture approval. Keep product policy thresholds in the TypeScript domain.
- Future component/region subjects must implement their own bounds/corner resolver; do not silently
  route them through the actor-path session schema.
- Reviewers should scrutinize matrix conventions, near-plane handling, schema backward
  compatibility, atomic session writes, cancellation/race behavior around preview actions, and any
  path that could persist binary previews or mutate a map.
- Image comparison, Clear variants, and review decisions remain deliberately deferred. They depend
  on this plan's truthful realization evidence but are not part of this feature.
