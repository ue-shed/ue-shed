# Standalone synchronization primitive

Status: `TODO` — architecture and implementation plan for review; implementation is not authorized.

Parked 2026-10-09. The concept's
[direction revision](../docs/ideas/authoring-sync-layer.md#direction-revision-2026-10-09) makes the
editor the authority for native resources and Node a relay. The phases below still follow the earlier
coordinator-centric design and must be re-planned against that revision before review.

Design authority for this proposal remains the existing
[authoring synchronization concept](../docs/ideas/authoring-sync-layer.md). This plan is the sole status
source. It elaborates that proposal rather than creating a second architecture document.

Prepared in a new worktree on `docs/standalone-sync-design`, based on the existing concept branch at
`44a0bb1`. Camera implementation evidence is pinned to `feat/camera-flow` at `f7e6dec`; subsequent main
and camera branch changes must be reconciled before execution. No implementation, package creation,
plugin changes, dependency changes or publication belongs to this review task.

Snapshot revision (2026-09-13): the camera workspace already sends complete panel state, includes
saved View revisions, serializes host requests and reconciles keyed UI state with stale-poll guards.
Reuse those behaviors. Add the shared snapshot envelope, per-document ownership, explicit operation
lookup/recovery and framework adapter; do not implement entity patches, live queries, replay cursors
or retained delta history. Separate high-rate observations from document publication.

## Review decisions and stop conditions

Review the following concrete recommendations together:

1. One Node coordinator per document, repository owner guard/CAS, separate session and editor fences.
2. Durable commit-before-publication plus explicitly volatile domains; independent acceptance,
   engine, checkpoint/export and domain approval outcomes.
3. Small sync package/client facade and optional generic native bridge with domain handler ports.
   `unreal-rc` remains the transport and retains its repository/release ownership.
4. Strict revisions, complete latest snapshots, persisted retry windows and no blind replay after identity
   loss. Uncertain imperative engine effects may need manual recovery.
5. Camera adoption plus an unrelated fixture proves the boundary; a second production domain earns
   future expansion. No database framework or distributed authority project.

STOP before phase 1 implementation until this design is reviewed and implementation is explicitly
authorized. During execution, stop/revise the design if a provider cannot enforce atomic outcome/CAS,
old-owner fencing, game-thread cleanup or truthful indeterminate states. Do not weaken guarantees or
move domain rules into sync to make a test pass. Missing Unreal capability is typed unsupported.

## Phase 1 — contract and state-machine conformance

Deliverables after authorization:

- Neutral `sync/v1` schemas for hello/open, commands, admission/outcome lookup, full/terminal snapshots,
  engine dispatch/result, observations, leases and lifecycle actions. Complete every variant and
  default described by the concept; examples alone are not the wire specification.
- Typed TS schema mappings and native wrapper/codec design using shared fixtures; version policy,
  canonical command fingerprint encoding, counter overflow and retry-window expiry rules.
- Pure client/coordinator transition model and fixture-label domain. Define persisted session-end
  tombstones, document incarnations, retry windows and outcome/outbox records before storage code.
- Service/adapter contracts: domain decode/reduce/project/observe/recover; repository owner guard,
  load/CAS/checkpoint/outcome/effect-intent; transport negotiate/drain/dispatch/query; scoped client.

Tests: decimal counters beyond JS safe integer, max/overflow/noncanonical counters; malformed versions,
unknown/oversized payloads; altered duplicate fingerprints; same-revision competing commands; no-ops;
multi-entity atomic install; delete/recreate; expiry and unknown-old-epoch refusal. Property-based
delivery permutations must preserve monotonic confirmed state and at-most-once acceptance.

Exit: shared fixtures define the same observable TS/C++ semantics; every concept failure row maps to
a transition/test; the unrelated domain requires no camera, UI or transport dependency.

## Phase 2 — headless coordinator, repository and client

Deliverables:

- Proposed sync package with browser-safe client exports and Node Effect coordinator services.
  Effect handles resource scopes, concurrency, retries, time and telemetry; reducers remain pure.
- One per-document mailbox, consistent snapshot/publication sequence, latest-only subscriptions, pending-overlay fold,
  operation lookup, authorization hooks and public health.
- In-memory volatile adapter and durable reference adapter over existing camera store semantics,
  including a documented process-crash guarantee and owner-lock recovery. Reuse format only if it
  can truthfully supply CAS/state/outcome/effect-intent atomicity; otherwise make migration explicit.
- Headless fixture CLI/library journey without editor, bridge or Workbench. No camera policy in core.

Tests: two real host processes contest owner acquisition; two store instances contest CAS; crash
before/after durable write and before snapshot publication; retained known-ID lookup versus rejected
unknown ID after restart; saved checkpoint/outcome consistency; session-end persistence. Fake-clock
tests force expiry/backpressure. Race subscription/bootstrap, response-before-snapshot, snapshot-before-response,
duplicate/stale snapshots, skipped publications, delayed polls and disconnect. Dispose one client while another
continues; preserve pending intent on reconnect. Test policy denial and queue caps at real boundaries.

Snapshot-specific tests: subscribe concurrently with acceptance; skip several publications including
the exact accepting snapshot, then install a newer revision and resolve the original command by ID.
Change engine/checkpoint status without changing the document revision; publication sequence must
advance. Reject lower revision under a higher publication sequence. Exercise deletion/reopen and
authorization-scoped projections. A slow subscriber must keep at most one pending snapshot while
command outcomes remain recoverable. Enforce the complete envelope size bound and summary limit.
Measure bytes, encode/decode time, native-thread cost and retained UI/preview identity at the maximum
supported document size, drag rate and configured client count. Record results and tune coalescing;
incremental delivery needs measured justification and a separate design change.

Exit: headless clients converge under faults with bounded memory; accepted commands never duplicate;
durability is explicit; browser dependency closure excludes Node/Unreal/Workbench. Both volatile and
durable restart behavior match the declared contract.

Solid adapter addition to phase 2 (design revision 2026-09-13): specify and build an optional public
Solid 2 adapter over the framework-neutral handle, following the concept's Solid integration section.
Coordinate with the existing rc.7 migration before selecting actual package versions. Provide a keyed
reactive model, owner-scoped subscription cleanup and an action helper that settles after acceptance
plus confirmed-state installation. Keep protocol pending/outcomes separate from rendering transitions;
avoid duplicate optimistic overlays. Prove first-load readiness, same-document background updates,
microtask input capture, response/snapshot permutations, indeterminate recovery, old-scope fencing and
teardown while an action is pending. Exit requires retained control/preview identity and no Solid
dependency in the coordinator, CLI or native contract. No Solid migration is authorized by this plan.

## Phase 3 — optional native bridge and transport adapter

Deliverables:

- Capability-discovered generic native bridge/facade and `unreal-connection` adapter using existing
  `unreal-rc`. Bounded polling is baseline; no new Unreal HTTP/WebSocket client or callback server.
- Native reserve-before-execute operation cache, session/editor fences, game-thread dispatch,
  observation sequencing, monotonic leases, postcondition outcomes and cleanup registration.
- Domain registration for camera engine handlers, keeping transform/culling/capture interpretation
  in the camera bridge. Bridge-only and custom-native-client examples require no first-party menu.

Tests: shared codec fixtures on C++; lost RC replies while mutation executes; repeated same effect;
changed payload; authority/world/editor replacement between enqueue and execute; game-thread
assertions; bridge-cache saturation; lease expiry during a queued operation; native queue overflow.
Verify Details-panel transform/FOV changes, Undo/Redo and script changes enter observation. Test
host-applied echo versus a genuinely intervening native edit. Disconnect/crash before/after apply
must report indeterminate unless a real postcondition/outcome resolves it.

Exit: discovered local Unreal fixture evidence proves thread/lease cleanup and truthful outcomes;
optional bridge absence preserves headless and existing capture-only journeys. Generic plugin has no
camera/menu dependencies. Measured tick cost yields bounded configured work budgets.

## Phase 4 — incremental camera migration

Deliverables in order:

1. Adapt `CameraAuthoringStore`, keeping public command semantics and explicit stored-format
   compatibility. Move identity/outcome/serialization mechanics behind sync; retain pure arrangement
   rules and approval ownership logic in cameras.
2. Extract `camera-authoring-panel.ts` reconciliation scheduling and Workbench
   `camera-workspace.ts` request serialization into scoped public coordinator/client services. Native menu and CLI call the same camera facade; existing API wrappers can delegate.
3. Move native queue/lease/recovery plumbing behind the generic bridge. Negotiate new capability;
   reject simultaneous old/new authority on the same document/resource. Preserve capture closure.
4. Preserve existing saved-View revision summaries and add checkpoint/outcome evidence to snapshots. Update clients through stable handles and
   keyed entities, with explicit local text-edit buffers and retained preview resources.
5. Adopt recoverable destination CAS for Review Set publication. Validate owned-view base and required
   configuration under the destination guard; re-read/recompute a disjoint update after CAS failure.
   Persist projection intent and retry identity before publication. Do not move merge policy to sync.

Tests: retain existing camera arrangement/bridge/panel baselines, then prove all 12 acceptance rows
in the concept. Specifically race two independent arrangements publishing one Review Set: unrelated
views survive, same-owned-view changes conflict, and save interruption cannot increment a View twice.
Save the same view ID twice and observe the second revision. Delay an old actor poll while editing a
new actor. Race native drag and shared tuning, preserve exceptions and selection, exercise native
Details/Undo. Test Enter then blur and Tab commits without reverting new state. Count retained UI and
preview instances across updates; prove accepted data changes do not remount them. Verify selection,
pilot, visibility and pose restoration after external user changes and explicit capture handoff.

Exit: both interfaces converge without UI-owned reconciliation; actor/document scope stays isolated;
saved, synced and approved remain distinct; old saved documents and capture-only clients still work.
An interrupted migration has documented rollback to the old provider with new sessions fenced and
pending outcomes inspected, never concurrent writers or silent format downgrade.

## Phase 5 — adoption and release readiness

Deliverables:

- Package-mode `ADOPTING.md`, exact dependency closure, host integration manifest, version/capability
  matrix and recovery guide. CLI provides machine-readable target, outcome, checkpoint and health
  inspection through public APIs. Native facade has a minimal independent menu example.
- Clean consumer using packed packages and optional plugin artifacts. Replace both Workbench and
  first-party native menu; do not copy private code or reimplement coordinator mechanics.
- Fixture-label consumer and camera journey validate public seams. Run ordinary capture-only
  consumer with authoring/sync plugins disabled. Release metadata/Changesets only when publication
  boundaries are actually ready; no change to `unreal-rc` ownership.

Tests: clean build and public-export-only checks; custom host/menu edits in both directions,
save/reopen, lost-response recovery, preview cleanup and capture. Run all relevant portable gates,
packed-consumer conformance and discovered-engine Unreal evidence. Record skipped/unavailable gates
explicitly; do not claim full verification with a relevant failing or unrun native gate.

Exit: deleting first-party UIs removes only presentation; two unrelated domain adapters reuse the
same machinery. Public adoption guide is sufficient without inspecting Workbench or private endpoints.

## Verification strategy

Use pure/property tests for folds and ordering, Effect tests for clocks/resources/concurrency, real
files/processes for durability/CAS and transport fault injection, shared fixtures for TS/C++, actual
Unreal for native observations/mutations/cleanup, and narrow UI tests for focus/instance retention.
No mock may stand in for the native thread, Undo, save or cleanup evidence it claims to prove.

During implementation follow repository targeted-check guidance. Broad TS/contract changes run
`pnpm run check:precommit`; changed C++/live mutation surfaces require `pnpm check:unreal` and fixture
Remote Control evidence as appropriate. Final readiness requires `pnpm check` plus newly registered
sync/adoption/native gates. These are planned checks, not results of this design-only task.
