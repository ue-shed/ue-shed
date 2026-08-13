import assert from "node:assert/strict";
import test from "node:test";
import { parseUnrealDescriptor, registeredEngineRoot } from "./unreal-project-support.mjs";

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
	UE-ManaBreak    REG_SZ    C:/Users/Ryzen/Perforce/Arif_UE-ManaBreak
`;

	assert.equal(
		registeredEngineRoot("UE-ManaBreak", () => output),
		"C:/Users/Ryzen/Perforce/Arif_UE-ManaBreak"
	);
});

test("does not resolve an absent registered association", () => {
	assert.equal(
		registeredEngineRoot("UE-Missing", () => {
			throw new Error("registry value not found");
		}),
		undefined
	);
});
