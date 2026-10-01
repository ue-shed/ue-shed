import type { BlueprintGraphReadResult } from "@ue-shed/extension-blueprint-graphs/contract";
import { Effect } from "effect";
import { adaptWasmBlueprintResult } from "@ue-shed/extension-blueprint-graphs/wasm";
import { describe, expect, it } from "vitest";
import { blueprintRelatedView } from "./related-view.js";

const ready: Extract<BlueprintGraphReadResult, { readonly status: "ready" }> = {
	status: "ready",
	assetPath: "Test.uasset",
	outcome: "complete",
	diagnostics: [],
	blueprint: {
		schema_version: 2,
		object_path: "/Game/Test.Test",
		definition: {
			parent_class: null,
			variables: null,
			default_object: null,
			construction_script: null
		},
		graphs: [
			{ name: "EventGraph", object_path: "/Game/Test.Test:EventGraph", nodes: [], links: [] }
		],
		coverage_gaps: []
	}
};

describe("Blueprint related view eligibility", () => {
	it("offers exactly validated ready evidence with at least one graph", async () => {
		const read = await Effect.runPromise(
			adaptWasmBlueprintResult("Test.uasset", {
				schema_version: 1,
				status: "ok",
				path: "Test.uasset",
				blueprints: [ready.blueprint],
				diagnostics: []
			})
		);
		expect(blueprintRelatedView(read)).toMatchObject({
			status: "available",
			subtitle: "1 graph · 0 nodes",
			read
		});
	});

	it("explains graphless Blueprints without offering a view", () => {
		expect(
			blueprintRelatedView({ ...ready, blueprint: { ...ready.blueprint, graphs: [] } })
		).toMatchObject({
			status: "unavailable",
			message: expect.stringContaining("no saved editor graphs")
		});
	});

	it("explains rejected Control Rig graphs", async () => {
		const read = await Effect.runPromise(
			adaptWasmBlueprintResult("Rig.uasset", {
				schema_version: 1,
				status: "error",
				path: "Rig.uasset",
				kind: "unsupported_capability",
				message: "Control Rig"
			})
		);
		expect(blueprintRelatedView(read)).toMatchObject({
			status: "unavailable",
			message: expect.stringContaining("RigVM")
		});
	});

	it("does not offer a view for empty Blueprint evidence or invalid output", async () => {
		for (const output of [
			{ schema_version: 1, status: "ok", path: "ST.uasset", blueprints: [], diagnostics: [] },
			{ status: "ok", blueprints: [ready.blueprint] }
		]) {
			const read = await Effect.runPromise(adaptWasmBlueprintResult("ST.uasset", output));
			expect(blueprintRelatedView(read).status).toBe("unavailable");
		}
	});

	it("hides all graph-view UI for an inspected non-Blueprint", async () => {
		const read = await Effect.runPromise(
			adaptWasmBlueprintResult("ST.uasset", {
				schema_version: 1,
				status: "ok",
				path: "ST.uasset",
				blueprints: [],
				diagnostics: []
			})
		);
		expect(blueprintRelatedView(read, false)).toEqual({ status: "hidden" });
		expect(blueprintRelatedView(undefined, false)).toEqual({ status: "hidden" });
	});
});
