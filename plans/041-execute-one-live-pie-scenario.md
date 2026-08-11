# Plan 041: Execute one live PIE scenario

> **Executor instructions**: This plan graduates only the Movement Gym PIE tracer bullet. Keep the
> public workflow headless and the Unreal plugin separately enabled. The UE 5.7 Enhanced Input
> injection surface is pre-evaluation: never label its raw action value as evaluated-action
> injection. Refuse a run unless live-device input isolation is installed and observable.

## Status

- **Priority**: P1
- **Effort**: XL
- **Risk**: HIGH — this introduces live input control, game-time scheduling, and executable results.
- **Depends on**: the Scenario Studio prototype in `e5a5c51` and editor play-session capability.
- **Category**: Interactive scenarios product vertical
- **Planned at**: commit `9c2cdce`, 2026-08-11.
- **Status**: COMPLETE — implementation, real UE 5.7 PIE journey, repository gates, and PR evidence
  pass; PR #10 is ready for review

## Outcome

The portable Movement Gym document executes through public Effect services against a real UE 5.7
Play In Editor world and returns one schema-validated `ScenarioRun`. The CLI and Scenario Studio use
the same runner/client contract. Removing Workbench leaves the run fully usable and testable.

The acceptance journey is:

1. launch or attach to the generic fixture editor with `UEShedScenarios` explicitly enabled;
2. negotiate `scenarios.execute.pie.v1` and its bounded limits through `UEShedCore`;
3. start PIE when necessary and bind the run to that exact editor/PIE session;
4. install and verify live-device input isolation, flushing already pressed keys;
5. execute the registered Move, Jump, and Interact action clips in game time as
   `pre_evaluation` values;
6. block once on `landing_ready`, observe `cache_open`, and retain bounded world-state evidence;
7. return a terminal structured run, including missing evidence or divergence when observed;
8. cancel safely, restore input, and reject stale or restarted sessions without silently resuming.

## Product boundary

### Exact supported slice

- UE 5.7 editor PIE only, single local player, one active run per producer.
- One deterministic fixture scenario at `/Game/Fixture/Scenarios/L_MovementGym`.
- One explicit fixture registry with Move (`Axis2D`), Jump (`Boolean`), and Interact (`Boolean`).
- `pre_evaluation` Enhanced Input values only. Action modifiers and triggers still run in Unreal.
- Game-time clip scheduling with one blocking wait and one non-blocking world-state probe.
- JSON control-plane status over the existing Remote Control client; no new stream transport.
- Bounded evidence embedded in the result: no screenshots and no unbounded logs or tick history.
- Typed capability, lifecycle, cancellation, failure, missing-evidence, stale-session, and divergence
  states.

### UE 5.7 API findings that constrain the contract

`IEnhancedInputSubsystemInterface::InjectInputForAction` and
`UEnhancedPlayerInput::InjectInputForAction` take `FInputActionValue RawValue`. UE queues the value in
`InputsInjectedThisTick`, processes it through `ProcessActionMappingEvent`, and later applies action
modifiers and triggers. That proves pre-evaluation injection; it does not prove an API that directly
sets a final evaluated action event.

PIE lifecycle uses the already-proven `UEditorEngine`/`ULevelEditorSubsystem` surfaces behind
`editor.play-session.v1`: `EditorRequestBeginPlay`, `IsPlayingSessionInEditor`,
`IsPlaySessionRequestQueued`, `PlayWorld`, and `RequestEndPlayMap`. Scenario execution additionally
binds to the active PIE world and rejects simulation, missing local players, world replacement, and
session-ID changes.

Slate input preprocessors are evaluated before later input consumers and may consume key, analog,
mouse, wheel/gesture, and motion events. The scenario plugin must register its isolator explicitly,
verify registration, flush the player controller's pressed keys, and unregister it on every terminal
path. Merely setting `SetIgnoreMoveInput`, disabling a pawn, or losing viewport focus is not isolation
because those choices can also suppress authored gameplay response or leave other live input paths.

### Not promised

- recording, raw-device capture, evaluated-action injection, or general action discovery;
- arbitrary project operation/action/probe registries;
- multiplayer, packaged games, external devices, or more than one local player;
- free seeking, save-game checkpoints, or resuming a run after producer/PIE replacement;
- screenshot evidence, visual merge gates, or a scenario data-plane stream;
- background continuation after the CLI/client that owns the run cancels.

## Implementation steps

### Step 1: Freeze language-neutral live-run contracts

Add schema-owned request, status, result, evidence, divergence, limits, and error variants. Migrate
the Movement Gym live track to `injectAt: "pre_evaluation"`; retain `evaluated_action` only as an
observation/vision term not exercised by this slice. Make the one supported wait/probe vocabulary
explicit rather than accepting expression strings as executable authority.

**Verify**: bidirectional protocol fixtures cover every lifecycle and terminal variant, invalid
layers/actions, limits, and malformed producer responses.

### Step 2: Build the optional Unreal execution capability

Turn `UEShedScenarios` into runtime/editor modules. Advertise object path, capability IDs, and limits
only when its editor module is loaded. Accept start/status/cancel control calls, bind each run to the
active PIE world/session, and keep only one bounded terminal result for lookup.

Install a Slate input preprocessor for live-device isolation, flush pressed input, and finalize it on
completion, cancellation, failure, PIE end, world replacement, and module shutdown. Use the verified
Enhanced Input local-player subsystem to inject raw action values before evaluation. Schedule by PIE
world seconds, pause scenario time during the blocking wait, and record timing divergence honestly.

**Verify**: native protocol/conformance tests cover capability advertisement, isolation failure,
unsupported action/layer, stale world, cancellation, bounds, and deterministic state transitions.

### Step 3: Add the deterministic Movement Gym fixture

Add fixture-owned native gameplay types and deterministically generate the Movement Gym map. The
fixture registers exactly Move, Jump, and Interact with the scenario runtime, binds those actions via
Enhanced Input, exposes `landing_ready` and `cache_open`, and supplies bounded state snapshots.

Keep changes separate from animation parser fixtures and do not rewrite unrelated commandlet work.

**Verify**: fixture generation and verify-only paths assert the map, native game mode/pawn, registered
action assets/types, probe actor, geometry, tags, and fixture-contract entries.

### Step 4: Add the public Effect runner and CLI

Create an Effect-native `ScenarioRunner` service in `@ue-shed/scenarios`. It negotiates the producer,
starts or reuses PIE through public play-session services, validates the exact session, starts the
scenario, polls the low-volume control status with bounded `Schedule`, handles interruption by
cancelling the run, and returns typed results without hiding stale/capability failures.

Add `ue-shed scenarios run <endpoint>` for the shipped Movement Gym document. JSON stdout is the
schema-validated `ScenarioRun`; typed setup failures use stderr/non-zero exit, while a valid failed or
cancelled run remains structured output with a non-zero command outcome.

**Verify**: pure/service/CLI tests cover success, missing evidence, divergence, editor restart, stale
PIE, capability missing, unsupported action/layer, timeout, and cancellation without real sleeps.

### Step 5: Connect Scenario Studio through the same client seam

Replace the prototype's fake transport and saved-run authority with a host-neutral Scenario Studio
client interface whose operations use the public runner contract. Standalone preview may provide a
clearly labeled demo client. Workbench main/preload/renderer only adapt that contract; they do not
gain a private scenario endpoint or implement scheduling.

Correct all UI wording to pre-evaluation injection and show connecting, isolating, running, waiting,
cancelling, completed, divergence, missing-evidence, failed, and stale/capability-missing states.

**Verify**: component and IPC/client conformance tests prove the same request/result shapes and no
Workbench dependency from the scenario package/extension.

### Step 6: Prove the slice against real UE 5.7

Build and verify the fixture, launch the Movement Gym map, execute through the public runner/CLI, and
assert the registered actions changed the pawn/world state. Prove the blocking wait, world probe,
bounded evidence, isolation ownership/restoration, cancellation, PIE replacement, and editor restart.
The test must stop only a PIE/editor process it launched.

**Verify**: focused tests, fixture verify, real UE integration, CLI child-process journey,
`pnpm check`, and a second final `pnpm check` all pass.

### Step 7: Finish the plan and PR

Update the product contract and this plan with exact evidence, push every commit, summarize gates in
the draft PR, then mark it ready only after portable and real UE 5.7 gates pass.

## Done criteria

- [x] `UEShedScenarios` is separately enabled and advertises only implemented capabilities/limits.
- [x] Movement Gym is a deterministic generic fixture with exactly three registered actions.
- [x] Every executed input clip is truthfully labeled `pre_evaluation`.
- [x] A run is refused unless live-device isolation is installed, verified, and later restored.
- [x] Clips run in game time with one blocking wait and one world-state probe.
- [x] Evidence is bounded and missing evidence remains explicit.
- [x] Lifecycle, cancellation, failure, stale session, capability missing, and divergence are typed.
- [x] `ScenarioRunner` is public and Effect-native; the CLI runs the same service headlessly.
- [x] Scenario Studio uses the public client contract and has no Workbench-only authority.
- [x] Pure, service, protocol, CLI, fixture, restart, and real UE 5.7 gates pass.
- [x] `pnpm check` passes after substantive edits and immediately before handoff.
- [x] The PR contains evidence and is ready for review.

## STOP conditions

- UE 5.7 source contradicts the pre-evaluation model or the implementation would need to call it
  evaluated-action injection.
- Live-device isolation cannot be installed, verified, or restored for the active PIE world.
- The active producer, PIE session, world, or local player cannot be selected explicitly.
- A required result would depend on unbounded tick/log history or an unproven streaming transport.
- The workflow requires Workbench-only authority or private project knowledge.
- Fixture work would overwrite the parallel animation/fixture-commandlet changes.
- A real test cannot distinguish owned from user-owned editor/PIE lifecycle.

## Deferred

- recording and editing recorded takes;
- evaluated-action observation/injection and raw-device replay;
- general project registries or plugin-authored scenario catalogs;
- arbitrary waits, probes, interventions, checkpoints, and seeking;
- screenshots, video, traces, and long-lived streaming progress;
- multiplayer, packaged builds, device runners, and capture farms.
