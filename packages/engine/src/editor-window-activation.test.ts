import { Effect, Layer, Schema } from "effect";
import { describe, expect, it } from "vitest";
import { makeRemoteControlClientTestLayer } from "@ue-shed/unreal-connection";
import {
	EditorForegroundPermission,
	EditorWindowActivation,
	EditorWindowActivationLive
} from "./editor-window-activation.js";
const isString = Schema.is(Schema.String);

function exercise(
	options: { endpoint?: string; capability?: boolean; status?: string; responsePid?: number } = {}
) {
	const calls: string[] = [];
	const manifest = {
		schemaVersion: 1,
		producerKind: "unreal_editor",
		capabilities: options.capability === false ? [] : ["editor.window-activation.v1"],
		windowActivationObjectPath: "/Script/Fixture.Window",
		identity: { engineVersion: "5.7", processId: 42, sessionId: "fixture", plugins: [] }
	};
	const layer = EditorWindowActivationLive.pipe(
		Layer.provide(
			Layer.mergeAll(
				Layer.succeed(EditorForegroundPermission, {
					grant: (pid) =>
						Effect.sync(() => {
							calls.push(`grant:${pid}`);
						})
				}),
				makeRemoteControlClientTestLayer((request) => {
					calls.push(request.functionName);
					if (request.functionName === "GetCapabilityManifest")
						return Effect.succeed(manifest);
					expect(request.objectPath).toBe("/Script/Fixture.Window");
					const raw = request.parameters.RequestJson;
					if (!isString(raw)) throw new Error("RequestJson must be a JSON string");
					expect(JSON.parse(raw)).toEqual({
						expectedProcessId: 42
					});
					return Effect.succeed({
						schemaVersion: 1,
						processId: options.responsePid ?? 42,
						status: options.status ?? "activated",
						target: "main_editor",
						restored: false,
						message: "",
						recovery: ""
					});
				})
			)
		)
	);
	return {
		calls,
		run: () =>
			Effect.runPromise(
				Effect.flatMap(EditorWindowActivation, (control) =>
					control.activate(options.endpoint ?? "http://127.0.0.1:30010")
				).pipe(Effect.provide(layer))
			)
	};
}

describe("EditorWindowActivation", () => {
	it("grants permission to only the connected process, then verifies activation", async () => {
		const test = exercise();
		expect((await test.run()).status).toBe("activated");
		expect(test.calls).toEqual(["GetCapabilityManifest", "grant:42", "ActivateEditorWindow"]);
	});
	it("never grants a local process permission for a remote endpoint", async () => {
		const test = exercise({ endpoint: "http://editor.example:30010" });
		await test.run();
		expect(test.calls).toEqual(["GetCapabilityManifest", "ActivateEditorWindow"]);
	});
	it("does not activate an older producer without the capability", async () => {
		const test = exercise({ capability: false });
		await expect(test.run()).rejects.toThrow("does not provide verified window activation");
		expect(test.calls).toEqual(["GetCapabilityManifest"]);
	});
	it("preserves OS refusal instead of claiming focus", async () => {
		expect((await exercise({ status: "blocked" }).run()).status).toBe("blocked");
	});
	it("rejects a response from a changed editor process", async () => {
		await expect(exercise({ responsePid: 43 }).run()).rejects.toThrow("process changed");
	});
});
