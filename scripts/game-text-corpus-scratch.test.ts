import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
	assertCorpusScratch,
	createCorpusScratch,
	corpusScratchMarker
} from "./game-text-corpus-scratch.ts";

test("only generator-created scratch projects can be reused", () => {
	const folder = mkdtempSync(join(tmpdir(), "corpus-scratch-test-")),
		project = join(folder, "Corpus.uproject");
	try {
		createCorpusScratch(project, "5.8");
		assertCorpusScratch(project);
		createCorpusScratch(project, "5.8");
		assert.ok(
			readFileSync(join(folder, corpusScratchMarker), "utf8").includes(
				"ue-shed-corpus-scratch"
			)
		);
		writeFileSync(project, "user project");
		assert.throws(() => assertCorpusScratch(project), /altered or foreign/u);
	} finally {
		rmSync(folder, { recursive: true, force: true });
	}
});
test("a minimal real project, a nonempty folder, and a repository are all refused", () => {
	const folder = mkdtempSync(join(tmpdir(), "corpus-real-project-test-")),
		project = join(folder, "Game.uproject");
	try {
		writeFileSync(project, '{"FileVersion":3}');
		assert.throws(() => createCorpusScratch(project, "5.8"), /did not create/u);
		assert.equal(readFileSync(project, "utf8"), '{"FileVersion":3}');
		rmSync(project);
		writeFileSync(join(folder, "existing.txt"), "owned by someone else");
		assert.throws(() => createCorpusScratch(project, "5.8"), /did not create/u);
		mkdirSync(join(folder, ".git"));
		assert.throws(() => createCorpusScratch(project, "5.8"), /outside every repository/u);
	} finally {
		rmSync(folder, { recursive: true, force: true });
	}
});
