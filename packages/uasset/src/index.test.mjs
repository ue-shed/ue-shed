import assert from "node:assert/strict";
import test from "node:test";
import { UnsupportedPlatformError, platformPackageName } from "./index.js";

test("selects the exact Windows x64 package", () => {
	assert.equal(platformPackageName("win32", "x64"), "@ue-shed/uasset-win32-x64");
});

test("reports an actionable typed error for unsupported platforms", () => {
	assert.throws(
		() => platformPackageName("linux", "x64"),
		(error) => {
			assert.ok(error instanceof UnsupportedPlatformError);
			assert.equal(error.code, "UE_SHED_UASSET_UNSUPPORTED_PLATFORM");
			assert.equal(error.platform, "linux");
			assert.equal(error.arch, "x64");
			assert.match(error.message, /Windows x64 only/);
			return true;
		}
	);
});
