import assert from "node:assert/strict";
import test from "node:test";
import { validateLicenseBoundary } from "./check-license-boundary.mjs";

const validInput = {
	rootManifest: { license: "MIT" },
	rootLicense: "MIT License\n\nPermission is hereby granted",
	peculiarManifest: {
		version: "0.11.0",
		license: "MIT",
		dependencies: { "better-result": "^2.8.2" }
	},
	productionPaths: {
		hyperformula: [],
		"peculiar-sheets-ironcalc": [],
		"@ironcalc/wasm": []
	}
};

test("accepts the formula-free MIT distribution boundary", () => {
	assert.deepEqual(validateLicenseBoundary(validInput), []);
});

test("rejects a reintroduced formula engine on any production path", () => {
	const failures = validateLicenseBoundary({
		...validInput,
		productionPaths: {
			...validInput.productionPaths,
			hyperformula: [{ name: "hyperformula" }]
		}
	});
	assert.deepEqual(failures, ["hyperformula: found a UE Shed production dependency path"]);
});

test("rejects license, version, and packed-core dependency drift", () => {
	const failures = validateLicenseBoundary({
		...validInput,
		rootManifest: { license: "UNLICENSED" },
		rootLicense: "not a license",
		peculiarManifest: {
			version: "0.12.0",
			license: "GPL-3.0-only",
			dependencies: { hyperformula: "^3.0.0" }
		}
	});
	assert.deepEqual(failures, [
		"package.json: license must be MIT",
		"LICENSE: expected the MIT license text",
		"peculiar-sheets: expected exact version 0.11.0, received 0.12.0",
		"peculiar-sheets: expected MIT metadata, received GPL-3.0-only",
		"peculiar-sheets: production dependency hyperformula violates the formula-free core boundary"
	]);
});
