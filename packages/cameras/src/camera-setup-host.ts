import { randomUUID } from "node:crypto";
import { Effect, Semaphore } from "effect";
import { CameraArrangementId } from "./camera-arrangement.js";
import { CameraBridgeError, type CameraAuthoringBridge } from "./camera-authoring-bridge.js";
import type { CameraSetupIntent, CameraSetupOutcome } from "./camera-setup-schema.js";

/** One poll step; the owning host supplies scheduling, project authority and durable creation. */
export const makeCameraSetupHost = Effect.fn("CameraSetup.makeHost")(function* <E>(args: {
	readonly create: (intent: CameraSetupIntent) => Effect.Effect<void, E>;
}) {
	const hostId = CameraArrangementId.make(randomUUID());
	const gate = yield* Semaphore.make(1);
	let outcome: typeof CameraSetupOutcome.Type | undefined;
	let connectedBridge: CameraAuthoringBridge | undefined;
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
			const state = yield* bridge.call({
				version: 1,
				operation: "setup_poll",
				hostId,
				projectName,
				...(outcome ? { outcome } : undefined)
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
			if (!state.request || state.request.id === outcome?.id) return;
			const intent = state.request;
			outcome = yield* args.create(intent).pipe(
				Effect.match({
					onSuccess: () => ({ id: intent.id, error: null }),
					onFailure: (cause) => ({
						id: intent.id,
						error: cause instanceof Error ? cause.message : String(cause)
					})
				})
			);
			// Cache the result before acknowledging: a lost reply must never repeat creation.
			const acknowledged = yield* bridge.call({
				version: 1,
				operation: "setup_poll",
				hostId,
				projectName,
				outcome
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
