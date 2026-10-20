import assert from "node:assert/strict";
import test from "node:test";
import { parseUnrealDescriptor } from "./unreal-project-support.ts";

test("parses Unreal descriptors with comments and trailing commas", () => {
	const descriptor = parseUnrealDescriptor(`\ufeff{
		// Unreal permits comments in descriptors.
		"Modules": [{ "Name": "Example,]", },],
		"EngineAssociation": "UE-Custom",
	}`);

	assert.deepEqual(descriptor, {
		Modules: [{ Name: "Example,]" }],
		EngineAssociation: "UE-Custom"
	});
});
