# Scenario Studio product

## Product promise

Scenario Studio turns a portable gameplay-intent document into an explainable Unreal execution with
structured results. People and agents use the same public runner: Workbench is an optional timeline
client, not the authority that schedules input or interprets success.

The first supported live slice is deliberately narrow. It executes the generic Movement Gym
scenario in UE 5.7 Play In Editor, drives three explicitly registered Enhanced Input actions, waits
for one world condition, probes one state, and returns bounded evidence. It is a tracer bullet for
truthful execution, not a claim that the broader recording/timeline vision is shipped.

## Delivery status

The Scenario Studio timeline prototype is portable but preview-only. Plan 041 is implementing the
first live PIE execution slice described here. Until its acceptance gates pass, the capability is
not release-ready.

## Supported live slice

### Environment and selection

- Unreal Engine 5.7 editor Play In Editor only.
- One explicitly selected Remote Control endpoint and its advertised producer.
- One active PIE world, play mode only, with exactly one local player.
- One active scenario run per producer. A second start is rejected rather than merged.
- The deterministic `/Game/Fixture/Scenarios/L_MovementGym` fixture scenario.

The runner binds the run to the producer and PIE session it negotiated. Editor restart, PIE restart,
world replacement, simulation mode, and local-player replacement invalidate that binding. A stale run
is terminal; it never resumes silently against a new world.

### Input layer and registered actions

The supported injection layer is `pre_evaluation`.

UE 5.7's `InjectInputForAction` accepts a raw action value, then Enhanced Input processes mapping
events and applies action modifiers and triggers. That is not direct evaluated-action injection. The
prototype's `injectAt: "evaluated_action"` Movement Gym track is outside this live contract and must
be migrated before execution.

The fixture explicitly registers:

| Action   | Value type | Supported intent                  |
| -------- | ---------- | --------------------------------- |
| Move     | Axis2D     | Bounded continuous movement value |
| Jump     | Boolean    | Press/release jump intent         |
| Interact | Boolean    | Press/release interaction intent  |

Any other action path, value type, input layer, raw-input clip, or executable intervention is
rejected before the run starts. The portable document may retain broader vision data, but the live
runner never pretends unsupported tracks executed.

### Live-input isolation

Authored and live input may not mix. Before the first injected value, the Unreal capability must:

1. install a Slate input preprocessor that consumes live key, analog, mouse, wheel/gesture, and
   motion input;
2. verify that exact preprocessor is registered;
3. flush already pressed keys on the selected player controller; and
4. report isolation ownership in run status.

If any step fails, execution is rejected. The capability removes the isolator on completion,
cancellation, failure, PIE end, world replacement, or module shutdown. Ignore-move/look flags,
disabled pawn input, and focus loss do not satisfy this contract because they do not prove that all
live device paths are separated from authored injection.

### Time, wait, and probe

Clips are scheduled against PIE world game time. Wall time is used only for client-side transport
deadlines and bounded polling.

The first slice supports one blocking wait, `landing_ready`. When its timeline point is reached,
scenario time stops advancing while PIE/game time continues. The run resumes when the fixture state
becomes ready or fails with a typed wait timeout.

The first slice supports one non-blocking probe, `cache_open`. It records a bounded world-state
observation after Interact. Probe failure produces explicit missing evidence and a failed or divergent
terminal result according to the returned observation; it is never converted into a fabricated
capture.

### Result and evidence

Every accepted start has a stable run ID and observable lifecycle:

```text
accepted → isolating → running ↔ waiting → terminal
```

Terminal outcomes distinguish completed, completed with divergence, cancelled, and failed. Failures
carry a stable code, message, recovery guidance, and the lifecycle point that failed. Cancellation is
a result, not a transport exception. Capability negotiation and malformed wire responses remain
typed client errors because no run was accepted.

Evidence is embedded, structured, and bounded by the advertised producer limits. The slice records
only fixture world-state observations needed to explain the run, such as final pawn transform,
landing readiness, cache state, action execution counts, isolation restoration, and game-time
timestamps. It does not store screenshots, arbitrary actor dumps, per-tick input, or unbounded logs.

Divergence records expected versus observed game-time behavior with source and severity. Timing
tolerance is explicit. Physics or scheduling variance is retained rather than hidden behind a clean
status.

## Public workflow

`@ue-shed/scenarios` owns the Effect-native `ScenarioRunner`, schemas, validation, scheduling
orchestration, typed errors, and result interpretation. The Unreal capability owns PIE-world
selection, input isolation, Enhanced Input injection, world conditions, probes, and bounded evidence.
The existing editor play-session and Remote Control services remain shared public dependencies.

The headless CLI executes the same service and prints schema-validated JSON. Scenario Studio depends
on a host-neutral client interface for that runner. Workbench main may provide the interface through
validated IPC, while another trusted host may provide it directly. Renderer components never receive
raw process, filesystem, Remote Control, or Unreal authority.

```text
CLI ───────────────┐
                   ├─ ScenarioRunner ─ Remote Control + editor play session ─ UEShedScenarios
Scenario Studio ───┘
```

## Acceptance

The slice is ready when all of the following are proven:

- capability absent versus available is distinguishable without attempting a run;
- the Movement Gym map and its registered action/probe contract regenerate deterministically;
- Move, Jump, and Interact pass through UE 5.7 pre-evaluation injection and affect real gameplay;
- live device input is blocked during the run and restored on every terminal path;
- the blocking wait pauses scenario time and the probe returns truthful world state;
- evidence limits are enforced and missing evidence remains explicit;
- cancellation stops injection and returns a structured cancelled run;
- PIE replacement and editor restart return stale-session outcomes instead of continuing;
- unsupported action/layer requests are rejected before isolation or injection;
- public service, CLI, and Scenario Studio client paths decode the same request/results;
- pure, service, protocol, CLI, fixture, and real UE 5.7 tests pass; and
- deleting Workbench leaves the complete headless journey intact.

## Out of scope

- gameplay or raw-device recording;
- evaluated-action injection or universal evaluated-action observation;
- arbitrary project action, wait, probe, intervention, or setup registries;
- multiplayer, packaged builds, devices, and remote runners;
- free seeking, broad checkpoint restoration, or mid-run reconnection;
- screenshot-based merge gates and visual pass/fail scoring;
- a scenario streaming transport without measured control-plane pressure.

The broader editable/recordable direction remains in
[Interactive gameplay scenarios](../ideas/interactive-scenarios.md). This document is authoritative
for what the first live slice actually supports.
