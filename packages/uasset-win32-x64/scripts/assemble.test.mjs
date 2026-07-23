import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { assemble } from "./assemble.mjs";

test("copies a validated PE artifact to the requested package path", () => {
	const root = mkdtempSync(join(tmpdir(), "ue-shed-uasset-assemble-"));
	try {
		const source = join(root, "release", "uasset.exe");
		const destination = join(root, "package", "bin", "uasset.exe");
		mkdirSync(join(root, "release"));
		writeFileSync(source, Buffer.from("MZ deterministic fixture"), { flush: true });
		assert.equal(assemble({ source, destination, verifyVersion: false }), destination);
		assert.deepEqual(readFileSync(destination), readFileSync(source));
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("rejects a non-PE input", () => {
	const root = mkdtempSync(join(tmpdir(), "ue-shed-uasset-assemble-"));
	try {
		const source = join(root, "uasset.exe");
		writeFileSync(source, "not a Windows executable");
		assert.throws(
			() => assemble({ source, destination: join(root, "out.exe"), verifyVersion: false }),
			/Expected a Windows PE executable/
		);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});
