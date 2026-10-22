import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
	corpusOwnershipName,
	prepareCorpusOutput,
	writeCorpusOwnership
} from "./game-text-corpus-ownership.ts";

function project() {
	const root = mkdtempSync(join(tmpdir(), "ue-shed-corpus-ownership-"));
	const content = join(root, "Content", "Fixture", "Corpus");
	const localization = join(root, "Content", "Localization", "UEShedCorpus");
	const config = join(root, "Config", "Localization", "UEShedCorpus_Gather.ini");
	mkdirSync(content, { recursive: true });
	mkdirSync(localization, { recursive: true });
	mkdirSync(join(root, "Config", "Localization"), { recursive: true });
	writeFileSync(join(content, "Owned.uasset"), "owned package");
	writeFileSync(join(localization, "Owned.manifest"), "owned localization");
	writeFileSync(config, "owned config");
	writeCorpusOwnership(root, content, "UEShedCorpus");
	return { root, content, localization, config };
}

for (const where of ["content", "localization", "config"] as const)
	test(`clean refuses edited ${where} before deleting any owned file`, () => {
		const value = project();
		try {
			const file =
				where === "content"
					? join(value.content, "Owned.uasset")
					: where === "localization"
						? join(value.localization, "Owned.manifest")
						: value.config;
			writeFileSync(file, "user edit");
			assert.throws(
				() => prepareCorpusOutput(value.root, value.content, "UEShedCorpus", true),
				/foreign or edited/u
			);
			assert.ok(existsSync(join(value.content, "Owned.uasset")) && existsSync(value.config));
		} finally {
			rmSync(value.root, { recursive: true, force: true });
		}
	});
test("clean refuses a foreign package, a missing receipt, and a receipt path escaping ownership", () => {
	const value = project();
	try {
		const foreign = join(value.content, "Foreign.uasset");
		writeFileSync(foreign, "foreign");
		assert.throws(
			() => prepareCorpusOutput(value.root, value.content, "UEShedCorpus", true),
			/foreign/u
		);
		rmSync(foreign);
		const receipt = join(value.content, corpusOwnershipName);
		const saved = readFileSync(receipt, "utf8");
		rmSync(receipt);
		assert.throws(
			() => prepareCorpusOutput(value.root, value.content, "UEShedCorpus", true),
			/receipt/u
		);
		const decoded = JSON.parse(saved);
		decoded.files[0].path = "../outside.uasset";
		writeFileSync(receipt, JSON.stringify(decoded));
		assert.throws(
			() => prepareCorpusOutput(value.root, value.content, "UEShedCorpus", true),
			/escapes/u
		);
		assert.ok(existsSync(join(value.content, "Owned.uasset")));
	} finally {
		rmSync(value.root, { recursive: true, force: true });
	}
});
test("patch validation preserves files; clean removes exactly the owned roots", () => {
	const value = project();
	try {
		const unrelated = join(value.root, "Content", "Unrelated.uasset");
		writeFileSync(unrelated, "unrelated");
		prepareCorpusOutput(value.root, value.content, "UEShedCorpus", true, false);
		assert.ok(existsSync(value.config));
		prepareCorpusOutput(value.root, value.content, "UEShedCorpus", true);
		assert.ok(
			!existsSync(value.content) &&
				!existsSync(value.localization) &&
				!existsSync(value.config)
		);
		assert.equal(readFileSync(unrelated, "utf8"), "unrelated");
	} finally {
		rmSync(value.root, { recursive: true, force: true });
	}
});
