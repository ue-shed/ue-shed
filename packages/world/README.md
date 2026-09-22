# @ue-shed/world

Prepare an Unreal editor world for bounded work without loading the whole map. Discover unloaded
actors through their descriptors, select an actor plus surrounding context or explicit area bounds,
and hold loading references for an Effect scope. Requires matching `UEShedCore` and `UEShedWorld`
plugins and Remote Control. Play and Simulate must be stopped. Workbench is optional.

```ts
import { Effect, Layer } from "effect";
import { RemoteControlClientLive } from "@ue-shed/unreal-connection";
import { WorldPreparation, withPreparedWorld, worldPreparationLayer } from "@ue-shed/world";

// endpoint and actor identity are explicit host inputs. Coordinates and extents are centimeters.
const program = Effect.gen(function* () {
	const service = yield* WorldPreparation;
	const world = yield* service.describe();
	const requirements = {
		world,
		targets: [
			{
				kind: "actor" as const,
				actor: { actorGuid, containerId },
				contextExtent: { x: 5000, y: 5000, z: 2000 }
			}
		],
		dataLayers: [],
		maximumActors: 5000
	};
	const plan = yield* service.plan(requirements);
	// Inspect plan.actors and plan.issues before choosing to acquire.
	return yield* withPreparedWorld(requirements, (lease) =>
		Effect.gen(function* () {
			const before = yield* lease.checkReady();
			const result = yield* performWork(before);
			return { result, after: yield* lease.checkReady() };
		})
	);
});
const live = worldPreparationLayer(endpoint).pipe(Layer.provide(RemoteControlClientLive));
// Execute at the host boundary: Effect.runPromise(program.pipe(Effect.provide(live))).
```

For discovery without an actor ID, plan a `{ kind: "region", region: { center, extent } }` target.
Planning returns canonical actor GUIDs, container IDs, bounds, current residency and registration,
including actors that are not loaded. Labels are display text, never identity.

`withPreparedWorld` renews ownership, interrupts guarded work when renewal fails, and completes
restoration before returning. `WorldPreparation.acquire` is the lower-level scoped API; use
`lease.guard(work)` for work that must stop if ownership is lost. `lease.replace(targets)` advances a
revision and releases the previous selection. Both old and new areas count against the actor budget
during replacement. Replace with `[]` first when a disjoint move cannot fit that overlap.

`lease.checkReady()` performs one poll and fails with evidence if requirements are blocked; it does
not wait for a future state. Expected release failures become typed `restoration_failed` errors at
the scoped boundary. Programming defects and interruption retain their original causes, including
when restoration also fails.

`ready` means selected actors are resident with registered components and explicitly requested Data
Layers have the requested effective editor state. It does not mean rendered pixels have converged.
Snapshots explicitly return `renderReadiness: "not_assessed"`. Hidden actors remain visible as
evidence; the service does not unhide arbitrary actors or override project filters.

The first backend supports root editor actor containers and conventional persistent-level actors.
Intersecting nested Level Instance containers are rejected. Runtime/PIE streaming, cooked cells,
HLOD quality, GPU/texture/Nanite/Lumen settling and offline binary descriptor decoding are separate
concerns. Actor selection is a snapshot: newly created or moved-in actors require a new plan or
replacement. Streaming-disabled worlds retain their existing whole-world loading policy.

Data Layer requirements identify assets by object path. Duplicate requests and concurrent
layer-changing leases are rejected. Release restores local state only if it still matches what the
lease applied; external changes are preserved and reported as restoration failures. Unreal's editor
unload operation can reset undo history and schedule garbage collection. Ownership is released
immediately; object memory can remain until GC or because another editor owner still holds it.

Limits: 64 targets, 64 Data Layers, 100,000 inventory/selected actors, 100,000 expanded native
references per selection, 250,000 dependency-edge visits per selection, depth 512, 128 active leases,
and 4,096 recovery slots. Each active lease reserves a recovery slot; completed and cancelled
identities occupy those slots for 120 seconds. Completed work does not occupy the active-lease
budget. Recovery exhaustion reports `retention_budget_exceeded` with a minimum retry delay in its
message, while existing leases can still renew, replace and release. Retained identities are never
evicted early to admit new work. Reuse one scoped lease with replacements for large batches.

Replacement can temporarily retain two selections. Leases last 1–120 seconds after preparation and
snapshot construction complete, so synchronous loading does not consume the caller's renewal
window. These limits bound selection and ownership, not total editor memory or rendering cost.

The `./browser` entry exports schemas only. The root exports the service, live/test layers, errors,
scoped workflow and wire schemas. Saved assets remain owned by `@ue-shed/unreal-assets`.

CLI recovery uses the same contract:

```powershell
ue-shed world request describe.json --endpoint http://127.0.0.1:30001
```

```json
{
	"contract": { "name": "ue-shed-world-preparation", "version": { "major": 1, "minor": 0 } },
	"action": "describe"
}
```

Actions are `describe`, `plan`, `acquire`, `poll`, `replace`, and `release`. Explicit CLI acquisition
returns a lease that survives the CLI process until release or expiry. Retain the full acquisition
request and returned world ID. Release also retains cancellation of an as-yet unknown lease in the
matching world, preventing a delayed acquisition from reviving it during retention.
Retry an uncertain acquisition with the same lease ID and requirements;
retry an uncertain replacement with the same revision and targets. Poll renews the lease. Never
change the meaning of an existing identity to retry it.

See the [world preparation contract](../../docs/products/world-preparation.md) for capture composition
and verification, and [wire schemas](../protocol/contracts/world/preparation/v1/) for request details.
