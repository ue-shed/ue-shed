import { Schema } from "effect";
import { TextCorpusDiagnostic, TextPackageCoverage, TextCorpus } from "./schema.js";

/**
 * Maximum diagnostic and non-complete-package previews in a corpus report. Separate omitted
 * counts preserve the extent of evidence beyond this bound.
 */
export const MAX_CORPUS_REPORT_ITEMS = 200;
const Count = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0));

/**
 * Bounded diagnostic preview with exact total, per-code counts and omitted count. A truncated
 * preview must not be interpreted as the complete set of inspection failures.
 */
export const TextCorpusDiagnosticSummary = Schema.Struct({
	diagnostics: Schema.Array(TextCorpusDiagnostic).check(
		Schema.isMaxLength(MAX_CORPUS_REPORT_ITEMS)
	),
	diagnosticCount: Count,
	diagnosticCounts: Schema.Struct({
		package_inspection_failed: Count,
		package_partially_decoded: Count,
		unsupported_text_history: Count,
		package_not_gatherable: Schema.optionalKey(Count),
		gatherable_text_not_decoded: Schema.optionalKey(Count)
	}),
	diagnosticsOmitted: Count
});
export type TextCorpusDiagnosticSummary = typeof TextCorpusDiagnosticSummary.Type;
type DiagnosticCounts = {
	-readonly [K in keyof TextCorpusDiagnosticSummary["diagnosticCounts"]]: TextCorpusDiagnosticSummary["diagnosticCounts"][K];
};

/**
 * Counts for all package completion states plus a bounded preview of non-complete packages.
 * Complete packages contribute to counts but do not occupy the problem preview.
 */
export const TextPackageCoverageSummary = Schema.Struct({
	counts: Schema.Struct({
		complete: Count,
		partial: Count,
		failed: Count,
		not_gatherable: Schema.optionalKey(Count)
	}),
	packages: Schema.Array(
		TextPackageCoverage.mapFields((fields) => ({
			...fields,
			status: Schema.Literals(["partial", "failed", "not_gatherable"])
		}))
	).check(Schema.isMaxLength(MAX_CORPUS_REPORT_ITEMS)),
	omitted: Count
});
export type TextPackageCoverageSummary = typeof TextPackageCoverageSummary.Type;

/**
 * A corpus header as a report shows it: coverage, every diagnostic and package count, and bounded
 * previews. An index answers it in Rust; the whole header lists every package.
 */
export const TextCorpusReportHeader = Schema.Struct({
	coverage: TextCorpus.fields.coverage,
	...TextCorpusDiagnosticSummary.fields,
	packageCoverage: Schema.optionalKey(TextPackageCoverageSummary)
});
export type TextCorpusReportHeader = typeof TextCorpusReportHeader.Type;

/** The report header of a whole corpus or its header. */
export function textCorpusReportHeader(
	header: Pick<TextCorpus, "coverage" | "diagnostics" | "packageCoverage">
): TextCorpusReportHeader {
	const result: TextCorpusReportHeader = {
		coverage: header.coverage,
		...textCorpusDiagnosticSummary(header.diagnostics)
	};
	return header.packageCoverage === undefined
		? result
		: { ...result, packageCoverage: textPackageCoverageSummary(header.packageCoverage) };
}

/**
 * Export corpus with bounded diagnostic and package-coverage previews. Unit data remains
 * complete for the supplied corpus; omitted preview counts retain uncertainty.
 */
export const TextCorpusReport = TextCorpus.mapFields((fields) => ({
	...fields,
	...TextCorpusDiagnosticSummary.fields,
	packageCoverage: Schema.optionalKey(TextPackageCoverageSummary)
}));
export type TextCorpusReport = typeof TextCorpusReport.Type;

/**
 * Projects a corpus into its report form, bounding diagnostics and non-complete-package
 * previews without changing unit data or aggregate coverage.
 */
export function textCorpusReport(corpus: TextCorpus): TextCorpusReport {
	const { packageCoverage, ...rest } = corpus;
	return {
		...rest,
		...textCorpusDiagnosticSummary(corpus.diagnostics),
		...(packageCoverage === undefined
			? undefined
			: { packageCoverage: textPackageCoverageSummary(packageCoverage) })
	};
}

/**
 * Counts every supplied diagnostic by code while retaining only the first
 * MAX_CORPUS_REPORT_ITEMS as a preview. diagnosticsOmitted records the remaining items.
 */
export function textCorpusDiagnosticSummary(
	diagnostics: readonly TextCorpusDiagnostic[]
): TextCorpusDiagnosticSummary {
	const diagnosticCounts: DiagnosticCounts = {
		package_inspection_failed: 0,
		package_partially_decoded: 0,
		unsupported_text_history: 0
	};
	for (const diagnostic of diagnostics) {
		if (
			diagnostic.code === "package_not_gatherable" ||
			diagnostic.code === "gatherable_text_not_decoded"
		)
			diagnosticCounts[diagnostic.code] = (diagnosticCounts[diagnostic.code] ?? 0) + 1;
		else diagnosticCounts[diagnostic.code] += 1;
	}
	return {
		diagnostics: diagnostics.slice(0, MAX_CORPUS_REPORT_ITEMS),
		diagnosticCount: diagnostics.length,
		diagnosticCounts,
		diagnosticsOmitted: Math.max(0, diagnostics.length - MAX_CORPUS_REPORT_ITEMS)
	};
}

/**
 * Counts every package state and previews only partial, failed and not-gatherable packages.
 * Reports the number of additional problem packages beyond the preview bound.
 */
export function textPackageCoverageSummary(
	coverage: NonNullable<TextCorpus["packageCoverage"]>
): TextPackageCoverageSummary {
	const counts: TextPackageCoverageSummary["counts"] = { complete: 0, partial: 0, failed: 0 };
	const packages: Array<TextPackageCoverageSummary["packages"][number]> = [];
	let omitted = 0;
	for (const item of coverage) {
		if (item.status === "not_gatherable")
			Object.assign(counts, { not_gatherable: (counts.not_gatherable ?? 0) + 1 });
		else Object.assign(counts, { [item.status]: counts[item.status] + 1 });
		if (item.status === "complete") continue;
		if (packages.length < MAX_CORPUS_REPORT_ITEMS)
			packages.push({ packageFile: item.packageFile, status: item.status });
		else omitted += 1;
	}
	return { counts, packages, omitted };
}
