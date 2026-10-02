import { randomUUID } from "node:crypto";
import { Clock, Effect, Semaphore } from "effect";
import { CameraArrangementId } from "./camera-arrangement.js";
import { CameraBridgeError, type CameraAuthoringBridge } from "./camera-authoring-bridge.js";
import type {
	CameraSetupIntent,
	CameraSetupOpenIntent,
	CameraSetupOutcome,
	CameraSetupSavedSet
} from "./camera-setup-schema.js";

/** Listing saved sets reads host storage, so polls reuse a listing for this long. */
const savedSetsTtlMillis = 5_000;

/**
 * One poll step; the owning host supplies scheduling, project authority and durable creation.
 *
 * Supplying both `open` and `sets` lets the native panel reopen a saved set for its selected
 * subject: each poll negotiates `reopen` and sends the listing (refreshed at most every five
 * seconds, and after every outcome). Opening shares creation's outcome and acknowledgement rules.
 * Hosts that omit them behave exactly as before, and older plugins ignore the extra fields.
 */
export const makeCameraSetupHost = Effect.fn("CameraSetup.makeHost")(function* <
	E,
	EOpen = never,
	ESets = never
>(args: {
	readonly create: (intent: CameraSetupIntent) => Effect.Effect<void, E>;
	readonly open?: (intent: CameraSetupOpenIntent) => Effect.Effect<void, EOpen>;
	/** Saved sets in the editor's project; the bridge offers those whose subject is selected. */
	readonly sets?: () => Effect.Effect<ReadonlyArray<CameraSetupSavedSet>, ESets>;
}) {
	const hostId = CameraArrangementId.make(randomUUID());
	const gate = yield* Semaphore.make(1);
	let outcome: typeof CameraSetupOutcome.Type | undefined;
	let connectedBridge: CameraAuthoringBridge | undefined;
	let listing:
		| { readonly at: number; readonly sets: ReadonlyArray<CameraSetupSavedSet> }
		| undefined;
	const open = args.open;
	const listSets = args.sets;
	const reopen = Effect.fn("CameraSetup.listSavedSets")(function* () {
		if (!open || !listSets) return undefined;
		const now = yield* Clock.currentTimeMillis;
		if (!listing || now - listing.at >= savedSetsTtlMillis) {
			const previous = listing?.sets ?? [];
			// A failed listing keeps the previous one; creation must not depend on it.
			const sets = yield* listSets().pipe(
				Effect.tapError((cause) =>
					Effect.logWarning("Saved camera sets unavailable", cause)
				),
				Effect.orElseSucceed(() => previous)
			);
			listing = { at: now, sets: sets.slice(0, 256) };
		}
		return { reopen: true, sets: listing.sets } as const;
	});
	const settle = <A, F>(id: typeof CameraArrangementId.Type, effect: Effect.Effect<A, F>) =>
		effect.pipe(
			Effect.match({
				onSuccess: () => ({ id, error: null }),
				onFailure: (cause) => ({
					id,
					error: cause instanceof Error ? cause.message : String(cause)
				})
			})
		);
	return {
		close: Effect.fn("CameraSetup.close")(function* () {
			if (!connectedBridge) return;
			yield* connectedBridge.call({ version: 1, operation: "setup_release", hostId });
			connectedBridge = undefined;
		}, gate.withPermits(1)),
		poll: Effect.fn("CameraSetup.poll")(function* (
			bridge: CameraAuthoringBridge,
			projectName: string
		) {
			const offer = yield* reopen();
			const state = yield* bridge.call({
				version: 1,
				operation: "setup_poll",
				hostId,
				projectName,
				...(outcome ? { outcome } : undefined),
				...offer
			});
			if (state.status !== "setup")
				return yield* Effect.fail(
					new CameraBridgeError({
						code: "unavailable",
						message: state.message,
						recovery: "Connect the camera setup host to the matching editor project."
					})
				);
			connectedBridge = bridge;
			const pending = state.request ?? (open ? state.open : undefined);
			if (!pending || pending.id === outcome?.id) return;
			outcome =
				state.request !== undefined
					? yield* settle(state.request.id, args.create(state.request))
					: state.open !== undefined && open
						? yield* settle(state.open.id, open(state.open))
						: undefined;
			// A new or reopened set must appear in the next listing.
			listing = undefined;
			// Cache the result before acknowledging: a lost reply must never repeat the request.
			const acknowledged = yield* bridge.call({
				version: 1,
				operation: "setup_poll",
				hostId,
				projectName,
				...(outcome ? { outcome } : undefined),
				...(yield* reopen())
			});
			if (acknowledged.status !== "setup")
				return yield* Effect.fail(
					new CameraBridgeError({
						code: "stale",
						message: acknowledged.message,
						recovery: "Inspect the saved camera draft before starting another setup."
					})
				);
		}, gate.withPermits(1))
	};
});
