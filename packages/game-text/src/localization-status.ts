import {
	CultureCode,
	FileProvenance,
	LocalizationError,
	LocalizationTargetName,
	type LocalizationTargetEvidence
} from "@ue-shed/localization/browser";
import { Schema } from "effect";
import { LocalizationCultureCounts } from "./localization-schema.js";
import { TextCorpus, TextCorpusDiagnostic, TextCorpusSearchPage } from "./schema.js";

export const LocalizationFileStatus = Schema.Struct({
	kind: Schema.Literals(["manifest", "archive", "po", "locmeta", "word_count"]),
	culture: Schema.optionalKey(CultureCode),
	status: Schema.Literals(["read", "failed"]),
	relativePath: Schema.NullOr(Schema.String),
	provenance: Schema.optionalKey(FileProvenance),
	error: Schema.optionalKey(LocalizationError)
});
export type LocalizationFileStatus = typeof LocalizationFileStatus.Type;
export const LocalizationStatusReport = Schema.Struct({
	schemaVersion: Schema.Literal(1),
	target: LocalizationTargetName,
	counts: Schema.Array(LocalizationCultureCounts),
	coverage: TextCorpus.fields.coverage,
	packageCoverage: TextCorpus.fields.packageCoverage,
	diagnostics: Schema.Array(TextCorpusDiagnostic),
	files: Schema.Array(LocalizationFileStatus),
	page: TextCorpusSearchPage
});
export type LocalizationStatusReport = typeof LocalizationStatusReport.Type;

type EvidenceFile =
	| LocalizationTargetEvidence["manifest"]
	| LocalizationTargetEvidence["locmeta"]
	| LocalizationTargetEvidence["wordCount"]
	| LocalizationTargetEvidence["cultures"][number]["archive"]
	| LocalizationTargetEvidence["cultures"][number]["po"];

function fileStatus(
	kind: LocalizationFileStatus["kind"],
	file: EvidenceFile,
	culture?: CultureCode
): LocalizationFileStatus {
	const value: LocalizationFileStatus = {
		kind,
		status: file.status,
		relativePath: file.status === "read" ? file.provenance.relativePath : file.relativePath
	};
	if (culture !== undefined) Object.assign(value, { culture });
	if (file.provenance !== undefined) Object.assign(value, { provenance: file.provenance });
	if (file.status === "failed") Object.assign(value, { error: file.error });
	return value;
}

export function localizationEvidenceFileStatuses(
	evidence: LocalizationTargetEvidence
): readonly LocalizationFileStatus[] {
	return [
		fileStatus("manifest", evidence.manifest),
		...evidence.cultures.flatMap((culture) => [
			fileStatus("archive", culture.archive, culture.culture),
			fileStatus("po", culture.po, culture.culture)
		]),
		fileStatus("locmeta", evidence.locmeta),
		fileStatus("word_count", evidence.wordCount)
	];
}

export function localizationStatusReport(
	corpus: TextCorpus,
	evidence: LocalizationTargetEvidence,
	page: TextCorpusSearchPage
): LocalizationStatusReport {
	const report: LocalizationStatusReport = {
		schemaVersion: 1,
		target: evidence.target.name,
		counts: page.localization?.counts ?? [],
		coverage: corpus.coverage,
		diagnostics: corpus.diagnostics,
		files: localizationEvidenceFileStatuses(evidence),
		page
	};
	if (corpus.packageCoverage !== undefined)
		Object.assign(report, { packageCoverage: corpus.packageCoverage });
	return report;
}
