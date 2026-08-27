import assert from "node:assert/strict";
import test from "node:test";
import { parseUnrealDescriptor, registeredEngineRoot } from "./unreal-project-support.ts";

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

test("resolves a custom association from Unreal registered builds", () => {
	const output = `
HKEY_CURRENT_USER\\Software\\Epic Games\\Unreal Engine\\Builds
	UE-Fixture    REG_SZ    D:/Engines/UE-Fixture
`;

	assert.equal(
		registeredEngineRoot({
			association: "UE-Fixture",
			platform: "win32",
			queryRegistry: () => output
		}),
		"D:/Engines/UE-Fixture"
	);
});

test("does not resolve an absent registered association", () => {
	assert.equal(
		registeredEngineRoot({
			association: "UE-Missing",
			platform: "win32",
			queryRegistry: () => {
				throw new Error("registry value not found");
			}
		}),
		undefined
	);
});
