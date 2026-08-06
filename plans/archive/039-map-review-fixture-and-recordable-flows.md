# Plan 039: Build a Map Review fixture gallery and recordable full flows

> **Executor instructions**: Read this plan fully before editing. Keep each flow executable through
> one shared implementation in assertion-only and recorded modes. Do not create a recording-only
> demo path that can drift from E2E behavior.
>
> **Drift check (run first)**: inspect the camera fixture commandlet and contract, Map Review
> authoring E2E, real-Unreal review integration, showcase recorder manifest, and current Plan 038
> recipe/session contracts. Record any changed paths or commands here before implementation.

## Status

- **Priority**: P1
- **Effort**: XL
- **Risk**: HIGH — this adds deterministic Unreal content, exercises production Electron against a
  live editor, restarts persisted sessions, and produces review artifacts. Cleanup and truthful
  evidence are part of correctness.
- **Depends on**: archived Plans 017, 018, 032, and 038.
- **Category**: test infrastructure and fixture depth
- **Planned at**: commit `b4922eb`, 2026-08-06.
- **Status**: DONE — UE 5.7 gallery, trusted flows, and recordings verified

## Outcome

Map Review has a dedicated deterministic fixture gallery and named full-flow journeys. A journey can
run as an ordinary E2E test or, on demand, record the same actions as a review bundle containing a
video, Playwright trace, logs, chapter screenshots, raw Unreal captures, and the durable JSON that
proves restart/load behavior.

The acceptance unit is a real product flow:

1. select a fixture subject;
2. generate and tune a camera rig;
3. inspect live previews;
4. approve a candidate;
5. persist the authoring session and Review View;
6. close and relaunch Workbench;
7. load the persisted result;
8. capture it through Unreal;
9. inspect the immutable screenshot and evidence;
10. clean up without dirtying the map or leaking transient camera resources.

## Design decisions

### One flow, two artifact policies

A flow owns actions and assertions. It receives a checkpoint sink:

- the normal test sink records lightweight Playwright attachments only on failure or explicit
  checkpoints;
- the recording sink adds chapter cards/dwell time, UI screenshots, video, trace, logs, raw capture
  copies, and a manifest entry.

Recording must never weaken, skip, or replace the assertions. Recording-only delays and annotations
belong in the sink, not in flow actions.

### Dedicated Map Review gallery

Do not continue growing `/Game/Fixture/Cameras/L_CameraLoad`. That level deliberately contains 4,096
movers and 32 observation cameras and remains the performance/load fixture.

Generate `/Game/Fixture/MapReview/L_MapReviewFixture` from the existing fixture commandlet. Arrange
spatially separated, labeled bays with stable contract-owned actor paths and transforms:

- compact subject;
- tall/narrow subject;
- wide/low subject;
- rotated asymmetric subject;
- compound subject with child components;
- unobstructed, partially occluded, and fully occluded opaque subjects;
- translucent subject;
- interior/enclosure with foreground, side, and overhead obstruction;
- floor, wall, column, and background depth anchors that make screenshots legible.

Use Engine basic shapes and generated materials already permitted by the fixture. Fixture-specific
names stay in fixture sources and tests; no runtime package may depend on them.

The commandlet must verify exact required actors, tags, transforms, primitive/material intent, and
map dirtiness expectations. The fixture contract is the source for test actor paths rather than
duplicated string literals throughout TypeScript.

### Evidence, not brittle beauty snapshots

Raw images are first-class human-review artifacts, but exact pixel matching is not the primary test
oracle. Automated assertions prefer:

- realized pose, FOV, and candidate identity;
- projected bounds and viewport status;
- visibility method/status/fraction bands;
- persisted recipe/session/View identity;
- capture dimensions and non-empty image evidence;
- immutable run/artifact relationships;
- map dirty state and transient resource cleanup.

A few broad image checks may detect blank, uniform, or missing renders. Do not introduce
machine-specific golden-image thresholds without cross-machine evidence.

## Named flows

### `authoring-roundtrip`

Start clean, select the compound subject, generate a rig, change group count and framing parameters,
set one candidate override, preview it, Keep the View, close Workbench, relaunch with the same
authoring/repository roots, load the persisted View, capture it, and inspect the resulting PNG and
capture evidence.

### `framing-gallery`

Exercise compact, tall, wide, rotated, asymmetric, and compound subjects. Prove exact generated
counts, valid projections, meaningful variation between arc/ring poses, and usable previews without
assuming every subject should use one hard-coded framing preset.

### `occlusion-walkthrough`

Capture unobstructed, partial, full, translucent, and enclosure cases. Record Natural screenshots
and raw visibility evidence. Where a supported explicit Clear policy is requested, retain paired and
labeled evidence and prove restoration.

### `high-count-rig`

Request 37 candidates through the permissive headless contract, let Workbench present them through
its bounded producer/concurrency path, select and approve one candidate, restart, and capture it.
The UI may warn; it must not rewrite the requested count to 24.

### `recovery`

Persist tuning, restart, mutate fixture subject bounds, show stale framing honestly, reframe, retain
only overrides whose candidate IDs remain meaningful, approve, capture, and restore the fixture.

## Artifact contract

Each recorded run writes beneath `test-results/map-review-flows/<run-id>/`:

```text
manifest.json
flow.webm
traces/segment-*.zip
logs.txt
chapters/*.png
captures/*.png
persisted/*.json
```

The versioned manifest records:

- flow and checkpoint identity;
- Git commit and dirty status;
- fixture map and subject key from the fixture contract;
- authoring session, candidate, Review View/revision, invocation, run, and artifact IDs when
  available;
- paths and media metadata for every attached artifact;
- timestamps, pass/fail status, and typed failure summary;
- cleanup/restoration outcome.

Paths in the manifest are relative to the bundle. Never record credentials, arbitrary environment
variables, machine paths, or Remote Control secrets.

## Commands

Target public commands:

```text
pnpm fixture:build
pnpm test:unreal-review
pnpm test:flow:map-review
pnpm record:flow:map-review -- --flow authoring-roundtrip
pnpm record:flow:map-review -- --flow high-count-rig
pnpm check
```

The flow test command may be environment-gated like existing trusted Unreal evidence, but must print
`RUN` or an explicit `SKIP` reason. Recording is always opt-in and must print the final bundle path.

## Steps

### Step 1: Generate and verify the dedicated gallery

Extend the fixture commandlet, generated level evidence, and `fixture-contract.json`. Build and
verify the level with UE 5.7. Keep the load map unchanged except for any migration needed to remove
Map Review-only objects after the new gallery is proven.

**Verify**: `pnpm fixture:build` and `pnpm fixture:verify` report every gallery bay and actor contract;
the saved map opens without dirty state.

### Step 2: Extract the reusable flow and checkpoint boundary

Move Map Review authoring actions out of individual Playwright tests into a typed flow driver. Add
checkpoint sinks for normal E2E and recording. Keep selectors in the existing page-object boundary
where practical. Define and test the versioned recording manifest decoder.

**Verify**: a unit/fixture test proves both sinks observe the same ordered checkpoints and that the
manifest rejects absolute paths, missing artifacts, unknown flow IDs, and secret-like environment
payloads.

### Step 3: Prove the authoring round trip

Implement `authoring-roundtrip` first. It must create all required state itself; remove the current
Map Review recorder prerequisite for an earlier Capture Run. Assert disk persistence before restart
and load the same View/revision after restart. Attach the raw Unreal capture, not only a screenshot of
the Workbench image element.

**Verify**: the normal flow passes against UE 5.7; recorded mode produces a decodable complete bundle
whose screenshots and raw capture dimensions are asserted.

### Step 4: Add gallery, occlusion, high-count, and recovery flows

Build the remaining flows on the same driver. Share setup and cleanup mechanics, not scenario
assertions. Keep a small number of rich flows with multiple truthful checkpoints rather than many
duplicated launch tests.

**Verify**: each named scenario runs independently, cleans its session/capture staging, restores
mutated actors, and leaves the map clean. The two complete restart/load journeys record their own
bundle on demand; gallery, occlusion, and recovery retain focused Playwright evidence without
claiming to be persistence recordings.

### Step 5: Integrate commands, documentation, and trusted gates

Add root commands, update testing/showcase/product documentation, and describe expected runtime and
artifact retention. Keep ordinary `pnpm check` portable; connect the real flow suite to the existing
trusted Unreal gate without making recording mandatory in CI.

**Verify**: portable tests, Workbench E2E, `pnpm test:unreal-review`, every recordable flow, and final
`pnpm check` pass. Review at least one bundle manually before archiving this plan.

## Done criteria

- [x] A dedicated deterministic Map Review gallery exists and is contract-verified in UE 5.7.
- [x] Test and recording modes execute the same typed flow actions and assertions.
- [x] `authoring-roundtrip` covers setup, tuning, preview, approval, disk persistence, restart/load,
      capture, screenshot inspection, and cleanup.
- [x] Gallery, occlusion, 37-candidate, and recovery flows pass independently.
- [x] Recorded bundles contain video, trace, logs, chapter screenshots, raw Unreal captures, durable
      JSON evidence, and a decodable versioned manifest.
- [x] Recording flows bootstrap their own state and never require a prior local Capture Run.
- [x] Assertions prove pose/projection/visibility/persistence/cleanup semantics without relying on
      byte-identical or machine-specific golden images.
- [x] No run dirties the fixture map or leaks provisioned cameras, render targets, or staging files.
- [x] The headless camera primitives remain modular and permissive; showcase limits remain soft or
      explicit producer capabilities.
- [x] Documentation and commands make both normal and recorded execution discoverable.
- [x] `pnpm check`, fixture verification, real-Unreal review, and named flow gates pass.

## STOP conditions

- A proposed flow needs a Workbench-only domain operation rather than a headless camera/review
  capability.
- Recording mode would execute different product actions or skip assertions compared with test mode.
- The fixture requires Marketplace/studio assets, network access, or machine-specific paths.
- A test mutates a fixture actor or editor state without a `finally`/scope restoration path.
- Cleanup cannot prove map dirtiness and transient camera/render resource state.
- Reliable automation would require exact cross-machine pixel identity.
- A manifest would include credentials, arbitrary environment dumps, or absolute machine paths.

## Maintenance notes

Add a new named flow only when it represents a distinct user journey or failure/recovery boundary.
Prefer extending checkpoints within an existing flow over duplicating setup. Keep fixture bays simple,
spatially isolated, and contract-described so future camera primitives can reuse them headlessly.
