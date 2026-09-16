import { EditorWindowActivation } from "@ue-shed/engine";
import { Context, Effect, Layer } from "effect";
import type { EditorHandoffNotice } from "../../shared/editor-handoff.js";
import { WorkbenchWindow } from "../adapters/electron-window.js";

/** UI handoff policy only. Native activation and foreground permission belong to the engine library. */
export class WorkbenchEditorHandoff extends Context.Service<
	WorkbenchEditorHandoff,
	{ readonly activate: (endpoint: string) => Effect.Effect<EditorHandoffNotice> }
>()("@ue-shed/workbench/WorkbenchEditorHandoff") {}

export const WorkbenchEditorHandoffLive = Layer.effect(
	WorkbenchEditorHandoff,
	Effect.gen(function* () {
		const activation = yield* EditorWindowActivation;
		const window = yield* WorkbenchWindow;
		return WorkbenchEditorHandoff.of({
			activate: Effect.fn("Workbench.EditorHandoff.activate")(function* (endpoint: string) {
				const message = yield* activation.activate(endpoint).pipe(
					Effect.map((result) =>
						result.status === "activated"
							? null
							: `${result.message} ${result.recovery}`
					),
					Effect.catch((error) => Effect.succeed(`${error.message} ${error.recovery}`))
				);
				const notice = { endpoint, message };
				yield* window
					.send("editor-window:handoff", notice)
					.pipe(
						Effect.catch((error) =>
							Effect.logWarning("Editor handoff feedback unavailable", error)
						)
					);
				return notice;
			})
		});
	})
);

export const makeWorkbenchEditorHandoffTestLayer = (
	activate: (endpoint: string) => Effect.Effect<EditorHandoffNotice> = (endpoint) =>
		Effect.succeed({ endpoint, message: null })
) => Layer.succeed(WorkbenchEditorHandoff, { activate });
