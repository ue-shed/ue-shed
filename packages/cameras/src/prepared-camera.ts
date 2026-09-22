import { Effect } from "effect";
import { withPreparedWorld, WorldPreparationError, type WorldRequirements } from "@ue-shed/world";
import { renderCamera } from "./camera-render.js";
import type { CameraFrameRequest, CameraRenderSessionRequest } from "./camera-render-schema.js";

/** Prepare actor context or explicit ground bounds, render, then restore both scopes. */
export const renderPreparedCamera = Effect.fn("CameraRenderer.renderPreparedCamera")(
	function* (args: {
		readonly preparation: WorldRequirements;
		readonly session: CameraRenderSessionRequest;
		readonly frame: CameraFrameRequest;
	}) {
		if (
			args.session.expectedMapPath !== args.preparation.world.mapPath ||
			args.session.expectedProjectName !== args.preparation.world.projectName ||
			args.session.policy.preparation.geometry.mode !== "preserve_loading" ||
			args.session.policy.preparation.dataLayers.length !== 0 ||
			args.frame.region !== undefined
		) {
			return yield* new WorldPreparationError({
				code: "policy_mismatch",
				operation: "capture",
				message:
					"Prepared capture requires matching world identity and a preserve-loading camera policy with no separate layers or frame region.",
				recovery:
					"Put actor context, ground regions and Data Layer requirements in preparation."
			});
		}
		return yield* withPreparedWorld(args.preparation, (lease) =>
			Effect.gen(function* () {
				const preparation = yield* lease.checkReady();
				const frame = yield* renderCamera(args);
				const afterCapture = yield* lease.checkReady();
				return { frame, preparation, afterCapture };
			})
		);
	}
);
