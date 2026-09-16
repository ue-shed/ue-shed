import { it } from "@effect/vitest";
import { EditorWindowActivation, EditorWindowActivationError } from "@ue-shed/engine";
import { Effect, Layer } from "effect";
import { expect } from "vitest";
import { makeWorkbenchWindowTestLayer, WorkbenchWindowTest } from "../adapters/electron-window.js";
import { WorkbenchEditorHandoff, WorkbenchEditorHandoffLive } from "./editor-handoff.js";

it.effect("publishes focus failure separately and clears it after a successful handoff", () =>
	Effect.gen(function* () {
		const handoff = yield* WorkbenchEditorHandoff;
		const window = yield* WorkbenchWindowTest;
		expect((yield* handoff.activate("http://blocked:30001")).message).toContain(
			"Windows refused"
		);
		expect((yield* handoff.activate("http://old:30001")).message).toContain("Update Core");
		expect((yield* handoff.activate("http://ready:30001")).message).toBeNull();
		const sent = yield* window.sent();
		expect(sent.map((event) => event.channel)).toEqual(Array(3).fill("editor-window:handoff"));
		expect(sent[2]?.payload).toEqual({ endpoint: "http://ready:30001", message: null });
	}).pipe(
		Effect.provide(
			WorkbenchEditorHandoffLive.pipe(
				Layer.provideMerge(
					Layer.mergeAll(
						makeWorkbenchWindowTestLayer(),
						Layer.succeed(EditorWindowActivation, {
							activate: (endpoint) =>
								endpoint.includes("old")
									? Effect.fail(
											new EditorWindowActivationError({
												operation: "negotiate",
												message: "Update Core",
												recovery: "Restart Unreal."
											})
										)
									: Effect.succeed({
											schemaVersion: 1,
											processId: 42,
											status: endpoint.includes("blocked")
												? "blocked"
												: "activated",
											target: "main_editor",
											restored: false,
											message: "Windows refused",
											recovery: "Use the taskbar."
										})
						})
					)
				)
			)
		)
	)
);
