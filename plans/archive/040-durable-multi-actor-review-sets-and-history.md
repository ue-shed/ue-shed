# Plan 040: Build durable multi-actor Review Sets and longitudinal visual history

> **Executor instructions**: Keep Review Set and Review View as the durable public language. An
> actor-grouped Workbench presentation is an interim projection, not permission to introduce an
> `ActorSet` entity or freeze the broader product vision. Build headless operations first, then use
> them from CLI and Workbench. Every live test that mutates the fixture owns restoration and host
> process cleanup according to explicit launch ownership.

## Status

- **Priority**: P1
- **Effort**: XL
- **Risk**: HIGH — this changes durable authoring semantics and longitudinal evidence navigation.
- **Depends on**: archived Plans 032, 038, and 039.
- **Category**: Map Review product vertical
- **Planned at**: commit `7c849b2`, 2026-08-07.
- **Status**: DONE — durable collections, View history, UE 5.7 flows, and recordings verified

## Outcome

A user can build a map-scoped collection of important actors, approve one or more durable Review
Views for each actor, restart Workbench, recapture the collection repeatedly, and inspect how the
same View looked across immutable Capture Runs.

The acceptance journey is:

1. open or create a Review Set for the current map;
2. add several selected actors without replacing existing Views;
3. add an additional viewpoint for at least one actor;
4. persist the complete collection and restart Workbench;
5. load the same ordered Views and revisions;
6. capture the complete set as Run A;
7. make a controlled fixture change;
8. capture the same Views as Run B;
9. navigate one View's Run A/Run B evidence and compare it visibly;
10. restore the fixture and clean all transient resources.

## Product boundary

### Existing durable language remains authoritative

- A Review Set is a portable, map-scoped collection of ordered Review Views.
- A Review View is the longitudinal comparison anchor.
- Each View owns one subject locator, Approved Pose, Framing Recipe, revision, Capture Profile, and
  Visibility Policy reference.
- Several Views may observe one subject; several subjects may coexist in one set.
- Capture Runs remain immutable and retain one result per attempted View and View revision.

Do not add an `ActorSet` schema. Workbench may group Views by normalized subject identity for
legibility, but persistence remains a flat ordered View collection until the wider product vision
earns another concept.

### Authoring operations are explicit

Replace implicit `views[0]` behavior with explicit intent:

- `append_view`: add a newly approved View for the selected subject;
- `revise_view`: reframe one identified existing View while preserving its View ID and advancing
  its revision;
- later operations such as duplicate, reorder, retag, or remove must be explicit and independently
  authorized rather than overloaded onto selection.

Appending never replaces an existing View. Reframing never creates an unrelated View. A new View ID
is stable after persistence, safe for portable JSON, and collision-free within its Review Set.

### History is View-oriented

Run history must answer: “How did this approved observation look over time?” It groups Views by
subject for navigation while retaining:

- missing versus failed versus captured results;
- View revision used by each result;
- Natural and explicitly modified Clear variants;
- current, previous, and baseline comparison targets without pixel-score judgment;
- captures from older View revisions without pretending their framing is identical.

## Implementation steps

### Step 1: Add public append/revise authoring intent

Introduce schema-owned authoring destination variants and pure helpers for collision-free View IDs
and append plans. Update the Effect authoring-session service so first-run and existing-set creation
share one implementation. Preserve CLI access and typed failures for map mismatch, duplicate IDs,
missing revision targets, stale subject bounds, and write conflicts.

**Verify**: service tests prove appending multiple subjects, multiple Views for one subject, explicit
revision, restart decoding, stable order, and rollback on persistence failure.

### Step 2: Expose set building in Workbench

Add explicit **Add selected actor as View** and **Add another View** actions. Present approved Views
grouped by subject identity, with View name, viewpoint semantics, revision, and policy visible.
Selection alone must never mutate a set. Keep authoring sessions single-subject and disposable.

**Verify**: component and IPC tests prove append versus revise intent end to end and prevent the
historic `views[0]` replacement bug.

### Step 3: Deepen capture planning and history projection

Keep Capture Set View-based and all-armed by default. Add actor-group selection conveniences and a
history projection that indexes results by View ID across runs. Expose a View timeline and explicit
current/previous comparison, including missing, failed, and older-revision states.

**Verify**: pure and component tests cover several Views per actor, partial runs, revision changes,
Natural/Clear evidence, and runs that predate a View.

### Step 4: Prove longitudinal persistence against UE 5.7

Extend the Plan 039 gallery flow to build a durable set containing representative compact, tall,
wide, asymmetric, compound, and occluded subjects. Persist at least two Views for one subject,
restart Workbench, and capture all Views. Apply one controlled transform/material-visible fixture
change, capture again, navigate both artifacts for the same View, then restore the fixture.

Do not use byte identity as an oracle. Assert stable set/View identity, revision relationships,
result coverage, artifact dimensions/non-emptiness, visible comparison state, map cleanliness, and
transient resource cleanup.

**Verify**: normal and recorded modes run the same actions/assertions and produce a complete bundle.

### Step 5: Document, gate, and archive

Document collection authoring, viewpoint semantics, longitudinal history, and capture ownership.
Connect the flow to the trusted Unreal review gate while keeping `pnpm check` portable.

**Verify**: focused tests, `pnpm test:flow:map-review`, recording, `pnpm test:unreal-review`, fixture
verification, and final `pnpm check` pass.

## Done criteria

- [x] Adding a selected actor appends a View and never replaces an unrelated View.
- [x] One Review Set persists multiple actors and multiple Views for one actor across restart.
- [x] Revising a View is explicit and preserves View identity while advancing revision identity.
- [x] Capture Set captures all or selected Views into one immutable run with truthful partial state.
- [x] Workbench groups Views by subject without adding a new durable actor-group entity.
- [x] A View timeline navigates its evidence across runs and exposes revision differences.
- [x] A real UE 5.7 flow captures two runs around a controlled, restored fixture change.
- [x] Recorded evidence shows set creation, restart, two captures, and history comparison.
- [x] No flow dirties the fixture map, leaks transient cameras/staging, or kills an editor it did not
      launch.
- [x] CLI and libraries remain usable without Workbench.
- [x] Documentation and all portable/trusted gates pass.

## Completion evidence

- Headless and component coverage verifies append/revise intent, stable ordered persistence,
  multi-subject and multi-view sets, rollback, partial history, and older-revision presentation.
- The UE 5.7 authoring journey persisted seven Views across six subjects, including two Views for
  the compound subject, restarted Workbench, captured two complete runs around a restored scale
  change, and displayed the previous Natural frame beside the current frame.
- The permissive flow retained and captured a 37-camera rig; the fixture framing and
  occlusion/recovery scenarios also passed.
- The recorded journey emitted a joined 1280x720 video, trace segments, logs, checkpoint images,
  both Unreal captures, and persisted JSON under `test-results/map-review-flows`.
- `pnpm test:unreal-review` passed 13 Unreal integration tests and all five live flow tests. The
  owned editor was closed by exact PID, and a fresh process scan found no Unreal process remaining.

## STOP conditions

- The implementation requires a Workbench-only persistence operation.
- Actor grouping begins to alter the portable Review Set schema without earned product semantics.
- Selection implicitly replaces or revises durable state.
- Old Capture Runs would need rewriting to support history.
- A comparison hides View revision differences or labels Clear evidence as Natural.
- A live test cannot restore its fixture mutation or prove map cleanliness.
- Process cleanup cannot distinguish an agent/test-owned editor from a user-owned editor.

## Deferred

- scheduling and unattended recurring capture;
- hosted review, accounts, comments, assignments, or notifications;
- semantic asset identity beyond the currently supported subject locators;
- automatic visual approval or pixel-difference scoring;
- cross-map collection orchestration beyond composing existing Review Sets;
- committing to actor grouping as the final information architecture.
