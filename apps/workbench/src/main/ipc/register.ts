import { Effect } from "effect";
import { register as registerAssetAudits } from "./asset-audits.js";
import { register as registerAuthoring } from "./authoring.js";
import { register as registerCameras } from "./cameras.js";
import { register as registerFixture } from "./fixture.js";
import { register as registerGameText } from "./game-text.js";
import { register as registerMapReview } from "./map-review.js";
import { register as registerShowcase } from "./showcase.js";

/**
 * Registers every Workbench IPC channel. Runs once during `WorkbenchLive` acquisition so
 * finalizers that remove the handlers are bound to the runtime scope.
 */
export const register = Effect.all(
	[
		registerFixture,
		registerShowcase,
		registerAssetAudits,
		registerGameText,
		registerAuthoring,
		registerCameras,
		registerMapReview
	],
	{ discard: true }
).pipe(Effect.withSpan("Workbench.Ipc.register"));
