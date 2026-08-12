import { Effect, Schema } from "effect";
import { describe, expect, it } from "vitest";
import { EditorWorldOpenRequest, decodeEditorWorldOpenResponse } from "./editor-world-control.js";

const contract = {
	name: "unreal-editor-world-control",
	version: { major: 1, minor: 0 }
} as const;

describe("editor world-control wire contract", () => {
	it("accepts an explicit target map request", () => {
		expect(
			Schema.decodeUnknownResult(EditorWorldOpenRequest)({
				contract,
				operationId: "open-fixture-map",
				targetMapPath: "/Game/Fixture/Cameras/L_CameraLoad"
			})._tag
		).toBe("Success");
	});

	it("represents dirty-state refusal without a hidden discard policy", () => {
		const response = {
			after: {
				dirtyWorldPackages: ["/Game/Fixture/Maps/L_Work"],
				mapPath: "/Game/Fixture/Maps/L_Work",
				playSessionActive: false
			},
			before: {
				dirtyWorldPackages: ["/Game/Fixture/Maps/L_Work"],
				mapPath: "/Game/Fixture/Maps/L_Work",
				playSessionActive: false
			},
			code: "dirty_world",
			contract,
			message: "The open editor world has unsaved packages.",
			operationId: "open-fixture-map",
			outcome: "rejected",
			recovery: "Save or revert the dirty world packages, then retry.",
			retrySafe: true,
			targetMapPath: "/Game/Fixture/Cameras/L_CameraLoad"
		};
		expect(Effect.runSync(decodeEditorWorldOpenResponse(response))).toEqual(response);
	});

	it("rejects filesystem paths as map identities", () => {
		expect(
			Schema.decodeUnknownResult(EditorWorldOpenRequest)({
				contract,
				operationId: "open",
				targetMapPath: "C:/Project/Content/Map.umap"
			})._tag
		).toBe("Failure");
	});

	it("rejects engine packages as project map targets", () => {
		expect(
			Schema.decodeUnknownResult(EditorWorldOpenRequest)({
				contract,
				operationId: "open",
				targetMapPath: "/Engine/Maps/Templates/OpenWorld"
			})._tag
		).toBe("Failure");
	});
});
