import { Schema } from "effect";
import {
	CultureCode,
	LocalizationTargetName,
	LocalizationChange,
	LocalizationChangeSet
} from "@ue-shed/localization/browser";
import { TextCorpus, TextUnitId } from "./schema.js";
import {
	TextQualityFindingId,
	TextQualityFocus,
	textQualityFindingId,
	textQualityQuery
} from "./quality-query.js";
import {
	TextQualityAffectedOccurrence,
	TextQualityRuleSummary,
	type TextQualityReport
} from "./quality-schema.js";
import {
	LocalizationCheckDiagnostic,
	type LocalizationQualityReport
} from "./localization-quality-schema.js";
import { LocalizationFocus, localizationFocusPage } from "./localization-view.js";
import { LocalizationUnknownReason, type LocalizationJoin } from "./localization-schema.js";
import { localizationShippedTranslation } from "./localization-shipped-translation.js";
import {
	LocalizationProgressCulture,
	type LocalizationProgressReport,
	type LocalizationBaseline
} from "./localization-reports.js";
import { textCountLabel } from "./csv.js";
import { textAssetName, spreadsheetCsv } from "./csv.js";

const Count = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0));
const Offset = Schema.optionalKey(Count);
const Excerpt = Schema.String.check(Schema.isMaxLength(4096));
export const WorkspaceQualityFilter = Schema.Literals([
	"all",
	"character_budget",
	"terminology",
	"format_arguments",
	"argument_modifiers",
	"rich_text",
	"po_escape_safety",
	"whitespace",
	"empty_translation",
	"missing_translator_notes",
	"duplicate_source"
]);
export type WorkspaceQualityFilter = typeof WorkspaceQualityFilter.Type;
export const workspaceQualityLabels = {
	all: "All findings",
	character_budget: "Character limits",
	terminology: "Terminology",
	format_arguments: "Format arguments",
	argument_modifiers: "Plural and gender forms",
	rich_text: "Rich text tags",
	po_escape_safety: "Unsafe escapes",
	whitespace: "Whitespace",
	empty_translation: "Empty translation",
	missing_translator_notes: "No translator notes",
	duplicate_source: "Same text, different keys"
} satisfies Record<WorkspaceQualityFilter, string>;
const Selection = { target: LocalizationTargetName, culture: Schema.optionalKey(CultureCode) };
export const WorkspaceQualityRequest = Schema.Struct({
	...Selection,
	filter: WorkspaceQualityFilter,
	offset: Offset
});
export type WorkspaceQualityRequest = typeof WorkspaceQualityRequest.Type;
export const WorkspaceQualityFocusRequest = Schema.Struct({
	...Selection,
	id: TextQualityFindingId,
	occurrenceOffset: Offset,
	poContextOffset: Offset
});
export type WorkspaceQualityFocusRequest = typeof WorkspaceQualityFocusRequest.Type;
export const WorkspaceFinding = Schema.Struct({
	id: TextQualityFindingId,
	filter: WorkspaceQualityFilter,
	source: Schema.String.check(Schema.isMaxLength(512)),
	problem: Schema.String.check(Schema.isMaxLength(1024)),
	context: Schema.String.check(Schema.isMaxLength(1024)),
	culture: Schema.optionalKey(CultureCode)
});
export type WorkspaceFinding = typeof WorkspaceFinding.Type;
export const WorkspaceQualityPage = Schema.Struct({
	findings: Schema.Array(WorkspaceFinding).check(Schema.isMaxLength(50)),
	total: Count,
	counts: Schema.Record(WorkspaceQualityFilter, Count),
	nextOffset: Offset,
	suggestedFixCount: Count,
	limits: Schema.Array(
		Schema.Struct({ code: LocalizationCheckDiagnostic.fields.code, count: Count })
	).check(Schema.isMaxLength(32)),
	unsupportedRuleCultures: Count,
	rules: Schema.Array(TextQualityRuleSummary).check(Schema.isMaxLength(1032))
});
export type WorkspaceQualityPage = typeof WorkspaceQualityPage.Type;
const Failure = Schema.Struct({
	status: Schema.Literal("failed"),
	message: Schema.String,
	recovery: Schema.String
});
const NotReady = Schema.Struct({ status: Schema.Literal("not_ready") });
export const WorkspaceQualityResult = Schema.Union([
	NotReady,
	Failure,
	Schema.Struct({ status: Schema.Literal("ready"), page: WorkspaceQualityPage })
]);
export type WorkspaceQualityResult = typeof WorkspaceQualityResult.Type;
const BoundedChange = LocalizationChange.mapFields((fields) => ({
	...fields,
	source: Schema.String.check(Schema.isMaxLength(16384)),
	translation: Schema.String.check(Schema.isMaxLength(16384)),
	previousTranslation: Schema.NullOr(Schema.String.check(Schema.isMaxLength(16384)))
}));
const Changes = LocalizationChangeSet.mapFields((fields) => ({
	...fields,
	provenance: fields.provenance.mapFields((provenance) => ({
		...provenance,
		files: provenance.files.check(Schema.isMaxLength(0))
	})),
	changes: Schema.Array(BoundedChange).check(Schema.isMaxLength(100))
}));
export const WorkspaceChangesResult = Schema.Union([
	NotReady,
	Failure,
	Schema.Struct({
		status: Schema.Literal("ready"),
		document: Changes,
		remaining: Count
	})
]);
export type WorkspaceChangesResult = typeof WorkspaceChangesResult.Type;
const Range = Schema.Struct({ start: Count, end: Count });
export const WorkspaceLocalizationFindingFocus = Schema.Struct({
	kind: Schema.Literal("localization"),
	id: TextQualityFindingId,
	source: Excerpt,
	translation: Schema.NullOr(Excerpt),
	translationOrigin: Schema.Literals(["po", "archive", "absent"]),
	sourceRanges: Schema.Array(Range).check(Schema.isMaxLength(64)),
	translationRanges: Schema.Array(Range).check(Schema.isMaxLength(64)),
	truncated: Schema.Boolean,
	problem: WorkspaceFinding.fields.problem,
	recovery: Schema.String,
	check: WorkspaceQualityFilter,
	/** The rule a review file records when someone accepts this finding. */
	ruleId: Schema.String,
	culture: CultureCode,
	textUnitId: Schema.optionalKey(TextUnitId),
	affectedOccurrences: Schema.Array(TextQualityAffectedOccurrence).check(Schema.isMaxLength(50)),
	totalOccurrences: Count,
	nextOccurrenceOffset: Offset,
	translations: LocalizationFocus,
	suggestedChange: Schema.optionalKey(BoundedChange)
});
export type WorkspaceLocalizationFindingFocus = typeof WorkspaceLocalizationFindingFocus.Type;
export const WorkspaceQualityFocusResult = Schema.Union([
	NotReady,
	Failure,
	Schema.Struct({ status: Schema.Literal("not_found") }),
	Schema.Struct({
		status: Schema.Literal("found"),
		focus: Schema.Union([
			Schema.Struct({ kind: Schema.Literal("source"), focus: TextQualityFocus }),
			WorkspaceLocalizationFindingFocus
		])
	})
]);
export type WorkspaceQualityFocusResult = typeof WorkspaceQualityFocusResult.Type;
type Finding = LocalizationQualityReport["findings"][number];
function filterOf(finding: Finding): WorkspaceQualityFilter {
	if (finding.kind === "localization_character_budget") return "character_budget";
	if (finding.kind === "localization_terminology") return "terminology";
	return finding.kind;
}
function problem(finding: Finding): string {
	switch (finding.kind) {
		case "format_arguments":
			return [
				finding.actual.missing.length
					? "Missing " + finding.actual.missing.map((name) => "{" + name + "}").join(", ")
					: "",
				finding.actual.added.length
					? "uses " + finding.actual.added.map((name) => "{" + name + "}").join(", ")
					: ""
			]
				.filter(Boolean)
				.join(" · ");
		case "argument_modifiers":
			return "Check plural, ordinal and gender forms";
		case "rich_text":
			return "Unbalanced rich text tag";
		case "po_escape_safety":
			return "Unsafe escape " + finding.actual.sequences.join(", ");
		case "whitespace":
			return finding.actual.trailing !== finding.expectation.trailing
				? "Trailing space"
				: finding.actual.leading !== finding.expectation.leading
					? "Leading space"
					: "Whitespace or line breaks differ";
		case "empty_translation":
			return "Empty translation";
		case "missing_translator_notes":
			return "No translator notes";
		case "duplicate_source":
			return "Same text, different keys";
		case "character_budget":
		case "localization_character_budget":
			return (
				"Maximum " +
				textCountLabel(finding.expectation.maximumCharacters, "character") +
				" · " +
				textCountLabel(finding.actual.characterCount, "character")
			);
		case "terminology":
		case "localization_terminology":
			return finding.expectation.kind === "forbidden_term"
				? "Remove “" + finding.actual.term + "”"
				: "Prefer “" +
						finding.expectation.preferredTerm +
						"” · uses “" +
						finding.actual.term +
						"”";
	}
}
function hash(value: string): string {
	let result = 0xcbf29ce484222325n;
	for (let index = 0; index < value.length; index++)
		result = BigInt.asUintN(64, (result ^ BigInt(value.charCodeAt(index))) * 0x100000001b3n);
	return result.toString(16);
}
function ranges(text: string, finding: Finding, side: "source" | "translation") {
	const matches: Array<{ start: number; end: number }> = [];
	const add = (start: number, end: number) => {
		if (matches.length < 64 && start < 4096 && end > start)
			matches.push({ start, end: Math.min(end, 4096) });
	};
	if (finding.kind === "format_arguments") {
		const names = side === "source" ? finding.actual.missing : finding.actual.added;
		for (const name of names) {
			const term = "{" + name + "}";
			let start = text.indexOf(term);
			while (start >= 0 && matches.length < 64) {
				add(start, start + term.length);
				start = text.indexOf(term, start + term.length);
			}
		}
	} else if (finding.kind === "localization_terminology" && side === "translation")
		add(finding.actual.start, finding.actual.end);
	else if (
		finding.kind === "rich_text" ||
		finding.kind === "argument_modifiers" ||
		finding.kind === "po_escape_safety" ||
		finding.kind === "whitespace"
	) {
		const pattern =
			finding.kind === "rich_text"
				? /<[^>]*>/gu
				: finding.kind === "argument_modifiers"
					? /\|(?:plural|ordinal|gender)\([^)]*\)/gu
					: finding.kind === "po_escape_safety"
						? /\\[nrt]/gu
						: /^\s+|\s+$|[\r\n]+/gu;
		for (const match of text.matchAll(pattern)) add(match.index, match.index + match[0].length);
	}
	return matches.sort((a, b) => a.start - b.start);
}

/** A retained index; every page, type count and proposal uses the same culture/filter selection. */
export function localizationQualityWorkspace(
	source: TextQualityReport | undefined,
	report: LocalizationQualityReport,
	join: LocalizationJoin
) {
	const sourceQuery = source ? textQualityQuery(source) : undefined;
	const sourceFindings = source?.findings ?? [];
	const lines = new Map(join.lines.map((line) => [line.id, line]));
	const units = new Map(
		join.lines.flatMap((line) =>
			line.origin.kind === "corpus"
				? line.origin.unitIds.map((id) => [id, line] as const)
				: []
		)
	);
	const indexed = [...sourceFindings, ...report.findings].map((finding) => {
		const localized = "culture" in finding;
		const line = localized ? lines.get(finding.lineId) : units.get(finding.textUnitId);
		const id = localized
			? TextQualityFindingId.make("localization-finding:" + hash(JSON.stringify(finding)))
			: textQualityFindingId(finding);
		const location = finding.affectedOccurrences[0]?.location;
		const context =
			(location
				? textAssetName(location.objectPath)
				: (line?.manifest[0]?.path ?? "Source file")) +
			" · " +
			(localized
				? finding.identity.key
				: (line?.identity?.key ??
					(location?.kind === "string_table_entry"
						? location.entryKey
						: finding.ruleId))) +
			" · " +
			workspaceQualityLabels[filterOf(finding)] +
			" · " +
			textCountLabel(finding.affectedOccurrences.length, "location");
		const summary: WorkspaceFinding = {
			id,
			filter: filterOf(finding),
			source: (localized
				? (line?.manifest[0]?.source.Text ?? line?.source ?? "")
				: finding.actual.source
			).slice(0, 512),
			problem: ((localized ? finding.culture + " · " : "") + problem(finding)).slice(0, 1024),
			context: context.slice(0, 1024),
			...(localized ? { culture: finding.culture } : undefined)
		};
		return { finding, line, summary };
	});
	const matched = (request: WorkspaceQualityRequest) =>
		indexed.filter(
			({ summary }) =>
				(!request.culture || !summary.culture || summary.culture === request.culture) &&
				(request.filter === "all" || request.filter === summary.filter)
		);
	const eligible = (finding: Finding) =>
		"suggestedChange" in finding &&
		finding.suggestedChange &&
		Schema.is(BoundedChange)(finding.suggestedChange)
			? finding.suggestedChange
			: undefined;
	return {
		search(request: WorkspaceQualityRequest): WorkspaceQualityPage {
			const culture = indexed.filter(
				({ summary }) =>
					!request.culture || !summary.culture || summary.culture === request.culture
			);
			const typeCounts = new Map<WorkspaceQualityFilter, number>();
			const ruleCounts = new Map<Finding["ruleId"], number>();
			for (const { summary, finding } of culture) {
				typeCounts.set(summary.filter, (typeCounts.get(summary.filter) ?? 0) + 1);
				ruleCounts.set(finding.ruleId, (ruleCounts.get(finding.ruleId) ?? 0) + 1);
			}
			const counts = Schema.decodeUnknownSync(WorkspaceQualityPage.fields.counts)(
				Object.fromEntries(
					WorkspaceQualityFilter.literals.map((filter) => [
						filter,
						filter === "all" ? culture.length : (typeCounts.get(filter) ?? 0)
					])
				)
			);
			const limits = new Map<LocalizationCheckDiagnostic["code"], number>();
			for (const diagnostic of report.checkDiagnostics) {
				if (!request.culture || diagnostic.culture === request.culture)
					limits.set(diagnostic.code, (limits.get(diagnostic.code) ?? 0) + 1);
			}
			const findings = matched(request),
				offset = request.offset ?? 0;
			return {
				counts,
				limits: [...limits].map(([code, count]) => ({ code, count })),
				unsupportedRuleCultures: report.ruleDiagnostics?.length ?? 0,
				total: findings.length,
				findings: findings.slice(offset, offset + 50).map((item) => item.summary),
				suggestedFixCount: findings.filter(({ finding }) => eligible(finding)).length,
				rules: [...(source?.rules ?? []), ...report.rules].map((rule) => ({
					ruleId: rule.ruleId,
					findingCount: ruleCounts.get(rule.ruleId) ?? 0
				})),
				...(offset + 50 < findings.length ? { nextOffset: offset + 50 } : undefined)
			};
		},
		focus(request: WorkspaceQualityFocusRequest): WorkspaceQualityFocusResult {
			const item = indexed.find(
				({ summary }) =>
					summary.id === request.id &&
					(!request.culture || !summary.culture || summary.culture === request.culture)
			);
			if (!item) return { status: "not_found" };
			const { finding, line, summary } = item;
			if (!("culture" in finding)) {
				const offset = request.occurrenceOffset ?? 0;
				const previous = offset ? finding.affectedOccurrences[offset - 1]?.id : undefined;
				const focus = sourceQuery?.focus({
					id: summary.id,
					pageSize: 50,
					...(previous ? { occurrenceCursor: previous } : undefined)
				});
				return focus
					? { status: "found", focus: { kind: "source", focus } }
					: { status: "not_found" };
			}
			if (!line) return { status: "not_found" };
			const mark = line.cultures.find((mark) => mark.culture === finding.culture);
			const sourceText = line.manifest[0]?.source.Text ?? line.source;
			const translation = mark ? localizationShippedTranslation(mark).value : null;
			const detail = localizationFocusPage(
				join,
				{
					...line,
					cultures: line.cultures.filter((mark) => mark.culture === finding.culture)
				},
				{
					target: request.target,
					selection: { kind: "line", id: line.id },
					locationOffset: request.occurrenceOffset ?? 0,
					poContextOffset: request.poContextOffset ?? 0
				}
			);
			const change = eligible(finding);
			return {
				status: "found",
				focus: {
					kind: "localization",
					id: summary.id,
					source: sourceText.slice(0, 4096),
					translation: translation?.slice(0, 4096) ?? null,
					translationOrigin: finding.translationOrigin,
					sourceRanges: ranges(sourceText, finding, "source"),
					translationRanges: ranges(translation ?? "", finding, "translation"),
					truncated: sourceText.length > 4096 || (translation?.length ?? 0) > 4096,
					problem: summary.problem,
					recovery: finding.recovery,
					check: summary.filter,
					ruleId: finding.ruleId,
					culture: finding.culture,
					affectedOccurrences: finding.affectedOccurrences.slice(
						request.occurrenceOffset ?? 0,
						(request.occurrenceOffset ?? 0) + 50
					),
					totalOccurrences: finding.affectedOccurrences.length,
					...((request.occurrenceOffset ?? 0) + 50 < finding.affectedOccurrences.length
						? { nextOccurrenceOffset: (request.occurrenceOffset ?? 0) + 50 }
						: undefined),
					translations: detail,
					...(line.origin.kind === "corpus" && line.origin.unitIds[0]
						? { textUnitId: line.origin.unitIds[0] }
						: undefined),
					...(change ? { suggestedChange: change } : undefined)
				}
			};
		},
		changes(request: WorkspaceQualityRequest): WorkspaceChangesResult {
			const changes: LocalizationChange[] = [];
			const seen = new Set<string>();
			let remaining = 0,
				bytes = 0;
			for (const { finding } of matched(request)) {
				const change = eligible(finding);
				if (!change) continue;
				const key = JSON.stringify([
					change.target,
					change.culture,
					change.namespace,
					change.key
				]);
				if (seen.has(key)) continue;
				seen.add(key);
				const size = new TextEncoder().encode(JSON.stringify(change)).length;
				if (changes.length === 100 || bytes + size > 1_000_000) {
					remaining++;
					continue;
				}
				changes.push(change);
				bytes += size;
			}
			// File authority stays in the host. A proposal records complete change identities, without filesystem paths.
			return {
				status: "ready",
				document: {
					schemaVersion: 1,
					provenance: { producer: "ue-shed.localization.checks", files: [] },
					changes
				},
				remaining
			};
		}
	};
}

export const WorkspaceReportRequest = Schema.Struct({
	target: LocalizationTargetName,
	offset: Offset
});
export type WorkspaceReportRequest = typeof WorkspaceReportRequest.Type;
const Words = Schema.NullOr(Count);
export const WorkspaceReportRow = Schema.Struct({
	culture: CultureCode,
	translatedLines: Words,
	totalLines: Count,
	linesPercent: Schema.NullOr(Schema.Number),
	wordsPercent: Schema.NullOr(Schema.Number),
	wordsNeedingWork: Words,
	notSynced: Count,
	/** Present once the project has a review file for the target. */
	reviewedLines: Schema.optionalKey(Count),
	proofreadLines: Schema.optionalKey(Count),
	newWords: Schema.optionalKey(Words),
	changedWords: Schema.optionalKey(Words)
});
export type WorkspaceReportRow = typeof WorkspaceReportRow.Type;
export const WorkspaceReportPage = Schema.Struct({
	target: LocalizationTargetName,
	rows: Schema.Array(WorkspaceReportRow).check(Schema.isMaxLength(50)),
	totalCultures: Count,
	nextOffset: Offset,
	coverage: TextCorpus.fields.coverage,
	gatherFilesRead: Count,
	gatherFilesFailed: Count,
	wordCountUnknown: Count,
	unknownReasons: LocalizationProgressCulture.fields.unknownReasons,
	baseline: Schema.optionalKey(
		Schema.Struct({ target: LocalizationTargetName, createdAt: Schema.String })
	)
});
export type WorkspaceReportPage = typeof WorkspaceReportPage.Type;
export const WorkspaceReportResult = Schema.Union([
	NotReady,
	Failure,
	Schema.Struct({ status: Schema.Literal("ready"), page: WorkspaceReportPage })
]);
export type WorkspaceReportResult = typeof WorkspaceReportResult.Type;
export const WorkspaceReportFileRequest = Schema.Struct({
	target: LocalizationTargetName,
	operation: Schema.Literals(["save_baseline", "compare_baseline", "export_csv"])
});
export type WorkspaceReportFileRequest = typeof WorkspaceReportFileRequest.Type;
export const WorkspaceReportFileResult = Schema.Union([
	NotReady,
	Failure,
	Schema.Struct({ status: Schema.Literal("cancelled") }),
	Schema.Struct({ status: Schema.Literal("saved"), message: Schema.String }),
	Schema.Struct({ status: Schema.Literal("compared"), page: WorkspaceReportPage })
]);
export type WorkspaceReportFileResult = typeof WorkspaceReportFileResult.Type;
export function localizationReportPage(
	report: LocalizationProgressReport,
	native: string | null,
	request: WorkspaceReportRequest,
	baseline?: LocalizationBaseline
): WorkspaceReportPage {
	const cultures = [...report.cultures].sort(
		(a, b) => Number(b.culture === native) - Number(a.culture === native)
	);
	const offset = request.offset ?? 0;
	const reasons = Schema.decodeUnknownSync(WorkspaceReportPage.fields.unknownReasons)(
		Object.fromEntries(
			LocalizationUnknownReason.literals.map((reason) => [
				reason,
				cultures.reduce((sum, culture) => sum + culture.unknownReasons[reason], 0)
			])
		)
	);
	return {
		target: report.target,
		rows: cultures.slice(offset, offset + 50).map((culture) => ({
			culture: culture.culture,
			translatedLines: culture.upToDateArchive.lines,
			totalLines: culture.total.lines,
			linesPercent: culture.translatedPercent.lines,
			wordsPercent: culture.translatedPercent.words,
			wordsNeedingWork:
				culture.total.sourceWords !== null && culture.upToDateArchive.sourceWords !== null
					? Math.max(0, culture.total.sourceWords - culture.upToDateArchive.sourceWords)
					: null,
			notSynced: culture.notSynced.lines,
			...(culture.reviewed === "not_tracked" || culture.proofread === "not_tracked"
				? undefined
				: {
						reviewedLines: culture.reviewed.lines,
						proofreadLines: culture.proofread.lines
					}),
			...(culture.baselineDelta
				? {
						newWords: culture.baselineDelta.addedCounts.sourceWords,
						changedWords: culture.baselineDelta.changedCounts.sourceWords
					}
				: undefined)
		})),
		totalCultures: cultures.length,
		coverage: report.coverage,
		gatherFilesRead: report.gatherEvidence.filter((file) => file.status === "read").length,
		gatherFilesFailed: report.gatherEvidence.filter((file) => file.status === "failed").length,
		wordCountUnknown: report.wordCountDiagnostics.length,
		unknownReasons: reasons,
		...(offset + 50 < cultures.length ? { nextOffset: offset + 50 } : undefined),
		...(baseline
			? { baseline: { target: baseline.target, createdAt: baseline.provenance.createdAt } }
			: undefined)
	};
}
export function localizationReportCsv(
	pages: readonly WorkspaceReportRow[],
	baseline = false
): string {
	const headers = [
		"Culture",
		"Lines translated",
		"Total lines",
		"% translated by lines",
		"% translated by words",
		"Words needing work",
		"Not synced"
	];
	const reviewed = pages.some((row) => row.reviewedLines !== undefined);
	if (reviewed) headers.push("Lines reviewed", "Lines proofread");
	if (baseline) headers.push("New words", "Changed words");
	return spreadsheetCsv([
		headers,
		...pages.map((row) => {
			const cells: Array<string | number> = [
				row.culture,
				row.translatedLines ?? "Unknown",
				row.totalLines,
				row.linesPercent ?? "Unknown",
				row.wordsPercent ?? "Unknown",
				row.wordsNeedingWork ?? "Unknown",
				row.notSynced
			];
			if (reviewed) cells.push(row.reviewedLines ?? 0, row.proofreadLines ?? 0);
			if (baseline) cells.push(row.newWords ?? "Unknown", row.changedWords ?? "Unknown");
			return cells;
		})
	]);
}
