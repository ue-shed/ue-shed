import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve, dirname } from "node:path";
import {
	measureNativeText,
	packageTextFixtureProjects
} from "./package-text-reader.test-support.ts";
import { textCorpusFromExtractionEvents } from "../packages/game-text/dist/index.js";
import { compareTextCorpora } from "./package-text-oracle.test-support.ts";

const executable = resolve(process.argv[2] ?? "target/release/uasset.exe");
const output = resolve(process.argv[3] ?? "test-results/game-text-scale/phase4-reader.json");
const projects = [];
let sampleBytes = 0,
	sampleCount = 0;
for (const project of packageTextFixtureProjects) {
	const old = measureNativeText(executable, project, false);
	const compact = measureNativeText(executable, project, true);
	const corpus = textCorpusFromExtractionEvents({
		projectRoot: resolve(project),
		events: old.events
	});
	const oracle = compareTextCorpora(
		corpus,
		textCorpusFromExtractionEvents({ projectRoot: resolve(project), events: compact.events })
	);
	assert.equal(oracle.equal, true, JSON.stringify(oracle));
	assert.equal(compact.outcome, old.outcome);
	sampleBytes += old.sampleBytes;
	sampleCount += old.sampleCount;
	projects.push({
		project,
		coverage: corpus.coverage,
		old: { bytes: old.outputBytes, milliseconds: old.milliseconds, frames: old.frames },
		compact: {
			bytes: compact.outputBytes,
			milliseconds: compact.milliseconds,
			frames: compact.frames
		},
		oracle
	});
}
await mkdir(dirname(output), { recursive: true });
assert.ok(sampleCount > 0, "Projection requires measured sample widths");
// Keep ALL prior non-gap bytes: no occurrence grouping or diagnostic reduction credit.
const counts = { packages: 166518, occurrences: 1028205, gaps: 4800000 };
const maximumSamples = Math.min(counts.gaps, counts.packages * 3);
const counterBytesPerPackage = Buffer.byteLength(
	JSON.stringify({
		gapCounts: {
			unsupported_text_history: counts.gaps,
			legacy_container_element_without_type_information: counts.gaps,
			feature_unavailable_for_engine_version: counts.gaps,
			property_decoder_rejected: counts.gaps
		},
		gapSamples: [],
		decodeErrors: counts.gaps
	})
);
const projection = {
	counts,
	baselineGiB: 3.26,
	gapGiB: 2.5,
	maximumSamples,
	measuredSampleBytes: sampleBytes / sampleCount,
	counterBytesPerPackage,
	projectedBytes:
		(3.26 - 2.5) * 1024 ** 3 +
		maximumSamples * (sampleBytes / sampleCount + 1) +
		counts.packages * counterBytesPerPackage,
	assumptions:
		"Prior Plan 056 GiB totals; fixture sample widths, not real content. All packages get worst-width counters. No occurrence grouping credit. Not a real-project scan or a size acceptance result."
};
await writeFile(
	output,
	JSON.stringify(
		{
			executableKind: "release",
			selection: "explicit committed package paths; source-only fixtures are empty",
			projects,
			projection
		},
		null,
		2
	) + "\n"
);
process.stdout.write(JSON.stringify(projects, null, 2) + "\n");
process.stdout.write(JSON.stringify(projection, null, 2) + "\n");
