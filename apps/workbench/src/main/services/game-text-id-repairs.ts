import { makeGameTextIdRepairs, type GameTextIdRepairsApi } from "@ue-shed/game-text/workspace";
import { Context, Effect, Layer } from "effect";
import { EditorWorldControl } from "@ue-shed/engine";
import { LocalFiles } from "../adapters/local-files.js";
import { WorkbenchGameText } from "./game-text.js";
import { WorkbenchProject } from "./project-workspace.js";
import { WorkbenchUnrealConnection } from "./unreal-connection.js";

/** Thin host adapter; the repair proposal and mutation lifecycle belong to Game Text. */
export class WorkbenchGameTextIdRepairs extends Context.Service<
	WorkbenchGameTextIdRepairs,
	GameTextIdRepairsApi
>()("@ue-shed/workbench/GameTextIdRepairs") {}

export const WorkbenchGameTextIdRepairsLive = Layer.effect(
	WorkbenchGameTextIdRepairs,
	Effect.gen(function* () {
		const workspace = yield* WorkbenchGameText;
		const project = yield* WorkbenchProject;
		const connection = yield* WorkbenchUnrealConnection;
		const files = yield* LocalFiles;
		const worlds = yield* EditorWorldControl;
		return yield* makeGameTextIdRepairs({
			workspace,
			current: project.current,
			endpoint: connection.endpoint,
			files,
			editorProject: Effect.fn("Workbench.GameTextIdRepairs.editorProject")(
				function* (endpoint) {
					return (yield* worlds.snapshot(endpoint)).projectRoot;
				}
			)
		});
	})
);
