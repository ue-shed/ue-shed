import { it } from "@effect/vitest";
import { expect } from "vitest";
import { Effect, Schema } from "effect";
import { TextCorpus, TextCorpusQuerySummary } from "./schema.js";
import { withIndexedCorpus } from "./indexed-corpus.test-support.js";
import { textPackageCoverageSummary } from "./corpus-summary.js";
import {
	isPackageTextCandidate,
	textCorpusWithExcludedPackages
} from "./package-text-candidates.js";

const header = {
	packageFlags: 0,
	gatherableTextDataCount: 0,
	gatherableTextDataOffset: 0,
	hasTextProperty: false
};
it("uses the saved gather flag and summary without a class whitelist", () => {
	expect(isPackageTextCandidate({ ...header, packageFlags: 0x00040000 })).toBe(true);
	expect(
		isPackageTextCandidate({
			...header,
			gatherableTextDataCount: 1,
			gatherableTextDataOffset: 123
		})
	).toBe(true);
	expect(isPackageTextCandidate({ ...header, gatherableTextDataCount: 1 })).toBe(false);
	expect(isPackageTextCandidate({ ...header, hasTextProperty: true })).toBe(false);
});
it.live("keeps old corpus decoding and makes exclusions visible in loc status coverage", () => {
	const corpus = Schema.decodeUnknownSync(TextCorpus)({
		schemaVersion: 1,
		status: "complete",
		units: [],
		diagnostics: [],
		coverage: {
			discoveredPackages: 1,
			inspectedPackages: 0,
			partialPackages: 0,
			failedPackages: 0,
			textUnits: 0,
			textOccurrences: 0,
			resolvedOccurrences: 0,
			unresolvedOccurrences: 0,
			unsupportedTextProperties: 0
		}
	});
	const mapped = textCorpusWithExcludedPackages(corpus, ["Content/Native.uasset"]);
	expect(Schema.decodeUnknownSync(TextCorpus)(mapped)).toEqual(mapped);
	expect(textPackageCoverageSummary(mapped.packageCoverage ?? [])).toEqual({
		counts: { complete: 0, partial: 0, failed: 0, not_gatherable: 1 },
		packages: [{ packageFile: "Content/Native.uasset", status: "not_gatherable" }],
		omitted: 0
	});
	expect(mapped.diagnostics[0]?.message).toContain("Excluded because Unreal does not gather");
	// The index excludes the same package from its header and counts it in the summary.
	return withIndexedCorpus(
		{ units: [] },
		{ notGatherable: ["Content/Native.uasset"] },
		({ query }) =>
			Effect.map(query.summary(), (summary) =>
				expect(
					Schema.decodeUnknownSync(TextCorpusQuerySummary)(summary).notGatherablePackages
				).toBe(1)
			)
	);
});
