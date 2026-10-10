import { Schema } from "effect";
import { TextCorpusDiagnostic, TextPackageCoverage, TextCorpus } from "./schema.js";

export const MAX_CORPUS_REPORT_ITEMS = 200;
const Count = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0));

export const TextCorpusDiagnosticSummary = Schema.Struct({
	diagnostics: Schema.Array(TextCorpusDiagnostic).check(
		Schema.isMaxLength(MAX_CORPUS_REPORT_ITEMS)
	),
	diagnosticCount: Count,
	diagnosticCounts: Schema.Struct({
		package_inspection_failed: Count,
		package_partially_decoded: Count,
		unsupported_text_history: Count,
		package_not_gatherable: Schema.optionalKey(Count)
	}),
	diagnosticsOmitted: Count
});
export type TextCorpusDiagnosticSummary = typeof TextCorpusDiagnosticSummary.Type;
type DiagnosticCounts = {
	-readonly [K in keyof TextCorpusDiagnosticSummary["diagnosticCounts"]]: TextCorpusDiagnosticSummary["diagnosticCounts"][K];
};

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

export const TextCorpusReport = TextCorpus.mapFields((fields) => ({
	...fields,
	...TextCorpusDiagnosticSummary.fields,
	packageCoverage: Schema.optionalKey(TextPackageCoverageSummary)
}));
export type TextCorpusReport = typeof TextCorpusReport.Type;

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

export function textCorpusDiagnosticSummary(
	diagnostics: readonly TextCorpusDiagnostic[]
): TextCorpusDiagnosticSummary {
	const diagnosticCounts: DiagnosticCounts = {
		package_inspection_failed: 0,
		package_partially_decoded: 0,
		unsupported_text_history: 0
	};
	for (const diagnostic of diagnostics) {
		if (diagnostic.code === "package_not_gatherable")
			diagnosticCounts.package_not_gatherable =
				(diagnosticCounts.package_not_gatherable ?? 0) + 1;
		else diagnosticCounts[diagnostic.code] += 1;
	}
	return {
		diagnostics: diagnostics.slice(0, MAX_CORPUS_REPORT_ITEMS),
		diagnosticCount: diagnostics.length,
		diagnosticCounts,
		diagnosticsOmitted: Math.max(0, diagnostics.length - MAX_CORPUS_REPORT_ITEMS)
	};
}

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
