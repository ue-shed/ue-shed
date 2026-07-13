# Real-time actor observatory

> Status: product vision with technical footholds; first UE Shed domain proving slice

## Ambition

Make a running Unreal world legible as a live, navigable system of relevant actors, not only as an
image in an editor viewport.

A developer should be able to see the current population and state of important actors, select one,
understand what changed recently, and move from that evidence to a camera, scenario, Visual Logger,
Rewind Debugger, or another engine-native tool. Retained observations should later support timelines,
tables, charts, trails, heat maps, and questions such as:

- Which actors entered a region, and when did their state change?
- Did an actor disappear because it was destroyed, unloaded, filtered, or disconnected?
- How many actors occupied each semantic state over time?
- Which actors were near an incident marker?
- Does visual evidence agree with recorded simulation state?

## North star

The durable product is a **queryable, time-indexed projection of the running world**, with enough
provenance to explain both its knowledge and its blind spots.

```text
Running UWorld
  | lifecycle + selected state + semantic events
  v
Actor observation subsystem
  +-- live current-state projection --> list / map / inspector / focus
  +-- append-only time segments -----> replay / timelines / incidents
  +-- derived aggregates ------------> tables / charts / heat maps
```

It is not a second simulation, a mirrored UObject graph, or a generic property dump. Unreal remains
authoritative; UE Shed observes, queries, correlates, and retains explicitly selected meaning.

The useful first version is technically simpler than live camera feeds because it avoids rendering,
GPU readback, pixel formats, and video presentation. Its hard problems are semantic: relevance,
identity, lifecycle, authority, sampling truth, bounded history, and honest replay.

## Principles

### Relevance is an authored query

“All relevant actors” must never decay into “every actor and reflected property every frame.” Use
named observation profiles that explain their selection and budget:

```text
NpcOverview: selector + identity + transform + locomotion + coarse AI state
ResourceOverview: selector + transform + availability + region
CombatDebug: health + team + combat state + selected semantic events
Incident: temporary detail around an actor, region, or scenario marker
```

Profiles may select by class, interface, gameplay tag, component, or a game-owned registry. The UI
must answer why an actor is present or absent. Keep known definitions, currently observed residents,
and retained history as distinct truths.

### Identity is layered

No single identifier spans placed and spawned actors, PIE, packaged games, level instances,
multiplayer, and historical sessions.

Each live instance receives a non-recycled runtime ID scoped by producer, session, and world. Records
also retain diagnostic and resolution signals: an optional semantic ID, actor/instance GUID where
valid, soft path, class, label, and location. A new actor with a reused name is a new instance.

Actor GUIDs, network GUIDs, object pointers, labels, and paths are each useful in some contexts; none
is a universal durable key.

### Lifecycle precedes state

Absence from a snapshot is not destruction. The domain should model explicit events such as:

- `Observed` / `NoLongerObserved` for profile membership;
- `Spawned` / `Destroyed` for runtime lifecycle;
- `Loaded` / `Unloaded` for residency;
- `WorldChanged`, `Travelled`, and `ProducerEnded` for stream boundaries.

Unknown causes remain unknown instead of being rewritten into a convenient fiction. Recovery can
converge from a complete snapshot, while history retains known reasons and gap markers.

### Sampling has a declared meaning

“Every tick” is incomplete without a world, clock, phase, cadence, authority, and precision policy.
Start with a declared post-actor-tick phase. Every sample carries producer/session/world identity,
world time, frame or sample sequence, net mode/authority, schema version, and quality flags.

A `UTickableWorldSubsystem` is a natural ownership and scheduling boundary. World delegates provide
explicit tick-phase footholds. Lower fixed rates and event-driven fields are valid when declared.

### Capture small semantic vectors

Common actor state should be compact, typed, versioned, and queryable: transform, velocity, bounds
when useful, a small field set, references to other observed actors, and quality flags.

Recurring concepts should have stable meaning—health, AI state, quest stage, resource availability,
target identity—rather than becoming arbitrary property-name strings. Game-owned providers can
publish capability-scoped schemas without teaching the central collector every gameplay class.

Object Property Trace and Visual Logger are valuable escalation tools for a selected incident. Their
broad or string-heavy data is not the default actor database.

### Current state, events, and history have different guarantees

- Current state is disposable; a slow client may receive a fresh snapshot epoch.
- Lifecycle and semantic events are ordered and reliable within a declared bounded retention window.
- Historical segments are immutable evidence with indexes and explicit gaps.

Use Remote Control for profile selection, arm/disarm, snapshots, focus, health, and small inspection.
Use a bounded local data plane for repeated transforms and events. Slow consumers get coalescing or a
new snapshot, never an unbounded queue of stale deltas.

### Retain a temporal data set, not a tick dump

History should use short segments, dictionaries, periodic keyframes, delta samples, semantic events,
and indexes by time, actor, and region. Retention is tiered: a rolling diagnostic window, promoted
incident intervals, and lower-resolution aggregates where full paths are no longer worth their cost.

Tables, charts, trails, and replay must derive from the same retained meaning rather than separate
collectors that drift semantically.

### Observation replay is not simulation replay

The first replay promise is faithful reconstruction of what UE Shed recorded, including uncertainty,
authority, cadence, and gaps. It does not restore an arbitrary playable world.

Unreal Demo Replay can be a correlated artifact when playable replay matters. Share session/world
identity and clocks; do not make actor history depend on a replay stream as its only store.

### Scale through explicit levels of detail

Profiles declare population, field, cadence, precision, and retention budgets. A selected actor might
publish at 10 Hz, nearby actors at 2 Hz, and distant populations as cell counts until promoted.
Transitions and teleports remain important even when movement samples are sparse.

Measure resident, matched, and observed counts; samples and events per second; collection and
serialization time; bytes; queue depth; drops/coalescing; storage growth; and query latency. The
system must expose its own cost and coverage.

### Preserve coordinate and authority context

Multiple PIE worlds, clients, servers, world-origin changes, and level instances make bare coordinates
ambiguous. Observations require producer/process, world/map, clock, authority, coordinate reference,
and calibration version. Client-local state must not masquerade as server truth.

## Technical footholds to verify per supported engine version

| Unreal surface                                                  | Intended role                                   |
| --------------------------------------------------------------- | ----------------------------------------------- |
| `UWorld` spawn/destruction delegates and actor `EndPlay` reason | Registry lifecycle                              |
| `FWorldDelegates` tick boundaries                               | Declared sampling phase                         |
| `UWorldSubsystem` / `UTickableWorldSubsystem`                   | Per-world ownership and scheduling              |
| `TActorIterator`                                                | One-time registry seeding                       |
| Actor and instance GUIDs                                        | Resolution signals, not universal identity      |
| Object Trace / Rewind Debugger                                  | Linked deep diagnosis                           |
| Visual Logger                                                   | Selective incident evidence                     |
| Demo Replay / `UReplaySubsystem`                                | Optional playable replay correlation            |
| UE Trace                                                        | Low-level export or custom analysis when earned |

## First proving slice

1. Build the generic observatory fixture map with orbit, ping-pong, and seeded-wander actor classes.
2. Host one-world registration in `UEShedObservatory` with explicit profile and lifecycle reasons.
3. Sample transform plus two typed fields at a declared cadence and phase.
4. Deliver a versioned snapshot followed by bounded deltas; force slow-consumer and reconnect recovery.
5. Render search, filtering, state age, and connection health in the first-party extension.
6. Implement **Focus in Unreal** with explicit supported/not-found/not-supported results.
7. Retain a short segment and replay it outside the running editor.
8. Derive one table or chart from the exact retained segment.
9. Publish collection cost, coverage, gaps, and dropped/coalesced update metrics.

Camera preview remains outside this slice. Later, a camera frame can reference the same actor sequence
and world time without becoming the observatory transport.

## Anti-goals

- Claiming to observe all actors while silently applying an arbitrary class list.
- Reflecting every property every frame.
- Polling high-rate actor state through JSON indefinitely.
- Treating absence, unload, destruction, and disconnect as the same event.
- Durable identity based only on names, pointers, or network GUIDs.
- An unbounded delta queue or unlimited full-rate retention.
- Charts computed from a different telemetry path than replay.
- Observation that silently alters streaming, LOD, relevancy, or simulation.
- Replacing Rewind Debugger, Visual Logger, or Demo Replay instead of linking them.

## Decisions to earn

Observation-profile/provider schema; authoritative residency signals; identity across execution modes;
sampling phase and adaptive cadence; snapshot/delta framing and recovery epochs; segment format and
retention; map calibration; trace/logger/replay bridges; and multi-producer security policy.
