import {
	TextCorpusDiagnosticSummary,
	TextPackageCoverageSummary,
	textCorpusDiagnosticSummary,
	textPackageCoverageSummary
} from "./corpus-summary.js";
import {
	CultureCode,
	FileProvenance,
	LocalizationError,
	LocalizationTargetName,
	type LocalizationTargetEvidence
} from "@ue-shed/localization/browser";
import { Schema } from "effect";
import { LocalizationCultureCounts } from "./localization-schema.js";
import { TextCorpus, TextCorpusSearchPage } from "./schema.js";

/**
 * Read/failure evidence for one manifest, archive, PO, locmeta or word-count file. Null path
 * and typed errors preserve files absent from the working copy.
 */
export const LocalizationFileStatus = Schema.Struct({
	kind: Schema.Literals(["manifest", "archive", "po", "locmeta", "word_count"]),
	culture: Schema.optionalKey(CultureCode),
	status: Schema.Literals(["read", "failed"]),
	relativePath: Schema.NullOr(Schema.String),
	provenance: Schema.optionalKey(FileProvenance),
	error: Schema.optionalKey(LocalizationError)
});
export type LocalizationFileStatus = typeof LocalizationFileStatus.Type;
/**
 * Target status combining culture counts, bounded corpus diagnostics, gather-file evidence and
 * a query page. Partial coverage remains visible beside translation totals.
 */
export const LocalizationStatusReport = Schema.Struct({
	schemaVersion: Schema.Literal(1),
	target: LocalizationTargetName,
	counts: Schema.Array(LocalizationCultureCounts),
	coverage: TextCorpus.fields.coverage,
	packageCoverage: Schema.optionalKey(TextPackageCoverageSummary),
	...TextCorpusDiagnosticSummary.fields,
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

/**
 * Projects all retained target evidence files into read/failure status rows, including absent
 * files and their original typed reader errors.
 */
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

/**
 * Combines a corpus, target evidence and selected query page into a bounded status report. It
 * retains scan/gather failures rather than treating unavailable files as empty data.
 */
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
		...textCorpusDiagnosticSummary(corpus.diagnostics),
		files: localizationEvidenceFileStatuses(evidence),
		page
	};
	if (corpus.packageCoverage !== undefined)
		Object.assign(report, {
			packageCoverage: textPackageCoverageSummary(corpus.packageCoverage)
		});
	return report;
}

const localizationFileNames = {
	manifest: "gathered text file",
	archive: "translation archive",
	po: "PO file",
	locmeta: "localization metadata file",
	word_count: "word count report"
} satisfies Record<LocalizationFileStatus["kind"], string>;

/**
 * A target evidence file that failed, for presentation: the project-relative path and the error
 * code, without provenance. `missing` means the working copy does not have the file.
 */
export const LocalizationFileProblem = Schema.Struct({
	kind: LocalizationFileStatus.fields.kind,
	culture: Schema.optionalKey(CultureCode),
	path: Schema.NullOr(Schema.String),
	state: Schema.Literals(["missing", "unreadable"]),
	code: Schema.String,
	recovery: Schema.String
});
export type LocalizationFileProblem = typeof LocalizationFileProblem.Type;

/** The failed evidence files, separating absent files from files that exist but failed to read. */
export function localizationFileProblems(
	files: readonly LocalizationFileStatus[]
): readonly LocalizationFileProblem[] {
	return files.flatMap((file) => {
		if (file.status !== "failed") return [];
		const code = file.error?.code ?? "unknown";
		return [
			{
				kind: file.kind,
				...(file.culture === undefined ? undefined : { culture: file.culture }),
				path: file.relativePath,
				state:
					file.relativePath === null || code === "file_missing"
						? "missing"
						: "unreadable",
				code,
				recovery: file.error?.recovery ?? ""
			}
		];
	});
}

/** What a reader is told about one failed evidence file and how to recover. */
export interface LocalizationFileExplanation {
	readonly message: string;
	readonly recovery: string;
}

/** Reader-facing wording: absent from the working copy, or unreadable with its error code. */
export function explainLocalizationFile(
	problem: LocalizationFileProblem
): LocalizationFileExplanation {
	const name = localizationFileNames[problem.kind];
	const culture = problem.culture === undefined ? "" : ` (${problem.culture})`;
	if (problem.state === "unreadable")
		return {
			message: `The ${name}${culture} could not be read (${problem.code}): ${problem.path}`,
			recovery: problem.recovery
		};
	if (problem.path === null)
		return {
			message: `This target has no ${name}${culture} configured.`,
			recovery: "Check the target's localization settings in Unreal."
		};
	return {
		message: `Not in this working copy: ${problem.path}`,
		recovery:
			problem.kind === "po"
				? "Run the target's Export step, or get the localization folder from source control."
				: "Run the target's Gather step, or get the localization folder from source control."
	};
}

/** The deepest folder holding every configured evidence file, where Game Text looked for them. */
export function localizationEvidenceFolder(
	files: readonly LocalizationFileStatus[]
): string | undefined {
	const folders = files.flatMap((file) =>
		file.relativePath === null
			? []
			: [file.relativePath.replaceAll("\\", "/").split("/").slice(0, -1)]
	);
	const [first, ...rest] = folders;
	if (first === undefined) return undefined;
	let length = first.length;
	for (const folder of rest) {
		let shared = 0;
		while (shared < length && folder[shared] === first[shared]) shared++;
		length = shared;
	}
	return length === 0 ? undefined : first.slice(0, length).join("/");
}

/** The bounded file fields a host adds to a ready localization target result. */
export interface LocalizationTargetFiles {
	readonly fileProblems?: readonly LocalizationFileProblem[];
	readonly localizationFolder?: string;
}

/**
 * Collects project-relative localization evidence paths for a target. The result reflects
 * retained evidence and supports file scoping without selecting another project.
 */
export function localizationTargetFiles(
	files: readonly LocalizationFileStatus[]
): LocalizationTargetFiles {
	const problems = localizationFileProblems(files);
	const folder = localizationEvidenceFolder(files);
	return {
		...(problems.length > 0 ? { fileProblems: problems } : undefined),
		...(folder === undefined ? undefined : { localizationFolder: folder })
	};
}
