# Plan 035: Build the World Log investigation workspace

**Status**: COMPLETE — Phase 8 Fast History investigation targets

**Priority**: P2

**Effort**: XL

**Depends on**: Plan 034 Map History scan, browser contract, and Workbench route

## Purpose

Turn the implemented Perforce-backed Map History scanner into the **World Log**: a focused,
map-scoped investigation workspace. Its first delivered mode, **Deep History**, has a user select
one saved map and a bounded time range, run one complete map-scope Perforce reconstruction, then
investigate that single result through coordinated world, changelist, and actor lenses.

World Log is a Workbench route and a showcase of the headless `@ue-shed/map-history` workflow. It
does not become a Map Review subsection, a generic Perforce browser, or a separate privileged app.

## Product decisions

1. **Deep History comes first.** The current route and this delivery sequence build Deep History:
   one complete map-scope reconstruction that supports all later exploration without another
   Perforce request. It is the prerequisite for truthful whole-map changelist diffs and arbitrary
   historical actor/class exploration.
2. **Fast History is a separate future query mode.** It accepts an **Investigation Target** before
   acquisition, such as one actor or a current-class candidate set, and scans only that target's
   proven package scope. It is not a filter on a Deep History result and must clearly state its
   coverage: current-class targeting does not discover actors deleted or reclassed before today.
3. **One map / bounded range / one Deep scan.** The selected `.umap` and its proven matching World
   Partition external-actor scope are the only Deep History acquisition scope. Actor selection,
   View Filters, changelist selection, and time travel operate locally on the completed result and
   never issue a new Perforce request.
4. **Three lenses, one shared context.** World, Changelist, and Actor views remain inside the
   World Log route. They preserve map, range, actor, and selected submitted state when the user
   changes lens.
5. **The 2D actor point map is the primary visual.** Historical states are discrete saved actor
   projections at baseline and after submitted changelists. This plan does not build historical 3D
   worlds, camera renders, or reconstructed editor sessions.
6. **History is evidence-first.** Semantic changes, package revisions, partial coverage, and
   unclassified package changes are all visible. An unexplained package edit must never render as
   no change.
7. **Actor identity remains conservative.** Use the Map History GUID-first/exact-path fallback
   identity. Labels are display data, never an identity heuristic.
8. **No persistent cache in this slice.** Workbench may retain the one completed result in memory.
   Persistent indexing or a global revision cache needs separate performance evidence and a
   bounded invalidation design.

### History depth and vocabulary

**Deep History** is the current, complete map-history product. It starts with map and range, then
offers local **View Filters** such as actor label, class, package, GUID, changelist, and playback
frame. View Filters only reshape a completed corpus; they never change what was acquired.

**Fast History** is a later placement-focused product. Its pre-scan **Investigation Target**
defines what is acquired. It can provide an efficient answer to a question such as "how did current
NPC placements evolve?", but it must not present that targeted answer as complete historical class
coverage. The route must show Deep/complete versus Fast/targeted coverage prominently.

## User journey

```text
select map + range + Deep History → explicit scan → completed history session
                                                   ├─ World: point map at selected submitted state
                                                   ├─ Changelist: previous → selected submitted diff
                                                   └─ Actor: one actor's lifecycle and events
```

Changing map or range after completion leaves the current result inspectable and marks it stale.
Only an explicit update starts a replacement scan. Opening Workbench or World Log still performs no
Perforce operation.

## Lenses

### World

The default lens contains a searchable actor outliner, dominant top-down point map, frame/actor
inspector, and a discrete baseline/changelist scrubber. The selected frame is either the beginning
of the range or the resulting state after one submitted changelist. There is no interpolation that
would imply unsaved or in-between editor state.

### Changelist

The changelist list contains every submitted changelist selected by the map scope, including a
changelist containing only unclassified package evidence. The first diff comparison is the
previous relevant saved state to the selected changelist state. The map shows additions, removals as
ghosts, moves as before/after vectors, and changes retained in the evidence inspector. Arbitrary
CL-A-versus-CL-B comparison is deferred.

### Actor

Selecting an actor reveals its lifetime in the selected range: before/after presence, semantic
events, movement trail, label/class/package changes, originating changelists, and attributable
unclassified evidence. Actors removed before range end remain searchable as history-only actors.

## Architecture

### Acquisition and session boundary

`@ue-shed/map-history` remains the only package with Perforce authority. Workbench main owns the
configured project root, source-control configuration, scoped reconstruction fiber, cancellation,
and result lifetime. The renderer continues to use only its validated browser client. The current
request contract represents Deep History; Fast History requires a later discriminated request and
result scope, rather than overloading a Deep History View Filter.

The current polling contract is adequate for this slice. Do not introduce streaming IPC solely to
replace a short-lived progress poll. Revisit that boundary only if a real session requirement needs
incremental history data, subscriptions, or multiple observers.

### Playback data

Map History currently returns a renderer-safe range-end snapshot plus each revision's semantic
changes. Add matching range-start evidence and library-owned pure playback operations.

Do not transmit a complete actor snapshot for each changelist. A large map over many changelists
would create an actor-count-times-revision-count payload. Instead, derive discrete states from:

1. an empty initial state when the map was created in range, or the renderer-safe state immediately
   before `since`;
2. the existing actor transitions, each of which contains conservative before/after evidence; and
3. completeness and unclassified evidence for the active frame.

The core owns apply/revert and frame derivation. The renderer may retain a current point-map state
and bounded checkpoints for efficient scrubbing, but must not invent domain semantics. Complete
histories must replay to the existing range-end snapshot; a mismatch is a defect, not a UI repair.

### Presentation reuse

Map Review already has proven Canvas viewport, projection, pan, zoom, hit testing, keyboard, and
large-population mechanics. Extract only the browser-safe generic point-map engine after the World
Log adapter contract is clear. It must accept generic point records; Map Review and World Log own
their domain adapters. Do not make `@ue-shed/map-history` depend on a UI or live Observatory
package.

## Delivery sequence

### Phase 1: Route decomposition and selection model — COMPLETE (2026-07-30)

Split the current Content Observatory route into a workspace shell, query panel, actor atlas,
timeline/changelist list, evidence inspector, local formatting helpers, and a typed selection
reducer/model. Preserve every existing interaction and browser client call. The model must make
invalid selection combinations difficult to represent instead of accumulating unrelated signals.

**Acceptance**:

- Existing component and actor-helper tests preserve behavior.
- Route completion, cancellation, error, and partial states remain unchanged.
- Timeline selection still focuses its actor and package evidence.
- This phase adds no Perforce calls, IPC operations, playback semantics, or visual redesign.

### Phase 2: Map History playback contract — COMPLETE (2026-07-30)

Generalize renderer-safe snapshot evidence, return range-start state where applicable, and add pure
forward/reverse revision playback. Cover baseline, creation-in-range, add/remove, multiple changes
to one actor in a changelist, movement, identity continuity, unresolved positions, partial
snapshots, and unclassified evidence.

**Acceptance**:

- Any selected relevant changelist can yield its saved actor state without Perforce.
- No full actor snapshot is serialized per changelist.
- Complete playback agrees with the range-end snapshot.

### Phase 3: Shared 2D point map — COMPLETE (2026-07-30)

Extract the generic Canvas mechanics from Map Review into a browser-safe presentation module,
migrate Map Review without behavior regression, then adapt World Log. Add coordinate grid, pan,
zoom, fit/reset, keyboard selection, class color/legend, and dense-map performance.

**Acceptance**:

- One Canvas handles dense actor populations; there is no marker-per-actor DOM requirement.
- Outliner and map selection remain synchronized in both consumers.

### Phase 4: Deep History changelist lens — COMPLETE (2026-07-30)

Add a stable selected submitted changelist, map overlays for previous-to-selected diff, a relevant
CL list, semantic summary, package evidence, and explicit unclassified evidence. Filtering can
de-emphasize events but must not erase the selected map-relevant changelist.

### Phase 5: Deep History actor lens and precise View Filters — COMPLETE (2026-07-30)

Build actor-history projection by stable identity. Add field-qualified search (`label:`, `class:`,
`path:`, `package:`, `guid:`), changed/present/resolved/class filters, lifecycle summaries,
movement trail, semantic event list, and removed-actor support.

**Acceptance**:

- Actor selection and search are entirely local after completion.
- A removed actor remains inspectable with its correct historical evidence.

### Phase 6: Time travel and truthful states — COMPLETE (2026-07-30)

Connect the playback model to the World lens scrubber. Clearly distinguish complete, partial,
unclassified, empty, failed, cancelled, and stale-query results. Preserve selections across lenses
when still valid. Put scan limits behind advanced controls rather than hiding them.

### Phase 7: Showcase and conformance — COMPLETE (2026-07-30)

Add an interactive `pnpm showcase:world-log` path that builds the reader and Workbench, starts the
existing disposable localhost Perforce fixture, configures Workbench against its temporary client
workspace, and removes all owned server/client/ticket/configuration state when the showcase exits.

Record a deterministic journey that scans the World Partition fixture, selects a moved actor,
examines a label change, views addition/removal across time, inspects package evidence, and exposes
the final unclassified package edit. No Unreal launch is required.

### Phase 8: Fast History investigation targets — COMPLETE (2026-07-31)

After the Deep History vertical is complete and its cost/coverage is demonstrated, add a separate
Fast History request mode. Support a selected actor first, then a current-class candidate set from
the saved-map actor index. Model the target and coverage as a discriminated query/result contract;
do not reuse Deep History View Filters as hidden acquisition constraints.

**Headless foundation (2026-07-30)**: `@ue-shed/map-history` and `ue-shed map history --mode fast`
now support a single-actor Investigation Target with proven package-scope acquisition and explicit
targeted-coverage metadata. The CLI now also accepts an exact `--actor-class` target and proves
every current member's package before acquisition.

**Workbench first slice (2026-07-31)**: World Log now defaults to Deep History and exposes Fast
History as a separate choice. Fast History reads the current saved-world actor list locally, lets
the user search and select one actor, sends the tagged Fast request through IPC, and shows the
targeted-coverage warning on the result.

**Workbench second slice (2026-07-31)**: Fast History now has separate Actor and Actor Class
targets. The class list is built from the current saved-world actor projection, sends an exact
class target through the same IPC contract, and labels the result with its current actor count.
Target proof errors identify missing classes and explain when Deep History is needed for deleted or
reclassified actors.

**Dedicated showcase (2026-07-31)**: `pnpm showcase:world-log-fast` starts the disposable
Perforce fixture, selects an exact current actor class, runs Fast History, and records the targeted
coverage warning that distinguishes current members from deleted or historically reclassified
actors. The existing `world-log` journey remains the Deep History showcase.

**Acceptance**:

- Fast History visibly identifies its Investigation Target and targeted coverage at every result.
- A current-class target warns that deleted or historically reclassed actors are outside coverage.
- Deep History remains the only mode claiming a complete map-range corpus and full historical
  class filtering.

## Verification

Every substantive phase ends with focused unit/component checks, format/lint/type checks, and
`pnpm check`. Playback is tested as pure domain behavior; Workbench components test selection and
accessibility through the real browser client contract; real Perforce behavior remains in
`pnpm test:perforce-map-history`; the final showcase gets a Workbench E2E/recording journey.

## Explicit deferrals

- Arbitrary changelist A/B comparison.
- Persistent revision cache or whole-project history index.
- Cross-map and transitive referenced-asset history.
- Live editor or runtime history.
- Historical 3D/camera rendering.
- Project-specific actor identity heuristics.
- Automated judgments about whether a change is desirable or safe.

## Stop conditions

Stop rather than weakening the Map History contract if playback cannot honestly represent partial or
unclassified evidence, if replay requires label-based identity, if the shared Canvas extraction
would force live/editor authority into saved-history presentation, or if a required verification
gate fails twice after a scoped correction.
