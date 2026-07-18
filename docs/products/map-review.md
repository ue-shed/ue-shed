# Map review product

## Product promise

UE Shed Map Review gives teams a durable visual memory of important spaces and world features. An
author identifies what deserves observation, generates useful viewpoints, art-directs exceptions,
captures the same visual intent repeatedly, and reviews change over time without adding permanent
tooling actors to shared maps.

The product is not a camera manager or a scheduled-screenshot wrapper. Its durable unit is a
**Review View**: a versioned statement that a subject should be observed from an approved framing,
under an explicit capture policy, for a stated review purpose. Cameras are transient instruments
that realize Review Views.

The complete first-party product is local and headless-capable. UE Shed owns portable definitions,
local Unreal authoring and capture, immutable evidence bundles, a local reference reviewer, and
interchange contracts. A studio may ingest those contracts into a centralized web review system,
but UE Shed does not prescribe authentication, organization policy, hosted storage, or collaboration
topology.

## Delivery status

The durable-loop slice is implemented. A portable Review Set can be validated, captured through a
separately enabled Unreal editor capability, promoted atomically into an immutable local Capture Run,
rediscovered after an editor restart, and opened in the Workbench reference reviewer. The CLI uses
the same repository and orchestration services.

The Slice 2 tracer bullet is now implemented on that spine. The editor capability inspects exactly
one selected actor, normalized bounds, orientation, and the active perspective viewport. The
headless camera domain deterministically generates Context three-quarter, Facade/front, four
Cardinal orbit candidates, and an optional current-editor-view candidate. Workbench renders real
transient previews as a contact sheet and supports discard, numeric pose/FOV adjustment, adjustment
provenance, explicit Reframe, and Keep View persistence without creating a map actor. The CLI exposes
the same selection, generation, and approval path.

The Live World Scout composition is also implemented as the primary Workbench entry into that flow.
The separately enabled Observatory capability returns bounded editor-world actor snapshots with
identity, class, label, transform, bounds, map, world kind, sequence, and observation time. Workbench
projects those actors onto an aspect-preserving XY canvas at a user-selected 1–30 Hz cadence, with
class counts, search, hide/show filters, selection, and an inspector. The last valid snapshot remains
visible and is marked reconnecting when a poll fails, then returns to live state on the next valid
snapshot. Selecting a point only inspects the actor. **Go to
Actor** brings Unreal forward, selects and focuses the actor, and starts transient Review View
framing. **Follow Actor** keeps re-framing it from the live observation stream until stopped. Map
Review remains the authority only after the author keeps a view or captures durable evidence.

PIE observations are valid navigation targets. When a PIE actor has an editor-world counterpart,
Go to Actor selects that counterpart for the authoring workflow while focusing the observed runtime
position. Runtime-only PIE actors can still focus the level viewport, but they do not invent a
durable editor selection or stable authoring subject.

This is the beginning of Slice 2 rather than its completion. Post-realization projected-bounds
diagnostics, richer orientation inputs, viewport manipulation, and restart-level authoring-session
recovery remain. Layered identity, Clear captures, comparison, and review decisions remain later
milestones in this plan.

## User outcomes

The first credible release must let a level designer, environment artist, or reviewer:

1. Select actors, components, or a bounded region in a running Unreal editor.
2. Generate several useful candidate views from purpose-specific framing presets.
3. Preview the real capture result, keep useful candidates, and refine their approved poses.
4. Save the definitions outside the map in a partitioned, source-control-friendly Review Set.
5. Capture ordinary **Pure** images and explicitly altered **Clear** companions where requested.
6. See subject-resolution, readiness, visibility, environment, and capture failures honestly.
7. Repeat the capture in a fresh process without dirtying the map.
8. Review the new run against an explicit earlier run or accepted baseline.
9. Record a human decision without allowing an image-difference score to decide correctness.
10. Perform validation and capture through the same public services from the CLI.

## Product boundary

### UE Shed owns

- Review Set and Review View schemas, migrations, validation, and portable persistence.
- Local selection, subject resolution, framing inputs, transient realization, and capture through a
  separately enabled Unreal capability.
- Local capture orchestration, readiness checks, warm-up, restoration, cancellation, and diagnostics.
- Immutable Capture Run manifests, typed evidence, artifact identity, provenance, and local storage.
- A filesystem-backed Workbench authoring, capture, comparison, and history experience.
- CLI parity for discovery, validation, capture, history, export, and diagnostics.
- Storage ports and portable interchange contracts that a trusted downstream distribution can
  implement.
- Optional reuse of eligible Review Views by sparse local camera observation.

### A studio integration owns

- Authentication, authorization, tenancy, and organization membership.
- Central object storage, databases, search indexes, and CDN behavior.
- A multi-user web review portal, review assignments, comments, mentions, and notifications.
- Branch, changelist, build, CI, source-control, and capture-farm policy.
- Studio-specific environment control, map taxonomy, naming policy, approval rules, and retention.
- Ingestion from and export back to UE Shed's portable contracts.

### The handoff boundary

The portable Capture Run is the integration boundary. Its manifests use stable IDs, versions,
content hashes, and relative artifact references. They never require local absolute paths, a source
control vendor, an object-store URI scheme, or a particular database.

```text
Unreal + local UE Shed
        |
        v
portable Review Sets + immutable Capture Runs
        |
        +------ local Workbench reviewer
        |
        +------ studio ingestion adapter
                         |
                         v
             centralized studio web review
```

Workbench is the canonical local authoring and capture console and a complete reference reviewer. It
is not the intended final multi-user collaboration surface.

## Product language

Use these names consistently in schemas, APIs, CLI output, diagnostics, and UI copy.

| Term            | Meaning                                                                                      |
| --------------- | -------------------------------------------------------------------------------------------- |
| Review Set      | A partitioned, versioned collection of Review Views and reusable Capture Profiles            |
| Review View     | Durable visual intent: subject, purpose, framing, approved pose, and variant policy          |
| Subject         | The actor, component collection, or region the view exists to review                         |
| Subject Locator | An ordered, inspectable strategy for resolving a Subject in a particular world               |
| Framing Recipe  | The preset and inputs that generated a candidate pose                                        |
| Approved Pose   | The transform and projection an author accepted for repeat captures                          |
| Capture Profile | Reusable requested environment, readiness, rendering, resolution, and warm-up policy         |
| Capture Run     | One immutable attempt to capture a Review Set in a specific producer/world/session           |
| View Result     | The success or typed failure for one Review View within a Capture Run                        |
| Pure            | Ordinary rendered truth with natural context and occlusion                                   |
| Clear           | A labeled companion captured from the same pose with explicit visibility intervention        |
| Evidence Bundle | Manifests, images, thumbnails, diagnostics, and provenance produced by a run                 |
| Review Record   | Append-only local review decisions and annotations referencing immutable evidence            |
| Baseline        | An explicitly promoted Capture Run used as a comparison target, never an implicit latest run |

Do not use “camera” as the primary noun in the maintained UI when “view” or “review view” describes
the user's intent. Camera remains correct for Unreal realization, live transport, and low-level
telemetry.

## Domain model

TypeScript-owned persisted models use Effect Schema as their authority. Shared TypeScript/C++
messages use a language-neutral contract with conformant Effect Schema decoders. IDs are branded and
not interchangeable.

Initial IDs include `ReviewSetId`, `ReviewViewId`, `SubjectId`, `CaptureProfileId`, `CaptureRunId`,
`ViewResultId`, `ArtifactId`, `ReviewRecordId`, `ProducerId`, `SessionId`, and `WorldId`.

### Review Set

A Review Set contains:

- schema and product compatibility versions;
- stable set identity, display name, description, ownership metadata, and tags;
- expected project and map identity without machine-specific project paths;
- zero or more reusable Capture Profiles;
- ordered Review Views;
- optional partition metadata such as region, purpose, or owner;
- creation and modification provenance that does not make timestamps semantic identity;
- extension fields only through versioned, namespaced payloads.

The default persistence is portable JSON under a configurable project-local review root. The tracer
bullet must earn the exact default path. A Review Set must remain readable and validatable without
launching Unreal. A future DataAsset adapter may import or export the same model but cannot become the
only authority.

Avoid one global set. The product encourages partitioning by map region, feature, review purpose, or
owner and permits a capture invocation to compose several sets.

### Review View

A Review View contains:

- stable identity, display name, purpose, owner, region, and tags;
- one explicit Subject specification;
- a Framing Recipe describing how the initial candidate was generated;
- an Approved Pose containing transform, projection, field of view or orthographic width, aspect,
  near-clip policy, and framing margin;
- a Capture Profile reference plus optional bounded per-view overrides;
- a variant policy requiring Pure and optionally Clear;
- optional compatibility fields for sparse live observation;
- authoring provenance and the reason for any manual adjustment.

The Framing Recipe and Approved Pose are both durable. Repeat capture always uses the Approved Pose.
Changing bounds, a framing implementation, or a preset version must not silently move an approved
camera. Instead, validation reports clipping or framing drift and offers an explicit Reframe command
that produces a reviewable definition change.

### Subject Locator

Subject resolution is an ordered discriminated union rather than a bag of nullable identifiers. The
first version supports:

- a stable authored identifier when the project exposes one;
- an engine-supported actor or instance GUID signal where its lifecycle is valid;
- a soft object reference;
- an explicit semantic tag query;
- a bounded, explicit fallback query;
- a diagnostic label and last-known path that are never identity by themselves.

A View Result records the attempted layers, selected layer, resolved objects, ambiguity, and failure.
Zero matches and multiple matches are typed outcomes. Neither may produce an apparently successful
blank capture.

The tracer bullet should begin with actor subjects. Component groups and regions follow only after
actor identity and failure behavior are proven.

### Framing

Framing generation is a pure transformation over normalized spatial inputs wherever possible:

```text
normalized subject bounds + orientation signals + aspect + purpose + preset parameters
    -> candidate Review Views
```

Initial presets are deliberately small:

1. **Context three-quarter:** subject plus readable surroundings.
2. **Facade/front:** an authored or inferred facing direction with controlled verticals.
3. **Cardinal orbit:** four evenly identified views around the subject.

Generated candidates carry preset name, preset version, inputs, output pose, and framing diagnostics.
Post-realization validation projects the subject into the final image and reports margin, clipping,
near-plane, and aspect failures. Bounds provide a starting signal, not a claim that framing is good.

### Capture Profile

A Capture Profile separates reusable requested policy from the effective environment recorded in a
Capture Run. It includes:

- execution mode, map/world expectations, and authority;
- resolution, aspect, image format, and render profile;
- streaming readiness and timeout policy;
- warm-up expressed in explicit time and/or completed-frame requirements;
- LOD/HLOD, scalability, exposure, time, weather, and render-setting expectations;
- whether UE Shed may intervene or only observe and report;
- restoration requirements for every intervention;
- variant defaults and artifact derivation policy.

The initial profile is conservative: it observes the open editor world, requests no project-specific
weather or time controls, waits for capabilities the engine can truthfully report, records effective
state, and fails on unmet required readiness. Environment control is an adapter capability, not a
generic assumption.

### Pure and Clear variants

Variant policy is a discriminated union:

- `pure_only`;
- `pure_with_show_only_subjects`;
- `pure_with_explicit_hidden_objects`;
- later, `pure_with_automatic_occluder_policy`;
- later, a versioned hybrid policy.

Pure is always captured before Clear in the first implementation. Both variants use the exact same
Approved Pose and effective projection. Clear evidence records every actor/component hidden or shown,
the policy and reason, and whether restoration succeeded. Clear is permanently labeled in manifests,
thumbnails, comparison UI, and exports.

The MVP supports manual show-only subjects and explicit visibility overrides. Automatic occluder
discovery is deferred until its explainability and false-positive behavior can be tested on a richer
fixture.

### Capture Run and View Result

A Capture Run is immutable after finalization. Its lifecycle is a discriminated union:

- `planned` with selected sets, views, profile, and producer requirements;
- `running` with current stage, started time, bounded progress, and cancellation state;
- `completed` with counts, finalized manifest, and artifact inventory;
- `completed_with_failures` with successful evidence plus typed failed View Results;
- `cancelled` with completed work and restoration outcome;
- `failed` when no valid finalized run can be produced.

Each View Result progresses through explicit stages:

```text
resolve subject
  -> realize approved pose
  -> prepare world
  -> wait for readiness
  -> warm up
  -> capture Pure
  -> apply Clear policy
  -> capture Clear
  -> restore world
  -> write evidence
```

Stage results carry safe IDs, duration, retry safety, completed work, and recovery guidance. Capture
continues across independent view failures unless a profile declares a run-wide invariant failed.
Cancellation is bounded and always enters restoration before finalization.

### Review Record and baseline

Review Records are append-only documents that refer to immutable Capture Runs and View Results. The
initial decision union is:

- `unreviewed`;
- `expected_change`;
- `needs_follow_up`;
- `capture_invalid`.

Baseline promotion is a separate deliberate event with authorship and time. Marking a change as
expected does not silently replace the baseline. Comparison targets may be the explicit baseline,
the previous run, or a specifically selected run.

Image comparison may produce attention hints and derived artifacts. It never writes a human review
decision and never gates capture success.

## Portable evidence contract

The first filesystem representation should resemble:

```text
<capture-run-id>/
  run.json
  views/
    <review-view-id>/
      result.json
      pure.png
      pure.thumbnail.webp
      clear.png
      clear.thumbnail.webp
  reviews/
    records.jsonl
```

`run.json` inventories every expected View Result so missing files cannot masquerade as an empty
successful run. Each artifact record contains media type, dimensions, byte length, content hash,
variant, relative path, and derivation provenance. Authoritative review captures begin as lossless
PNG; derived thumbnails may use WebP or JPEG. The format remains a profile choice after storage and
comparison costs are measured.

Writing is staged and atomically finalized. An interrupted staging directory is recoverable or
discardable but is not listed as a completed run. Review append operations use their own atomicity
and corruption detection; downstream centralized systems may map them to another storage model.

Define narrow storage ports rather than a generic database abstraction:

- `ReviewSetRepository` for validated definitions and optimistic revision checks;
- `CaptureRunRepository` for planning, atomic finalization, and history queries;
- `ArtifactStore` for bounded binary artifacts and derived representations;
- `ReviewRecordStore` for append and query of portable review events.

Local filesystem implementations ship first. Trusted studio distributions may provide implementations
backed by an ingestion API and object store.

## Architectural ownership

```text
portable Review Sets                      open Unreal editor
        |                                      |
ReviewSetRepository                 UEShedCamerasEditor capability
        |                     selection, resolution, preview, capture
        +-------------------+------------------+
                            |
                    @ue-shed/cameras
 definitions, framing, sessions, orchestration, typed outcomes
                            |
                    @ue-shed/evidence
       run manifests, artifacts, provenance, local history
                 /                            \
        ue-shed CLI                    camera-review extension
                                              |
                                  Workbench or trusted host
```

### `packages/protocol`

Own language-neutral editor capability and capture-operation contracts, versions, limits, and
conformance fixtures. The disposable live-frame v1 contract remains separate from durable capture
evidence.

### `packages/cameras`

Grow from live transport support into the headless camera domain without making the live scheduler
the durable capture authority. Own Review Set schemas, pure framing and validation, editor adapters,
authoring-session behavior, capture orchestration, repository ports, and typed domain errors.

If live observation and durable review make the package incoherent during implementation, split
internal modules first. Do not create another public package until import direction and shared model
ownership are demonstrated by the tracer bullet.

### `packages/evidence`

Own artifact identity, manifests, content hashing, atomic local persistence, provenance, derived
artifact relationships, and retention hooks. Camera-specific metadata remains contributed by the
camera domain through typed evidence payloads.

### `extensions/camera-review`

Become the maintained host-neutral SolidJS and StyleX interface. It consumes a narrow browser-safe
client contract and owns no filesystem, Unreal transport, framing, capture, or review authority.

### `apps/cli`

Expose the same public operations used by graphical hosts. Command parsing and JSON rendering do not
become domain services.

### `apps/workbench`

Compose the extension, adapt main-process services to the browser-safe client, and own only window,
route, and presentation concerns. It receives no private Unreal endpoint.

### Unreal modules

Keep the current runtime `UEShedCameras` module responsible for runtime-safe transient capture,
readback, scheduling, and sparse observation. Add a separate editor module for editor selection,
spatial authoring, editor-world subject resolution, preview realization, and capture-session control.
Runtime code must not depend on editor modules.

The editor capability realizes definitions as transient actors/components and destroys them on
completion, failure, disconnect, map change, and editor shutdown. It must prove that preview and
capture leave the target map package clean. Supported UE 5.7 APIs are verified against installed
engine source during implementation; public contracts describe outcomes rather than guessed engine
calls.

## Public operations

The initial host-neutral service surface should express domain actions:

- list, load, validate, create, update, partition, and compose Review Sets;
- inspect the current editor selection as normalized Subject candidates;
- generate candidate Review Views from a preset;
- start an authoring session and realize selected candidates transiently;
- preview, adjust, approve, discard, and explicitly reframe a Review View;
- plan, start, observe, cancel, resume where safe, and finalize a Capture Run;
- list runs, retrieve evidence, choose comparison targets, and append Review Records;
- promote an explicit baseline;
- report health, missing capabilities, incomplete restoration, and unsupported policies;
- adapt an eligible Review View into a sparse local observation definition.

Do not expose raw Remote Control calls, Unreal object pointers, arbitrary visibility mutation, or
filesystem paths to renderer code.

## CLI product

Exact syntax may evolve with the CLI parser, but the first product must cover these actions:

```text
ue-shed review sets list <project-root>
ue-shed review sets validate <set-or-project>
ue-shed review subjects selected <endpoint>
ue-shed review views generate <set> --preset <preset> --endpoint <endpoint>
ue-shed review capture plan <set> --endpoint <endpoint>
ue-shed review capture run <set> --endpoint <endpoint> [--output <root>]
ue-shed review capture cancel <run-id>
ue-shed review runs list <project-root>
ue-shed review runs show <run-id>
ue-shed review compare <left-run> <right-run> --format json
ue-shed review baseline promote <run-id>
ue-shed review doctor <project-root> [--endpoint <endpoint>]
```

Commands print validated structured output when requested, report partial View Result failures, use
stable exit semantics, and never treat a completed-with-failures run as fully successful.

## Workbench experience

The visual direction is an industrial review light table: image-dominant, neutral, precise, and
quiet enough that captures remain the strongest color on the screen. It should not resemble a
generic metrics dashboard. Telemetry is available contextually rather than occupying the primary
workspace.

### Review Set home

- Show sets with map, region, purpose, owner, view count, last completed run, unreviewed count, and
  unresolved or invalid views.
- Make **Capture all** and **Continue review** the two primary actions.
- Show connection and capability health without implying that a connected editor makes definitions
  valid.
- Distinguish never captured, stale, partially failed, and current states with text and shape as well
  as color.

### Authoring workspace

- Begin from the current Unreal selection or an existing Review View.
- Present generated candidates as an immediate contact sheet.
- Use a large real capture preview and a stable filmstrip for navigation.
- Overlay safe frame, projected subject bounds, framing margin, and clipping/near-plane warnings.
- Make **Keep**, **Discard**, **Reframe**, **Use editor view**, and **Focus subject in Unreal** the
  primary actions.
- Keep numeric transform and projection controls in a secondary inspector.
- Explain preset lineage and manual offsets without forcing the author to understand schema fields.
- Preserve selection and scroll position when previews refresh or Unreal reconnects.

### Pure and Clear inspection

- Treat Pure and Clear as one paired result.
- Provide instant toggle and side-by-side modes from the same focused view.
- Persistently label Clear in the image chrome and exported thumbnail.
- List visibility interventions and restoration status in an explainability panel.
- Prevent baseline promotion when the expected companion is missing or the pose differs.

### Capture monitor

- Display per-view stages and completed/failed counts rather than one indefinite spinner.
- Surface active world interventions while they are happening.
- Allow bounded cancellation and show that restoration is still completing.
- Let independent failures finish the run and provide targeted retry where the operation is safe.
- Keep completed evidence navigable while later views are still capturing.

### Review inbox

- Group by subject and Review View, never by artifact filename.
- Filter unreviewed, failed, subject-missing, framing-warning, environment-mismatch, and attention
  hints.
- Review a Pure/Clear pair as one item.
- Support fast keyboard navigation and decisions without animation.
- Keep decision, annotation, and baseline promotion separate.

Initial keyboard behavior should include next/previous item, toggle Pure/Clear, toggle baseline/new,
mark expected, flag follow-up, and open metadata. Shortcuts must not conflict with text entry and must
be discoverable in the UI.

### Comparison stage

- Side-by-side, draggable wipe, and fast A/B flicker modes.
- Explicit baseline, previous run, and selected-run targets.
- Pure/Clear switching without losing comparison position.
- Synchronized zoom and pan with an obvious reset.
- Adjacent metadata diff for environment, rendering, readiness, subject resolution, and framing.
- Normalized-coordinate annotations that remain valid across derived thumbnail sizes.
- Optional image-difference overlays presented as attention assistance, never judgment.

### History

- Show a visual timeline per Review View with failed attempts retained in sequence.
- Display Review Records and baseline promotions with authorship.
- Allow any two compatible runs to open in the comparison stage.
- Make missing artifacts, incompatible schema versions, and changed environment visible rather than
  silently dropping timeline entries.

### Interaction and accessibility rules

- Keyboard-initiated navigation and comparison changes are immediate and unanimated.
- Pointer-triggered popovers and drawers use short, interruptible transitions under 250 ms.
- Pressable controls provide subtle immediate active feedback.
- Motion uses transform and opacity where practical and respects reduced-motion preferences.
- Tooltips delay on the first hover and become immediate while traversing a related toolbar.
- Images have useful accessible names derived from Review View, variant, and run identity.
- Every status has a textual representation; Pure/Clear and success/failure never rely on color.
- Focus order follows review flow, remains visible over image content, and survives reactive updates.
- Critical screens receive visual-regression coverage at representative densities and failure states.

## Authoring and capture sessions

The browser UI observes a host-owned session state. Components do not reconstruct lifecycle from
independent booleans.

Authoring session states include:

- `idle`;
- `connecting`;
- `ready` with selection and capability revision;
- `generating` with preset and bounded candidates;
- `previewing` with transient realization identity;
- `dirty` with approved local definition changes;
- `saving`;
- `disconnected` with retained portable work and recovery actions;
- `failed` with a typed domain error.

Capture session states follow the Capture Run lifecycle and expose per-view stage state. Map changes,
world changes, producer restarts, and capability revision changes invalidate transient realization
but do not erase approved portable definitions.

## Observability and health

Instrument the full boundary operation, not only frame delivery:

- Review Set load, decode, migration, validation, and optimistic-revision conflicts;
- subject-resolution layer attempts, ambiguity, coverage, and duration;
- candidate generation count and framing-warning distribution;
- transient realization create/destroy and leaked-realization detection;
- readiness wait, warm-up, capture, readback, encoding, hashing, and artifact-write latency;
- visibility interventions, restoration success, and incomplete restoration;
- run counts by outcome, View Result failures, retries, cancellation, and finalized bytes;
- thumbnail and comparison derivation cost;
- Workbench subscription lifecycle, stale state, and presentation errors.

Spans use safe stable IDs, versions, result, duration, and bounded counts. Do not put project paths,
actor labels, image content, or unbounded IDs in metric labels. Camera health exposed to `doctor`, the
CLI, and Workbench comes from the same service state.

## Failure and recovery policy

Expected failures are typed domain values with safe recovery guidance. Initial classes include:

- missing or incompatible editor capability;
- project, map, world, producer, or session mismatch;
- Review Set decode, migration, validation, or revision conflict;
- subject missing, ambiguous, unloaded, or unsupported;
- invalid framing, clipping, projection, or resolution;
- readiness timeout or unsupported readiness signal;
- transient realization failure;
- capture, GPU readback, encoding, hashing, or artifact-write failure;
- visibility intervention or restoration failure;
- cancellation, editor exit, map change, or transport loss;
- incomplete, corrupt, or incompatible evidence bundle.

Retries are explicit, bounded, observable, cancellable, and permitted only where the error declares
them safe. An indeterminate capture operation is reconciled by run and operation identity before any
replay. A restoration failure receives prominent diagnostics even when images were produced.

## Fixture

Add a dedicated generic review map or a meaningful partition within the existing camera fixture. It
must contain:

- one building-like structure assembled from basic generated geometry;
- stable subject identity and semantic tags;
- a primary facade, readable three-quarter view, and at least one natural occluder;
- a component or child actor suitable for later component-group resolution;
- a deterministic map change that is visually obvious but not a subject-identity change;
- an alternate state that creates a framing warning;
- a subject-missing case and an ambiguous-query case;
- inspectable readiness/environment metadata available without studio-specific systems.

Fixture generation remains deterministic. Tests must prove transient preview/capture leaves the map
package unchanged and works after a fresh editor process.

## Delivery plan

### Slice 0: Contracts and architecture spike

Define the language before building UI:

- Review Set, Review View, Subject Locator, Framing Recipe, Approved Pose, Capture Profile, Capture
  Run, View Result, artifact, and Review Record schemas;
- versioning and compatibility policy;
- portable filesystem layout and atomic-finalization experiment;
- editor/runtime module boundary and minimal capability manifest additions;
- actor identity investigation against the fixture and supported UE 5.7 lifecycles;
- exact behavior for map cleanliness and transient teardown.

Acceptance:

- representative documents round-trip through Effect Schema;
- malformed, old, and future-incompatible fixtures fail with typed results;
- TS/C++ shared messages have one language-neutral authority;
- an architecture note records earned identity and storage decisions;
- no UI or broad Unreal API is added before these contracts are reviewable.

### Slice 1: One durable manual view

Build the thinnest complete local loop:

1. Persist one manually authored Review View for the fixture structure.
2. Resolve its actor Subject in a live editor.
3. Realize an approved pose as a transient capture source.
4. Capture one Pure PNG and complete metadata.
5. Destroy transient state and verify the map remains clean.
6. Atomically finalize a Capture Run.
7. Repeat in a fresh editor process and list both runs as history.
8. Perform the same capture through the CLI and a minimal Workbench surface.

Acceptance:

- deleting Workbench still leaves the complete flow usable through public libraries and CLI;
- run manifests inventory success and failure honestly;
- interrupted writes do not appear as completed runs;
- process exit, cancellation, and capture failure release transient resources;
- `pnpm check`, targeted Unreal integration tests, and the CLI end-to-end journey pass.

### Slice 2: Spatial authoring and immediate preview

- Add current-selection inspection through the editor capability.
- Normalize actor bounds and orientation inputs.
- Add Context three-quarter, Facade/front, and Cardinal orbit preset generation.
- Render candidates into a contact sheet.
- Support Keep, Discard, Use editor view, manual pose adjustment, and explicit Reframe.
- Persist preset lineage, Approved Pose, and framing diagnostics.

Acceptance:

- selecting the fixture subject produces deterministic candidates;
- a kept candidate survives restart with the same Approved Pose;
- changing subject bounds warns but does not silently reframe;
- manual adjustment persists without creating a map actor;
- contact-sheet actions are covered by component and Workbench end-to-end tests.

### Slice 3: Capture profiles and trustworthy execution

- Add reusable Capture Profiles and effective-environment snapshots.
- Implement readiness, timeout, warm-up, bounded per-view stages, cancellation, and restoration.
- Add multi-view Capture Runs with partial failure.
- Add run monitor, retry-safe targeted retry, history queries, and health diagnostics.
- Integrate capture metrics with existing camera telemetry without exposing experiment controls as
  ordinary product settings.

Acceptance:

- slow readiness, timeout, map change, editor exit, and cancellation have truthful final states;
- one failed view does not erase independent successful evidence;
- required restoration completes or produces a prominent typed failure;
- a completed-with-failures run is distinguishable in CLI exit behavior and Workbench;
- capture remains bounded and demand-driven.

### Slice 4: Paired Pure and Clear evidence

- Add manual show-only-subject and explicit-hidden-object policies.
- Capture both variants from one Approved Pose and projection.
- Record every intervention and verify restoration.
- Build paired variant inspection and explainability UI.

Acceptance:

- Clear is never emitted or displayed without its label and Pure relationship;
- a pose/projection mismatch invalidates the pair;
- visibility lists and reasons are preserved in the manifest;
- failure during Clear capture still restores world state and preserves the valid Pure result;
- variant behavior is proven against a real occluder in the fixture.

### Slice 5: Local review product

- Build Review Set home, review inbox, focused comparison, metadata diff, history, Review Records,
  and deliberate baseline promotion.
- Add synchronized side-by-side, wipe, and flicker comparison.
- Add derived thumbnails and optional non-authoritative attention hints.
- Complete keyboard, focus, reduced-motion, loading, stale, disconnected, and unsupported states.

Acceptance:

- a reviewer can process a run without using the mouse;
- review decisions never mutate capture evidence;
- expected-change decisions do not promote a baseline;
- failed and incompatible runs remain visible in history;
- component, Electron end-to-end, accessibility, and critical-screen visual tests pass.

### Slice 6: Portable studio handoff

- Freeze the first supported evidence-bundle interchange version.
- Add validate, export, import, and content-integrity commands.
- Publish the repository ports and a minimal example adapter that proves replacement without
  introducing a hosted service.
- Document idempotent ingestion, immutable run identity, relative artifacts, and review-event
  exchange expectations.

Acceptance:

- a bundle copied to another machine validates and renders without its originating project path;
- repeated ingestion can deduplicate by stable identity and content hash;
- a non-filesystem repository implementation passes the same contract suite;
- the example contains no authentication, cloud vendor, or studio policy assumptions.

### Slice 7: Shared language with sparse live observation

- Mark which Review Views are eligible for runtime observation.
- Derive disposable local live definitions with cadence/resolution overrides.
- Preserve Review View and Subject identity in live frames and promoted evidence.
- Allow an operator to promote a live frame into a durable Capture Run or evidence record without
  confusing live quality with review-profile quality.

Acceptance:

- no live consumer means no recurring capture work;
- live overrides never mutate the durable Approved Pose or Capture Profile;
- disposable frames remain outside durable evidence until explicitly promoted;
- review capture remains functional when the live observation capability is disabled.

Slices 0 and 1 prove the architecture. Slices 2 through 5 produce the complete local product. Slice
6 proves the studio integration boundary. Slice 7 composes with the already measured live-camera
work and is not required for the first Map Review release.

## Test and conformance plan

| Layer     | Behaviors                                                                 | Runtime                             |
| --------- | ------------------------------------------------------------------------- | ----------------------------------- |
| Contract  | Fixture declarations, JSON schemas, compatibility, limits                 | Node.js                             |
| Pure      | framing, projected bounds, validation, state folds, history selection     | Node.js                             |
| Property  | schema round trips, ID separation, ordering, atomic-manifest invariants   | Node.js                             |
| Effect    | repositories, cancellation, cleanup, timeouts, retries, concurrency       | Node.js + temp files                |
| Protocol  | editor messages, versions, malformed inputs, limits, correlation          | TypeScript + C++ fixtures           |
| Unreal    | selection, identity, bounds, transient realization, variants, restoration | Real UE 5.7 fixture                 |
| CLI       | validate, capture, partial failure, history, export                       | Child process + real local services |
| Component | authoring and review behavior through a browser-safe client               | SolidJS test environment            |
| Product   | select-to-history and capture-to-review journeys                          | Electron + real fixture             |
| Visual    | contact sheet, capture monitor, comparison, failure states                | Workbench screenshots               |

Required high-risk cases include:

- duplicate or missing subjects;
- selected actor destroyed between generation and capture;
- map or producer changed during a session;
- subject bounds changed after approval;
- readiness never settles;
- capture cancelled during each stage;
- transport loss after an operation becomes indeterminate;
- failure after visibility intervention but before Clear capture;
- artifact write interruption and corrupt manifest;
- old and future-incompatible Review Sets and Capture Runs;
- Workbench reload while authoring or reviewing;
- slow consumers and large history collections;
- full teardown with no dirty map or leaked transient actor.

Portable changes run `pnpm check`; process journeys run the appropriate CLI and Workbench end-to-end
lanes. Unreal plugin, fixture, or live-capability changes additionally run `pnpm check:unreal` on the
configured UE 5.7 reference environment.

## Release milestones

### Tracer bullet

Select one fixture structure, generate three candidates, approve and adjust one, capture a Pure
image, destroy transient state, restart Unreal, recapture, and navigate the two runs through CLI and
Workbench history.

### Credible local product

Partitioned Review Sets, three framing presets, multi-view Capture Runs, capture profiles, paired
Pure/Clear evidence, failure recovery, local review inbox, comparison, history, Review Records, and
baseline promotion all work against the generic fixture.

### Integration-ready product

Portable bundle v1, validation/export/import, replaceable repository contracts, idempotent-ingestion
guidance, and conformance tests let a studio build a centralized web review experience without
forking camera definitions or capture behavior.

## Decisions made

- The product is Map Review; cameras are implementation instruments.
- The durable primary entity is Review View.
- Portable definitions outside the map are the first authority.
- Approved Pose and Framing Recipe are stored separately.
- Repeat capture never silently reframes.
- Pure is truth; Clear is an explicitly labeled companion.
- Capture Runs are immutable and failures are retained as results.
- Baseline promotion is separate from ordinary review decisions.
- Workbench is a local reference product, not a centralized collaboration backend.
- Studio centralization integrates through portable contracts and storage ports.
- Live pixels remain disposable until explicitly promoted into evidence.

## Decisions to earn

- Exact default review-root location and whether projects commonly need several roots.
- Stable subject identity precedence across world-partitioned, instanced, and ordinary actors.
- Region-subject representation and component-group identity.
- The minimum trustworthy readiness signals available across supported Unreal versions.
- Capture behavior in editor world versus PIE and standalone sessions.
- Preset orientation signals beyond explicit author-provided facing.
- Whether authoritative images remain PNG by default after real storage measurements.
- Review Record merge behavior before a downstream centralized system owns concurrency.
- The threshold at which local history needs indexing beyond manifest scanning.
- Whether automatic occluder discovery can be explainable and useful enough to ship.

## Deferred work

- Multi-user accounts, permissions, assignments, comments, and notifications.
- A hosted database, object store, web portal, or SaaS control plane.
- Capture-farm scheduling and distributed Unreal execution.
- Source-control-specific checkout, changelist, or branch policy.
- Automatic screenshot approval or pixel-diff release gates.
- Computer-vision subject or occluder inference.
- Arbitrary project environment scripting in the generic plugin.
- Persistent map actors as a camera database.
- External Data Layer authoring before transient realization proves insufficient.
- Remote continuous video or WebRTC.
- A multi-map geographic atlas, measurement system, region authoring, or spatial-comment system.

The lightweight live top-down actor canvas is part of the maintained Map Review workflow. This
anti-goal defers the larger durable cartography product, not spatial navigation of one observed world.

## Anti-goals

- A transform list presented as a complete review language.
- A Workbench-only implementation.
- Permanent tooling actors required in shared maps.
- Recomputing framing on every run and calling the results comparable.
- Actor labels or machine paths as durable identity.
- Clear images presented as untouched truth.
- Hidden streaming, visibility, environment, or LOD interventions.
- Empty or partial images counted as successful captures.
- One globally locked Review Set.
- A pixel-difference score making human review decisions.
- Coupling definitions to the live-frame transport.
- Prescribing the centralized system each studio should operate.
