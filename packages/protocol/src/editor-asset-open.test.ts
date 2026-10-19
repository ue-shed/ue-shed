import { readFileSync } from "node:fs";
import { Effect } from "effect";
import { describe, expect, it } from "vitest";
import { decodeEditorAssetOpenResult } from "./index.js";

function fixture(name: string) {
	// The decoder below validates this language-neutral JSON at the boundary.
	return JSON.parse(
		readFileSync(
			new URL(`../contracts/editor-asset-open/v1/fixtures/${name}.json`, import.meta.url),
			"utf8"
		)
	);
}

describe("editor asset-open wire contract", () => {
	it("decodes success and missing-asset language-neutral fixtures", async () => {
		expect(await Effect.runPromise(decodeEditorAssetOpenResult(fixture("ok")))).toMatchObject({
			status: "ok"
		});
		expect(
			await Effect.runPromise(decodeEditorAssetOpenResult(fixture("asset-not-found")))
		).toMatchObject({ status: "unavailable", reason: "asset_not_found", retrySafe: true });
	});

	it("rejects another contract version, locate results and incomplete refusals", async () => {
		for (const reply of [
			{
				...fixture("ok"),
				contract: { name: "unreal-editor-asset-open", version: { major: 2, minor: 0 } }
			},
			{ ...fixture("ok"), status: "located" },
			{ ...fixture("ok"), status: "unavailable", reason: "editor_refused" },
			{ ...fixture("asset-not-found"), reason: "unknown" }
		]) {
			const error = await Effect.runPromise(Effect.flip(decodeEditorAssetOpenResult(reply)));
			expect(error).toMatchObject({
				_tag: "ContractParseError",
				contract: "EditorAssetOpenResult"
			});
		}
	});
});
