import { relative, resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { Effect } from "effect";
import { assetReaderLayer, scanSavedProject } from "../packages/unreal-assets/dist/index.js";
import {
	isPackageTextCandidate,
	packageTextExternalReferences,
	textCorpusWithExcludedPackages,
	textCorpusFromExtractionEvents
} from "../packages/game-text/dist/index.js";
import { compareTextCandidateCorpora } from "./package-text-oracle.test-support.ts";
import { committedPackagePaths, measureNativeText } from "./package-text-reader.test-support.ts";

/** Bounded fixture audit: excluded packages are never passed to the text reader. */
export async function auditPackageTextCandidates(
	executable: string,
	project: string,
	paths: readonly string[] = committedPackagePaths(project)
) {
	const projectRoot = resolve(project);
	const start = performance.now();
	const scan = await Effect.runPromise(
		scanSavedProject({
			projectRoot,
			paths,
			depth: "header",
			headerData: true,
			inventory: true
		}).pipe(Effect.provide(assetReaderLayer({ executable })))
	);
	if (scan.failures.length) throw new Error(JSON.stringify(scan.failures));
	const headerMs = performance.now() - start;
	const headers = scan.assets.map((entry) => {
		if (entry.depth !== "header") throw new Error("Expected header");
		return entry.header;
	});
	const flag = headers.filter(
		(header) => ((header.package.header_data?.packageFlags ?? 0) & 0x00040000) !== 0
	);
	const summary = headers.filter(
		(header) =>
			(header.package.header_data?.gatherableTextDataCount ?? 0) > 0 &&
			(header.package.header_data?.gatherableTextDataOffset ?? 0) > 0
	);
	const textProperty = headers.filter((header) => header.package.header_data?.hasTextProperty);
	const external = packageTextExternalReferences(paths);
	const world = headers.filter((header) => external.has(header.path));
	const candidates = headers
		.filter((header) => {
			const data = header.package.header_data;
			if (data === undefined)
				throw new Error("Missing package header data: upgrade the reader");
			return isPackageTextCandidate(data, external.has(header.path));
		})
		.map((header) => header.path);
	const selected = new Set(candidates);
	const full = measureNativeText(executable, project, false, paths);
	const compact = measureNativeText(executable, project, true, candidates);
	const expected = textCorpusFromExtractionEvents({ projectRoot, events: full.events });
	const excludedPackages = paths.filter((path) => !selected.has(path));
	const exclusions = excludedPackages.map((path) => relative(projectRoot, path));
	const actual = textCorpusWithExcludedPackages(
		textCorpusFromExtractionEvents({
			projectRoot,
			discoveredPackages: paths.length,
			events: compact.events.filter((event) => event.event !== "text_summary")
		}),
		exclusions
	);
	// Unreal's eligibility mapping: compare inspected coverage for selected packages.
	// Keep the complete baseline for text equality and report excluded gaps separately.
	const mappedExpected = textCorpusWithExcludedPackages(
		textCorpusFromExtractionEvents({
			projectRoot,
			discoveredPackages: paths.length,
			events: full.events.filter(
				(event) => event.event !== "text_summary" && selected.has(event.path)
			)
		}),
		exclusions
	);
	const oracle = compareTextCandidateCorpora(expected, mappedExpected, actual, exclusions);
	const textOracle = oracle.text;
	const gapsMovedToExcluded = expected.diagnostics
		.filter((item) => exclusions.includes(item.packageFile))
		.map((item) => ({
			...item,
			message: `Excluded because Unreal does not gather it. Baseline evidence: ${item.message}`
		}));
	return {
		expected,
		actual,
		measurement: {
			project,
			packages: paths.length,
			candidates: candidates.length,
			clauses: {
				flag: flag.length,
				summary: summary.length,
				textProperty: textProperty.length,
				textPropertyBeyondFlag: textProperty.filter((header) => !flag.includes(header))
					.length,
				external: world.length
			},
			excludedPackages,
			gapsMovedToExcluded,
			textOracle,
			lostOccurrences: expected.coverage.textOccurrences - actual.coverage.textOccurrences,
			excluded: paths.length - candidates.length,
			units: expected.units.length,
			occurrences: expected.coverage.textOccurrences,
			fullGaps: expected.coverage.unsupportedTextProperties,
			candidateGaps: actual.coverage.unsupportedTextProperties,
			headerMs,
			fullMs: full.milliseconds,
			candidateMs: compact.milliseconds,
			fullBytes: full.outputBytes,
			candidateBytes: compact.outputBytes,
			oracle
		}
	};
}
