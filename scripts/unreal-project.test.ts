import assert from "node:assert/strict";
import test from "node:test";
import {
	installedEngineRoot,
	parseUnrealDescriptor,
	registeredEngineRoot
} from "./unreal-project-support.ts";

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

test("discovers launcher installations independently of custom build associations", () => {
	assert.equal(
		installedEngineRoot({
			version: "4.27",
			platform: "win32",
			queryRegistry: (key) => {
				assert.equal(key, "HKLM\\SOFTWARE\\EpicGames\\Unreal Engine\\4.27");
				return "    InstalledDirectory    REG_SZ    D:/Engines/UE_4.27\r\n";
			}
		}),
		"D:/Engines/UE_4.27"
	);
	assert.equal(
		installedEngineRoot({
			version: "5.3",
			platform: "win32",
			queryRegistry: () => {
				throw new Error("not installed");
			}
		}),
		undefined
	);
	assert.equal(installedEngineRoot({ version: "4.27", platform: "linux" }), undefined);
});
