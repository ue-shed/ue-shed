import { Effect } from "effect";
import { register as registerAssetAudits } from "./asset-audits.js";
import { register as registerAssetNavigation } from "./asset-navigation.js";
import { register as registerAuthoring } from "./authoring.js";
import { register as registerCameras } from "./cameras.js";
import { register as registerContentObservatory } from "./content-observatory.js";
import { register as registerConfigExplorer } from "./config-explorer.js";
import { register as registerEditorSession } from "./editor-session.js";
import { register as registerFixture } from "./fixture.js";
import { register as registerGameText } from "./game-text.js";
import { register as registerInputAtlas } from "./input-atlas.js";
import { register as registerMapReview } from "./map-review.js";
import { register as registerMapCapture } from "./map-capture.js";
import { register as registerNiagaraPreview } from "./niagara-preview.js";
import { register as registerProjectWorkspace } from "./project-workspace.js";
import { register as registerProjectCustodian } from "./project-custodian.js";
import { register as registerScenarios } from "./scenarios.js";
import { register as registerShowcase } from "./showcase.js";

/**
 * Registers every Workbench IPC channel. Runs once during `WorkbenchLive` acquisition so
 * finalizers that remove the handlers are bound to the runtime scope.
 */
export const register = Effect.all(
	[
		registerFixture,
		registerShowcase,
		registerProjectWorkspace,
		registerProjectCustodian,
		registerAssetAudits,
		registerAssetNavigation,
		registerGameText,
		registerInputAtlas,
		registerAuthoring,
		registerCameras,
		registerContentObservatory,
		registerConfigExplorer,
		registerEditorSession,
		registerScenarios,
		registerMapCapture,
		registerNiagaraPreview,
		registerMapReview
	],
	{ discard: true }
).pipe(Effect.withSpan("Workbench.Ipc.register"));
