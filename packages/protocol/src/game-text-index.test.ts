import { Schema } from "effect";
import { expect, it } from "vitest";
import { UAssetIoRequest } from "./uasset-io.js";
import { encodeGameTextJoinInput, GameTextIndexBuildRequest } from "./game-text-index.js";

it("negotiates native builds without changing older operation versions", () => {
	const request = {
		contract: { name: "uasset-io", version: { major: 1, minor: 13 } },
		requestId: "native",
		limits: {},
		operation: { kind: "game_text_index", request: { action: "capabilities" } }
	};
	expect(Schema.decodeUnknownSync(UAssetIoRequest)(request).operation.kind).toBe(
		"game_text_index"
	);
	expect(() =>
		Schema.decodeUnknownSync(UAssetIoRequest)({
			...request,
			contract: { name: "uasset-io", version: { major: 1, minor: 12 } }
		})
	).toThrow();
	expect(() =>
		Schema.decodeSync(GameTextIndexBuildRequest)({
			action: "strings",
			configuration: {
				cacheRoot: "cache",
				projectKey: "project",
				targetKey: "target",
				sharedProject: false
			},
			ids: [-1],
			output: "response"
		})
	).toThrow();
});

it("encodes malformed UTF-16 values and object keys with collision-free handles", () => {
	const input = {
		target: { name: "Example" },
		review: {
			records: [{ namespace: "NS\ud800", key: "K", fingerprint: "__ue_shed_join_utf16_" }]
		},
		fileErrors: { ["Bad\udfff.po"]: "invalid_schema" }
	};
	const encoded = encodeGameTextJoinInput(JSON.stringify(input));
	expect(JSON.stringify(encoded)).not.toContain("\\ud800");
	expect(JSON.stringify(encoded)).not.toContain("\\udfff");
	const decoded = Schema.decodeUnknownSync(
		Schema.Struct({ stringCodeUnits: Schema.Record(Schema.String, Schema.Array(Schema.Int)) })
	)(encoded);
	expect(Object.values(decoded.stringCodeUnits)).toContainEqual([78, 83, 0xd800]);
	expect(Object.values(decoded.stringCodeUnits)).toContainEqual([
		66, 97, 100, 0xdfff, 46, 112, 111
	]);
	expect(
		Object.keys(decoded.stringCodeUnits).every((key) =>
			key.startsWith("__ue_shed_join_utf16__")
		)
	).toBe(true);
});
