import { GameTextOperationProgress } from "@ue-shed/game-text/schema";
import { makeGameTextOperations, type GameTextOperationsApi } from "@ue-shed/game-text/workspace";
import { Context, Effect, Layer, Schema, Stream } from "effect";
import { gameTextProgressEvent } from "../../shared/ipc-contracts.js";
import { WorkbenchWindow } from "../adapters/electron-window.js";
import { WorkbenchConfiguration } from "../workbench-config.js";
import { WorkbenchProject } from "./project-workspace.js";
import { WorkbenchGameText } from "./game-text.js";

export { safeLocalizationLogLine } from "@ue-shed/game-text/workspace";

export type WorkbenchGameTextOperationsApi = GameTextOperationsApi;
export class WorkbenchGameTextOperations extends Context.Service<
	WorkbenchGameTextOperations,
	WorkbenchGameTextOperationsApi
>()("@ue-shed/workbench/WorkbenchGameTextOperations") {}

/** The workspace's Unreal localization steps, with Workbench's engine setting and window events. */
export const WorkbenchGameTextOperationsLive = Layer.effect(
	WorkbenchGameTextOperations,
	Effect.gen(function* () {
		const gameText = yield* WorkbenchGameText;
		const project = yield* WorkbenchProject;
		const configuration = yield* WorkbenchConfiguration;
		const window = yield* WorkbenchWindow;
		// The window follows Game Text's progress as it changes, at most ten times a second; the
		// last change always goes.
		yield* gameText.progressChanges().pipe(
			Stream.buffer({ capacity: 1, strategy: "sliding" }),
			Stream.throttle({ cost: () => 1, units: 1, duration: "100 millis", strategy: "shape" }),
			Stream.runForEach((progress) =>
				window.send(
					gameTextProgressEvent.channel,
					Schema.encodeSync(gameTextProgressEvent.payload)(progress)
				)
			),
			Effect.forkScoped
		);
		return WorkbenchGameTextOperations.of(
			yield* makeGameTextOperations({
				workspace: gameText,
				project,
				engineRoot: () =>
					configuration.unrealEngineRoot?.status === "configured"
						? configuration.unrealEngineRoot.path
						: undefined,
				notifyProgress: Effect.fn("Workbench.GameTextOperations.notifyProgress")(function* (
					progress: GameTextOperationProgress
				) {
					yield* window.send(
						"game-text:localization:operation-progress",
						Schema.encodeSync(GameTextOperationProgress)(progress)
					);
				})
			})
		);
	})
);
