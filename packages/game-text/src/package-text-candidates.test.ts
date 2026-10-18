import { expect, it } from "vitest";
import { Schema } from "effect";
import { TextCorpus, TextCorpusQuerySummary } from "./schema.js";
import { textCorpusQuery } from "./query.test-support.js";
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
it("keeps old corpus decoding and makes exclusions visible in loc status coverage", () => {
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
	expect(
		Schema.decodeUnknownSync(TextCorpusQuerySummary)(textCorpusQuery(mapped).summary())
			.notGatherablePackages
	).toBe(1);
});
