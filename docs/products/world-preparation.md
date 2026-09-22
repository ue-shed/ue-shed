# Shared world preparation

`@ue-shed/world` owns temporary editor world preparation. The separately enabled `UEShedWorld`
plugin owns native actor loading references and Data Layer restoration. Cameras, map captures,
inspection tools and headless hosts can compose the same Effect service. Saved package inspection
and offline descriptor codecs belong to `unreal-assets`; the Workbench adds no privileged behavior.

The editor capability is `world.preparation.v1`; its wire contract is
`ue-shed-world-preparation/1.0`. The Core capability manifest advertises the actual loaded module's
Remote Control object path. Requests validate their contract, bounds, budgets and explicit world
identity before loading. A map change, streaming-policy mismatch, missing actor, missing dependency,
project filter, unsupported nested container or layer conflict must not become silent success.

## Selection and evidence

`describe` returns a world instance identity plus project, map and partition policy. `plan` inspects
the requested regions and their actor dependency closure without acquiring loading references.
Bounds, labels, class paths, canonical GUIDs, container IDs, loaded/registered/visible flags and
dependency flags are returned. The inventory covers the root editor descriptors or conventional
persistent actors; it is not a saved-world manifest or a runtime cell inventory.

An actor target expands that actor's editor bounds by `contextExtent`, then selects intersecting
actors and hard dependencies. This is the normal basis for subject capture: loading a camera or
subject alone does not load its environment. Every extent is a half-size in Unreal centimeters.
An actor context of zero still selects actors intersecting the subject's bounds.

For overhead map tiles, provide a region around the tile's ground footprint and relevant height
range, including gutter and a deliberate context margin. A box centered on a high camera can miss
the terrain. For perspective views, the caller must choose a finite view region or maximum context;
a camera pose alone cannot determine every contributor to an image. Distant shadows, sky, fog,
reflections and renderer-specific systems may require additional regions or separate settling.

`ready` proves selected actors are resident and registered plus required effective Data Layer
states. It does not prove visibility of every selected actor, scene completeness outside the selected
regions, texture residency or rendered convergence. Snapshots say `renderReadiness: "not_assessed"`.
Planning remains `planned` even when it reports unloaded actors. Native loading is synchronous;
`checkReady` polls once and fails with evidence if requirements remain blocked; it does not wait for
a future ready state.

## Capture composition

`renderPreparedCamera({ preparation, session, frame })` prepares the world, renders through the
existing shared camera renderer, checks preparation again, then restores both resources. The camera
session must name the same project/map and use `preserve_loading` with no separate Data Layers or
frame region. Preparation owns these requirements once.

The CLI accepts the same optional `preparation` field in the JSON input to `ue-shed camera render`.
Its output includes world preparation evidence before and after capture, and writes the new PNG only
after camera and world restoration succeed.

```ts
import { Effect, Layer } from "effect";
import { RemoteControlClientLive } from "@ue-shed/unreal-connection";
import { worldPreparationLayer } from "@ue-shed/world";
import { cameraRendererLayer, renderPreparedCamera } from "@ue-shed/cameras";

const live = Layer.merge(worldPreparationLayer(endpoint), cameraRendererLayer(endpoint)).pipe(
	Layer.provide(RemoteControlClientLive)
);
const captured =
	yield * renderPreparedCamera({ preparation, session, frame }).pipe(Effect.provide(live));
// captured.frame is renderer evidence; preparation and afterCapture retain world evidence.
```

For many tiles, use `withPreparedWorld(requirements, lease => ...)`, open one camera session inside
that scope, and replace explicit ground regions between frames. The actor budget includes overlap
while loading the next region. Use an empty replacement between disjoint areas if necessary.
Replan when actors are added or move into the area; a lease owns the admitted selection rather than
a continuously maintained spatial subscription.

Existing camera `camera_regions` and Data Layer policies now use this same native manager. Their
versioned behavior still retains up to `maximumRegions` throughout the render session. Existing
map/review workflows that request `preserve_loading` retain that behavior; they do not automatically
guess new context extents. Hosts opt into the prepared helper or compose the world service to choose
their actual capture area. Camera frame settling remains the renderer's responsibility.

## Ownership, recovery and limits

Each lease owns independent Unreal references. Release preserves references held by other leases,
editor regions and pins. Replacement admits the next selection before releasing the previous one.
Actor budgets include dependencies and replacement overlap; separate limits bound native recursive
reference expansion. Exceeding a limit fails before the new selection loads.

Data Layer changes are serialized across layer-changing leases to protect hierarchy restoration.
The original local states are restored only if they still match the lease's applied values. External
changes are preserved and reported as restoration failures. Parent layers must be requested
explicitly when needed. Duplicate layer assets are rejected.

Leases renew for 1–120 seconds, expire after abandoned clients, and close when the editor world
changes, PIE begins or the module shuts down. Closed IDs remain for 120 seconds for idempotent
recovery. Retain acquisition requests and replacement revisions. `poll` renews; `release` is
idempotent during retention. A failed restoration is not a successful workflow result.

Acquisition and replacement start a fresh renewal window after synchronous loading and snapshot
construction finish. The 128-active-lease limit is independent of completed history. A separate
4,096-slot recovery budget reserves a slot for each active lease and retains closed/cancelled
identities for the full recovery window. Exhaustion rejects new identities with retry timing;
existing leases can still poll, replace and release without allocating a new slot.

The scoped helper reports expected restoration failures as typed errors. Caller or cleanup defects
remain defects, and cancellation remains interruption, even if cleanup also fails. Combined failure
diagnostics retain the original work failure.

Unreal unload may reset the editor transaction buffer and schedule GC. Released objects can remain
resident until GC, and other owners can retain them. The package bounds its selection and loading
ownership, not the editor's total memory. The current bounds are listed in the
[package README](../../packages/world/README.md).

The first backend is editor-only and tested on UE 5.7.4 and 5.8.2. Nested actor containers are rejected when
selected. Runtime streaming sources, cooked partition cells, offline ActorMetaData decoding and
automatic whole-view context selection remain future work. A world with editor streaming disabled
keeps its existing loading behavior.

## Verification

Portable tests cover schema validation, planning, replacement revisions, overlapping protocol
identity, lost acquisition/replacement responses, cleanup, defect/interruption preservation, renewal
failure and guarded capture composition. Checked-in JSON
schemas are wire authorities; TypeScript and C++ consume the same valid/invalid request fixtures.

`pnpm test:unreal-plugins <new-evidence-directory>` builds the plugin graph and runs a fresh generic
streaming-enabled map through unloaded discovery, actor context plus a neighbor, distant actor
exclusion, independent overlapping leases, bounded replacement, restoration, expiry and world
change. Deterministic native lifecycle tests simulate loading longer than a short lease, fill the
active and recovery budgets, prove cleanup remains possible at capacity, and verify recovery
identities survive until their retention window ends. Camera preparation tests additionally cover
native Data Layer restoration and both renderer
backends. Set `UE_SHED_UNREAL_ENGINE_ROOT` to the discovered engine installation. The command writes
automation JSON and editor logs under the supplied evidence directory.
