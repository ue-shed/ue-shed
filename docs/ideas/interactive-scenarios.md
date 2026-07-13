# Interactive gameplay scenarios

> Status: product vision with technical footholds

## Ambition

Make real gameplay behavior recordable, understandable, editable, and reproducible without reducing
it to a raw key macro or forcing every scenario to become test code.

The experience should resemble a small timeline editor or gameplay trace:

```text
t -> [setup]--[Move =====]--[Jump]--[Interact]--[Move ===]--[end]
                         ^ screenshot   ^ world-state probe
                         ^ wait: ready  ^ forced outcome
```

A person can play, keep a useful take, inspect what Unreal evaluated, adjust intent, add observations
or interventions, and run it again. An agent can reason over the same semantic artifact: move a jump,
wait for an actor state, or capture evidence at a marker.

## North star

The product is an **editable, layered scenario document connected to runtime evidence**. A scenario
should explain physical input, evaluated action, authored intent, world setup, gameplay response, and
the evidence people or agents should inspect.

## Principles

### Preserve the ladder from input to outcome

```text
Raw device input
  -> mapping context and key mapping
  -> mapped action value
  -> modifiers and triggers
  -> evaluated action event
  -> gameplay response and probes
```

Evaluated semantic actions are the preferred authoring spine because they are readable and resilient
to remapping. Lower layers remain useful provenance and alternative replay material. Every track must
declare where it was observed and where it is injected so modifiers are not applied twice.

Useful modes include replaying evaluated actions for stable intent, pre-evaluation values to exercise
triggers/modifiers, and hardware input to test devices, mappings, UI, or debug chords.

### Treat missing observation APIs as product space

Unreal offers action injection but no universal public stream of every evaluated Enhanced Input
action. Explore mapping-context discovery, explicit action registries, focused instrumentation, trace
events, reflection, and correlation with gameplay probes. A fixed action list is acceptable for a
tracer bullet but not the final discovery model.

### Record intent and retain evidence

A scenario may contain:

1. semantic action tracks;
2. raw input tracks;
3. screenshots, clips, trace bookmarks, logs, and notes;
4. probes and assertions over gameplay state;
5. setup, checkpoints, seeds, time policy, and wait conditions;
6. interventions, overrides, and fault injection;
7. run metadata and divergence evidence.

Evidence can be useful without becoming a brittle pass/fail gate.

### Author in game time and world conditions

Prefer game time and `wait-until(probe)` over wall-clock sleeps. Determinism is a managed budget, not
a claim that all gameplay is bit-identical. Seed controllable systems, expose divergence sources, and
retain evidence when physics, networking, streaming, or asynchronous work varies.

### Editing is a first-class operation

Recording starts authoring; it does not finish it. Trimming, retiming, splicing, layering, annotating,
and rerunning should feel natural. Continuous axes use segments and sparse keyframes instead of
permanent tick dumps.

Seeking must be honest. Arbitrary gameplay cannot generally jump to a timestamp from input alone.
Restore a checkpoint and replay forward where possible, or mark the interval non-seekable.

### Unreal owns execution; UE Shed owns the workbench

Unreal owns input evaluation, world state, probes, capture, and execution. UE Shed owns the portable
scenario document, timeline authoring, run control, aligned evidence, libraries, and agent-readable
explanations.

The focused capability surface includes arm/stop recording, play/pause/restart, checkpoint execution,
markers/interventions, scenario read/write, health, and active observation layers. The artifact remains
inspectable and runnable without Workbench.

### Humans and agents share one vocabulary

Stable asset paths, gameplay tags, schemas, source-layer metadata, timestamps, and aligned evidence
make scenarios editable by both. Prefer meaningful operations such as `WaitUntilActorReady` or
`AssertQuestStage` over opaque callbacks. Allow project-defined operations through explicit,
capability-scoped registries.

## Technical footholds to verify per supported engine version

| Capability              | Unreal surface                    | Product work                                    |
| ----------------------- | --------------------------------- | ----------------------------------------------- |
| Action injection        | Enhanced Input injection APIs     | Recorder, format, isolation, orchestration      |
| Action processing       | Enhanced Player Input             | General evaluated-action observation            |
| Known action inspection | action instance/value queries     | Active-action discovery                         |
| Raw input observation   | Slate input preprocessing         | Device/focus semantics and correlation          |
| Input test primitives   | Enhanced Input test support       | Gameplay-scale authoring                        |
| UI driving              | automation driver                 | Integration into one scenario document          |
| World tests             | functional and screenshot testing | Timeline and evidence-first workflow            |
| World playback          | demo replay                       | Correlated playable replay, not editable intent |

## Tracer bullet

1. Record a short take with evaluated action events and timestamps.
2. Retain one lower-level raw stream alongside it.
3. Replay through Enhanced Input with explicit live-input isolation.
4. Edit one semantic timing and one continuous segment.
5. Add a screenshot marker, wait-until probe, and gameplay-state observation.
6. Rerun and present all evidence on one timeline.
7. Record where and why replay diverged instead of hiding the mismatch.

## Anti-goals

- A raw key macro whose takes break when bindings change.
- A thin action-injection wrapper with no authoring model.
- Screenshots used only as fragile merge-blocking gates.
- Opaque sleeps in place of world conditions.
- Tracks that do not identify their input layer.
- Replay that silently mixes live and authored input.
- Proprietary UI state that cannot run headlessly.
- Determinism claims that conceal divergence.
- Code-only tests renamed as interactive scenarios.

## Decisions to earn

Layered scenario schema; action discovery/observation; storage form; replay isolation; checkpoint and
seek semantics; evidence/assertion/wait relationships; and execution across PIE, packaged, multiplayer,
and device-runner environments.
