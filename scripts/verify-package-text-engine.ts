import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve, relative, isAbsolute, dirname } from "node:path";
import { Effect, Stream } from "effect";
import {
	assetReaderLayer,
	extractProjectText,
	extractProjectTextPackages
} from "../packages/unreal-assets/dist/index.js";
import { textCorpusFromExtractionEvents } from "../packages/game-text/dist/index.js";
import { ensureUassetExecutable } from "./native-tools.ts";
import { compareTextCorpora } from "./package-text-oracle.test-support.ts";

const matrix = resolve(process.argv[2] ?? "");
const rel = relative(resolve("out"), matrix);
assert.ok(
	process.argv[2] &&
		rel &&
		!isAbsolute(rel) &&
		rel !== ".." &&
		!rel.startsWith("../") &&
		!rel.startsWith("..\\"),
	"Provide a repository out/ matrix directory"
);
const executable = ensureUassetExecutable();
const results = [];
for (const version of ["5.7", "5.8"]) {
	const projectRoot = resolve(matrix, version, "fixture");
	const layer = assetReaderLayer({ executable });
	const old = await Effect.runPromise(
		extractProjectText({ projectRoot }).pipe(Stream.runCollect, Effect.provide(layer))
	);
	const compact = await Effect.runPromise(
		extractProjectTextPackages({ projectRoot }).pipe(Stream.runCollect, Effect.provide(layer))
	);
	const expected = textCorpusFromExtractionEvents({ projectRoot, events: old });
	const actual = textCorpusFromExtractionEvents({ projectRoot, events: compact });
	const oracle = compareTextCorpora(expected, actual);
	assert.equal(oracle.equal, true, JSON.stringify(oracle));
	results.push({ version, coverage: actual.coverage, oracle });
}
const output = resolve("test-results/game-text-scale/phase4-engine-text.json");
await mkdir(dirname(output), { recursive: true });
await writeFile(output, JSON.stringify(results, null, 2) + "\n");
process.stdout.write(JSON.stringify(results, null, 2) + "\n");
