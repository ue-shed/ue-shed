import { Effect, Schema } from "effect";
import {
	hydrateQualityRead,
	materializeQualityRead,
	type QualityRead
} from "./quality-hydration.js";
import {
	CultureCode,
	LocalizationTargetName,
	LocalizationChange,
	LocalizationChangeSet
} from "@ue-shed/localization/browser";
import { TextCorpus, TextLocation, TextUnitId } from "./schema.js";
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
import {
	LocalizationUnknownReason,
	type LocalizationJoin,
	type LocalizationLine
} from "./localization-schema.js";
import { localizationShippedTranslation } from "./localization-shipped-translation.js";
import {
	LocalizationProgressCulture,
	type LocalizationProgressReport,
	type LocalizationBaseline
} from "./localization-reports.js";
import {
	LocalizationFileProblem,
	localizationEvidenceFolder,
	localizationFileProblems
} from "./localization-status.js";
import { textCountLabel } from "./csv.js";
import { textAssetName, spreadsheetCsv } from "./csv.js";
import { CheckSeverity } from "./localization-check-ids.js";
import { localizationCheckCatalogue, projectRuleKinds } from "./localization-check-catalogue.js";

const Count = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0));
const Offset = Schema.optionalKey(Count);
const Excerpt = Schema.String.check(Schema.isMaxLength(4096));
/** The built-in filters: every finding, the project rule kinds and each built-in check. */
export const BuiltInQualityFilter = Schema.Literals([
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
	"duplicate_source",
	"format_argument_renamed",
	"rich_text_tags",
	"rich_text_tag_case",
	"line_breaks",
	"segment_separator",
	"length_outlier",
	"outdated_translation",
	"inconsistent_translation",
	"culture_invariant_text",
	"placeholder_text",
	"source_whitespace",
	"source_markup",
	"number_only_text",
	"string_table_key_collision",
	"rich_text_tags_added",
	"source_line_endings_changed",
	"placeholder_translation",
	"shared",
	"long"
]);
export type BuiltInQualityFilter = typeof BuiltInQualityFilter.Type;
/** A custom check's filter: `custom.` and the check's rule ID. */
export const CustomQualityFilter = Schema.TemplateLiteral(["custom.", Schema.String]);
export type CustomQualityFilter = typeof CustomQualityFilter.Type;
/** A built-in filter, or a custom check's: the filter list is the rule file's, not fixed. */
export const WorkspaceQualityFilter = Schema.Union([BuiltInQualityFilter, CustomQualityFilter]);
export type WorkspaceQualityFilter = typeof WorkspaceQualityFilter.Type;
const isBuiltInFilter = Schema.is(BuiltInQualityFilter);
/** The filter of a custom check's findings. */
export function customQualityFilter(ruleId: string): CustomQualityFilter {
	return `custom.${ruleId}`;
}
/**
 * A filter's name in lists: the check's catalogue label, the project rule kind's, or a custom
 * check's label from `customLabels` (by filter), falling back to its rule ID.
 */
export function workspaceQualityLabel(
	filter: WorkspaceQualityFilter,
	customLabels?: ReadonlyMap<string, string>
): string {
	if (!isBuiltInFilter(filter))
		return customLabels?.get(filter) ?? filter.slice("custom.".length);
	if (filter === "all") return "All findings";
	if (filter === "character_budget" || filter === "terminology")
		return projectRuleKinds[filter].label;
	return localizationCheckCatalogue[filter].label;
}
/** A check's default severity, from the catalogue; every finding of a check shares it. */
export function workspaceQualitySeverity(
	filter: Exclude<WorkspaceQualityFilter, "all">
): CheckSeverity {
	if (!isBuiltInFilter(filter)) return "normal";
	if (filter === "character_budget" || filter === "terminology")
		return projectRuleKinds[filter].severity;
	return localizationCheckCatalogue[filter].severity;
}
const Selection = { target: LocalizationTargetName, culture: Schema.optionalKey(CultureCode) };
/**
 * Target/culture quality-list request with a filter and offset. The workspace retains complete
 * findings while each host page stays bounded.
 */
export const WorkspaceQualityRequest = Schema.Struct({
	...Selection,
	filter: WorkspaceQualityFilter,
	offset: Offset
});
export type WorkspaceQualityRequest = typeof WorkspaceQualityRequest.Type;
/**
 * Finding focus request with separate occurrence and PO-context offsets. Offsets belong to the
 * retained target/culture quality generation.
 */
export const WorkspaceQualityFocusRequest = Schema.Struct({
	...Selection,
	id: TextQualityFindingId,
	occurrenceOffset: Offset,
	poContextOffset: Offset
});
export type WorkspaceQualityFocusRequest = typeof WorkspaceQualityFocusRequest.Type;
const SourceVariants = Schema.Array(Schema.String.check(Schema.isMaxLength(512))).check(
	Schema.isMinLength(2),
	Schema.isMaxLength(16)
);
/**
 * Bounded host finding preview with policy severity, source/problem/context and optional first
 * saved location. Full structured evidence remains available through focus/report operations.
 */
export const WorkspaceFinding = Schema.Struct({
	id: TextQualityFindingId,
	filter: WorkspaceQualityFilter,
	severity: CheckSeverity,
	source: Schema.String.check(Schema.isMaxLength(512)),
	/** A key's conflicting saved texts, listed apart; `source` is the gathered one or the first. */
	sourceVariants: Schema.optionalKey(SourceVariants),
	problem: Schema.String.check(Schema.isMaxLength(1024)),
	context: Schema.String.check(Schema.isMaxLength(1024)),
	culture: Schema.optionalKey(CultureCode),
	/** The first place the finding affects, so hosts can name it the way they name a line's places. */
	location: Schema.optionalKey(TextLocation),
	/** How many places the finding affects. */
	locations: Schema.optionalKey(Count)
});
export type WorkspaceFinding = typeof WorkspaceFinding.Type;
/**
 * Bounded quality findings plus exact filter/severity totals, custom filter labels and
 * check-limit counts. Unsupported evidence remains separate from a clean check result.
 */
export const WorkspaceQualityPage = Schema.Struct({
	findings: Schema.Array(WorkspaceFinding).check(Schema.isMaxLength(50)),
	total: Count,
	counts: Schema.Record(WorkspaceQualityFilter, Count),
	/** The rule file's custom checks: their filters and labels, in the file's order. */
	customFilters: Schema.Array(
		Schema.Struct({ filter: CustomQualityFilter, label: Schema.String })
	).check(Schema.isMaxLength(512)),
	/** Findings by severity in the culture selection, as `counts.all` counts them. */
	severityCounts: Schema.Record(CheckSeverity, Count),
	nextOffset: Offset,
	suggestedFixCount: Count,
	limits: Schema.Array(
		Schema.Struct({ code: LocalizationCheckDiagnostic.fields.code, count: Count })
	).check(Schema.isMaxLength(32)),
	unsupportedRuleCultures: Count,
	rules: Schema.Array(TextQualityRuleSummary).check(Schema.isMaxLength(1032))
});
export type WorkspaceQualityPage = typeof WorkspaceQualityPage.Type;
/** File reports keep every matching finding; renderer pages remain bounded. */
export const WorkspaceQualityReport = WorkspaceQualityPage.mapFields(
	({ nextOffset: _offset, ...fields }) => ({
		...fields,
		findings: Schema.Array(WorkspaceFinding),
		corpusCoverage: TextCorpus.fields.coverage,
		status: TextCorpus.fields.status,
		target: WorkspaceQualityRequest.fields.target,
		culture: WorkspaceQualityRequest.fields.culture,
		filter: WorkspaceQualityRequest.fields.filter
	})
);
export type WorkspaceQualityReport = typeof WorkspaceQualityReport.Type;

const Failure = Schema.Struct({
	status: Schema.Literal("failed"),
	message: Schema.String,
	recovery: Schema.String
});
const NotReady = Schema.Struct({ status: Schema.Literal("not_ready") });
/**
 * Quality page outcome separating ready data, unavailable state and recoverable host failure.
 * An unavailable page is not an empty successful audit.
 */
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
/**
 * Bounded proposed localization change document with remaining-change count. Ready means the
 * proposal is available; it does not mean any file has been written.
 */
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
/**
 * Focused localization finding with bounded source/translation ranges, occurrences and PO
 * context. Suggested changes remain proposals requiring the localization write workflow.
 */
export const WorkspaceLocalizationFindingFocus = Schema.Struct({
	kind: Schema.Literal("localization"),
	id: TextQualityFindingId,
	source: Excerpt,
	translation: Schema.NullOr(Excerpt),
	translationOrigin: Schema.Literals(["po", "archive", "absent"]),
	sourceRanges: Schema.Array(Range).check(Schema.isMaxLength(64)),
	translationRanges: Schema.Array(Range).check(Schema.isMaxLength(64)),
	truncated: Schema.Boolean,
	sourceVariants: Schema.optionalKey(SourceVariants),
	problem: WorkspaceFinding.fields.problem,
	recovery: Schema.String,
	check: WorkspaceQualityFilter,
	severity: CheckSeverity,
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
/**
 * Quality focus outcome for source or localization findings, including explicit not-found,
 * unavailable and failed states. Branch on kind before reading domain-specific evidence.
 */
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
interface SeverityBuckets<A> {
	blocking: A[];
	normal: A[];
	low: A[];
}
type SourceFinding = TextQualityReport["findings"][number];
type RuleId = (typeof TextQualityRuleSummary.Type)["ruleId"];
/** A shown finding: the finding, its line when known, and the summary the list displays. */
export interface WorkspaceQualityItem {
	readonly finding: Finding | SourceFinding;
	readonly line: LocalizationLine | undefined;
	readonly summary: WorkspaceFinding;
}
/**
 * Maps structured finding kind to its workspace filter key, including project rules and custom
 * checks. Policy severity does not affect the filter identity.
 */
export function workspaceQualityFilterOf(
	finding: Finding | SourceFinding
): Exclude<WorkspaceQualityFilter, "all"> {
	if (finding.kind === "localization_character_budget") return "character_budget";
	if (finding.kind === "localization_terminology") return "terminology";
	if (finding.kind === "custom") return customQualityFilter(finding.ruleId);
	return finding.kind;
}
const braced = (names: readonly string[]) => names.map((name) => "{" + name + "}").join(", ");
const tagged = (names: readonly string[]) => names.map((name) => "<" + name + ">").join(", ");
const quoted = (text: string) => "“" + (text.length > 40 ? text.slice(0, 39) + "…" : text) + "”";
function problem(finding: Finding): string {
	switch (finding.kind) {
		case "format_arguments":
			return [
				finding.actual.missing.length ? "Missing " + braced(finding.actual.missing) : "",
				finding.actual.added.length ? "uses " + braced(finding.actual.added) : ""
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
			return (
				"Same text, different keys · " + textCountLabel(finding.actual.identityCount, "key")
			);
		case "format_argument_renamed":
			return finding.actual.renamed
				.map(({ from, to }) => "{" + from + "} should be {" + to + "}")
				.join(" · ");
		case "rich_text_tags":
			return [
				finding.actual.missing.length ? "Missing " + tagged(finding.actual.missing) : "",
				finding.actual.added.length ? "adds " + tagged(finding.actual.added) : ""
			]
				.filter(Boolean)
				.join(" · ");
		case "rich_text_tags_added":
			return "Adds " + tagged(finding.actual.added);
		case "rich_text_tag_case":
			return finding.actual.changed
				.map(
					({ source, translation }) => "<" + translation + "> should be <" + source + ">"
				)
				.join(" · ");
		case "line_breaks":
			return (
				textCountLabel(finding.actual.lineBreaks, "line break") +
				", source has " +
				finding.expectation.lineBreaks
			);
		case "segment_separator":
			return (
				quoted(finding.actual.separator) +
				" " +
				finding.actual.count +
				"×, source has " +
				finding.expectation.count +
				"×"
			);
		case "length_outlier":
			return (
				(finding.actual.ratio < 1 ? "Much shorter" : "Much longer") +
				" than the source · " +
				finding.actual.ratio +
				"×"
			);
		case "outdated_translation":
			return "Translated from " + quoted(finding.actual.translatedSource);
		case "source_line_endings_changed":
			return "Source line endings changed since it was translated";
		case "placeholder_translation":
			return "Placeholder translation " + quoted(finding.actual.translation);
		case "inconsistent_translation":
			return finding.actual.untranslated &&
				finding.actual.variants[0]?.translation !== finding.actual.translation
				? "Not translated · " +
						textCountLabel(finding.actual.variants[0]?.lines ?? 0, "line") +
						" use " +
						quoted(finding.actual.variants[0]?.translation ?? "")
				: finding.actual.untranslated
					? "Not translated, while " +
						textCountLabel(
							finding.actual.variants
								.slice(1)
								.reduce((sum, variant) => sum + variant.lines, 0),
							"line"
						) +
						" translate it"
					: "Translated inconsistently · " +
						textCountLabel(finding.actual.variantCount, "translation") +
						", most use " +
						quoted(finding.actual.variants[0]?.translation ?? "");
		case "culture_invariant_text":
			return "Won’t be translated: culture invariant";
		case "placeholder_text":
			return "Placeholder " + finding.actual.matches.map(quoted).join(", ");
		case "source_whitespace":
			return finding.actual.leading || finding.actual.trailing
				? "Space or line break at the start or end"
				: "Doubled spaces";
		case "source_markup":
			return finding.actual.xmlClosings?.length
				? "Closes with " +
						finding.actual.xmlClosings.map((name) => "</" + name + ">").join(", ") +
						"; rich text closes with </>"
				: finding.actual.richText.opening !== finding.actual.richText.closing
					? "Unbalanced rich-text tags"
					: "Unbalanced { }";
		case "number_only_text":
			return "Number-only text sent for translation";
		case "string_table_key_collision":
			return (
				"Key in " +
				textCountLabel(finding.actual.tableCount, "String Table") +
				" with one namespace"
			);
		case "shared":
			return "Used in " + textCountLabel(finding.actual.occurrences, "place");
		case "long":
			return "Long text · " + textCountLabel(finding.actual.length, "character");
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
		case "custom":
			return finding.label + " · " + customProblem(finding);
	}
}
function customProblem(finding: Extract<Finding, { kind: "custom" }>): string {
	const { actual, expectation } = finding;
	if (finding.check === "length")
		return (
			textCountLabel(actual.length ?? 0, "character") +
			(expectation.minimum !== undefined ? " · minimum " + expectation.minimum : "") +
			(expectation.maximum !== undefined ? " · maximum " + expectation.maximum : "")
		);
	const matches = actual.matches ?? [];
	if (finding.check === "forbidden_term")
		return "Uses " + matches.map((match) => quoted(match.match)).join(", ");
	return expectation.report === "no_match"
		? "Does not match the pattern"
		: "Matches " + matches.map((match) => quoted(match.match)).join(", ");
}
/** What tells localization findings apart. */
interface HashedLocalizationFinding {
	readonly lineId: string;
	readonly culture: string;
	readonly ruleId: string;
	readonly kind: string;
	readonly actual: object;
	readonly expectation: object;
}
/**
 * JSON with object keys sorted at every level: listed properties serialize in list order, so equal
 * values hash equally whether a schema or a check built them.
 */
function canonicalJson(finding: HashedLocalizationFinding): string {
	const values = [
		finding.lineId,
		finding.culture,
		finding.ruleId,
		finding.kind,
		finding.actual,
		finding.expectation
	];
	const keys = new Set<string>();
	JSON.stringify(values, (key, item) => {
		keys.add(key);
		return item;
	});
	return JSON.stringify(values, [...keys].sort());
}
/**
 * Two 32-bit lanes of a fast string hash over the finding's line, culture, rule, check and
 * observed and expected values. IDs stay stable while that text is unchanged.
 */
export function localizationFindingHash(
	finding: HashedLocalizationFinding
): readonly [number, number] {
	const text = canonicalJson(finding);
	let first = 0x811c9dc5,
		second = 0x9e3779b9;
	for (let index = 0; index < text.length; index++) {
		const code = text.charCodeAt(index);
		first = Math.imul(first ^ code, 0x01000193);
		second = Math.imul(second ^ code, 0x5bd1e995);
		second ^= second >>> 15;
	}
	return [first >>> 0, second >>> 0];
}
/**
 * Derives a localization finding identity from stable evidence fields. Severity/display labels
 * are not identity, so adjusting policy presentation does not erase accepted-review matching.
 */
export function localizationFindingId([first, second]: readonly [number, number]) {
	return TextQualityFindingId.make(
		"localization-finding:" +
			first.toString(16).padStart(8, "0") +
			second.toString(16).padStart(8, "0")
	);
}
/** The finding's suggested change when it fits a proposal; otherwise undefined. */
export function eligibleLocalizationChange(finding: Finding | SourceFinding) {
	return "suggestedChange" in finding &&
		finding.suggestedChange &&
		Schema.is(BoundedChange)(finding.suggestedChange)
		? finding.suggestedChange
		: undefined;
}
/**
 * The source text a localization finding is about: the checked text for source checks, else the
 * gathered source, else the first of conflicting texts, never the join's joined text.
 */
function findingSource(finding: Finding, line: LocalizationLine | undefined): string {
	switch (finding.kind) {
		case "duplicate_source":
		case "culture_invariant_text":
		case "placeholder_text":
		case "source_whitespace":
		case "source_markup":
		case "number_only_text":
			return finding.actual.source;
	}
	const variants = "sourceVariants" in finding ? finding.sourceVariants : undefined;
	return line?.manifest[0]?.source.Text ?? variants?.[0] ?? line?.source ?? "";
}
/**
 * Builds a bounded workspace finding preview from structured evidence and an optional joined
 * line. Keeps the original finding/line available alongside presentation text.
 */
export function workspaceQualityItem(
	finding: Finding | SourceFinding,
	line: LocalizationLine | undefined,
	sourceKey?: string
): WorkspaceQualityItem {
	const localized = "culture" in finding;
	const id = localized
		? localizationFindingId(localizationFindingHash(finding))
		: textQualityFindingId(finding);
	const location = finding.affectedOccurrences[0]?.location;
	const context =
		(location
			? textAssetName(location.objectPath)
			: (line?.manifest[0]?.path ?? "Source file")) +
		" · " +
		(localized
			? (finding.identity?.key ?? "No key")
			: (sourceKey ??
				line?.identity?.key ??
				(location?.kind === "string_table_entry" ? location.entryKey : finding.ruleId))) +
		" · " +
		(finding.kind === "custom"
			? finding.label
			: workspaceQualityLabel(workspaceQualityFilterOf(finding))) +
		" · " +
		textCountLabel(finding.affectedOccurrences.length, "location");
	const filter = workspaceQualityFilterOf(finding);
	const variants = "sourceVariants" in finding ? finding.sourceVariants : undefined;
	const summary: WorkspaceFinding = {
		id,
		filter,
		severity: localized ? finding.severity : workspaceQualitySeverity(filter),
		source: (localized ? findingSource(finding, line) : finding.actual.source).slice(0, 512),
		...(variants
			? { sourceVariants: variants.slice(0, 16).map((variant) => variant.slice(0, 512)) }
			: undefined),
		problem: ((localized ? finding.culture + " · " : "") + problem(finding)).slice(0, 1024),
		context: context.slice(0, 1024),
		...(localized ? { culture: finding.culture } : undefined),
		...(location ? { location } : undefined),
		locations: finding.affectedOccurrences.length
	};
	return { finding, line, summary };
}
function ranges(text: string, finding: Finding, side: "source" | "translation") {
	const matches: Array<{ start: number; end: number }> = [];
	const add = (start: number, end: number) => {
		if (matches.length < 64 && start < 4096 && end > start)
			matches.push({ start, end: Math.min(end, 4096) });
	};
	const terms = (values: readonly string[]) => {
		for (const term of values) {
			let start = text.indexOf(term);
			while (start >= 0 && matches.length < 64) {
				add(start, start + term.length);
				start = text.indexOf(term, start + term.length);
			}
		}
	};
	const pattern = (expression: RegExp) => {
		for (const match of text.matchAll(expression))
			add(match.index, match.index + match[0].length);
	};
	switch (finding.kind) {
		case "format_arguments":
			terms(
				(side === "source" ? finding.actual.missing : finding.actual.added).map(
					(name) => "{" + name + "}"
				)
			);
			break;
		case "format_argument_renamed":
			terms(
				finding.actual.renamed.map(
					({ from, to }) => "{" + (side === "source" ? to : from) + "}"
				)
			);
			break;
		case "localization_terminology":
			if (side === "translation") add(finding.actual.start, finding.actual.end);
			break;
		case "custom":
			if (side === finding.subject)
				for (const match of finding.actual.matches ?? []) add(match.start, match.end);
			break;
		case "rich_text":
		case "rich_text_tags":
		case "rich_text_tags_added":
		case "rich_text_tag_case":
			pattern(/<[^<>]*>/gu);
			break;
		case "argument_modifiers":
			pattern(/\|(?:plural|ordinal|gender)\([^)]*\)/gu);
			break;
		case "po_escape_safety":
			pattern(/\\[nrt]/gu);
			break;
		case "whitespace":
			pattern(/^\s+|\s+$/gu);
			break;
		case "line_breaks":
			pattern(/\r\n|\r|\n/gu);
			break;
		case "segment_separator":
			terms([finding.actual.separator]);
			break;
		case "placeholder_text":
			if (side === "source") terms(finding.actual.matches);
			break;
		case "source_whitespace":
			if (side === "source") pattern(/^\s+|\s+$| {2,}/gu);
			break;
		case "source_markup":
			if (side === "source") pattern(/<[^<>]*>|[{}]/gu);
			break;
	}
	return matches.sort((a, b) => a.start - b.start);
}

/** A compact group of positions sharing the scan facts used for workspace selection. */
export interface LocalizationFindingGroup {
	readonly culture: CultureCode;
	readonly filter: WorkspaceQualityFilter;
	/** The severity the scan stored for these findings. */
	readonly severity: CheckSeverity;
	readonly ruleId: RuleId;
	readonly eligible: boolean;
	readonly reportedBySource: boolean;
	/** Ascending positions in the finding list, sharing all the facts above. */
	readonly positions: Uint32Array;
}

/** Localization findings in report order. Facts are cheap; only `items` reads lines. */
export interface LocalizationFindingList {
	readonly length: number;
	/** Optional compact selection index, prepared cooperatively by indexed scans. */
	readonly groups?: readonly LocalizationFindingGroup[];
	culture(position: number): CultureCode;
	filter(position: number): WorkspaceQualityFilter;
	/** The severity the finding was reported with, as the rule file rated its check or rule. */
	severity(position: number): CheckSeverity;
	ruleId(position: number): RuleId;
	eligible(position: number): boolean;
	/**
	 * A `placeholder_text` finding whose placeholders the rule file's source terminology reports
	 * in full (`unreportedMatches` is empty), read from the scan's own facts.
	 */
	reportedBySource(position: number): boolean;
	/** The first position with this ID within the culture selection. */
	find(id: TextQualityFindingId, culture: CultureCode | undefined): number | undefined;
	items(
		positions: readonly number[]
	): Effect.Effect<readonly WorkspaceQualityItem[], import("./index-failure.js").IndexFailure>;
	/** Check diagnostic counts in first-seen order. */
	limits(
		culture: CultureCode | undefined
	): ReadonlyArray<{ code: LocalizationCheckDiagnostic["code"]; count: number }>;
}
/**
 * Retained localization quality report metadata used with lazily hydrated findings. Counts,
 * diagnostics and provenance survive without materializing every finding at once.
 */
export interface LocalizationQualityMetadata {
	readonly join: Pick<LocalizationJoin, "target" | "nativeCulture" | "cultures">;
	readonly rules: readonly RuleId[];
	/** The rule file's custom checks, with their labels, in the file's order. */
	readonly customChecks?: ReadonlyArray<{ readonly ruleId: RuleId; readonly label: string }>;
	readonly unsupportedRuleCultures: number;
	readonly status: TextCorpus["status"];
	readonly coverage: TextCorpus["coverage"];
	/** The line a source finding's unit belongs to, for its context. */
	readonly lineOfUnit: (id: TextUnitId) => LocalizationLine | undefined;
	/** Optional source-summary context without hydrating the unit's complete localization line. */
	readonly sourceKeyOfUnit?: (id: TextUnitId) => string | undefined;
}

/** Findings and metadata a quality workspace reads, however they are stored. */
export interface LocalizationQuality {
	readonly findings: LocalizationFindingList;
	readonly metadata: LocalizationQualityMetadata;
}

/** A retained index; every page, type count and proposal uses the same culture/filter selection. */
export function localizationQualityWorkspace(
	source: TextQualityReport | undefined,
	report: LocalizationQualityReport,
	join: LocalizationJoin
) {
	const quality = materializedLocalizationQuality(report, join);
	const reads = localizationQualityReads(source, quality);
	return {
		search: (request: WorkspaceQualityRequest) =>
			materializeQualityRead(reads.search(request), quality.findings.items),
		export: (request: WorkspaceQualityRequest) =>
			materializeQualityRead(reads.export(request), quality.findings.items),
		focus: (request: WorkspaceQualityFocusRequest) =>
			materializeQualityRead(reads.focus(request), quality.findings.items),
		changes: (request: WorkspaceQualityRequest) =>
			materializeQualityRead(reads.changes(request), quality.findings.items)
	};
}

/** The in-memory form: findings of a whole report, with the join their lines come from. */
function materializedLocalizationQuality(
	report: LocalizationQualityReport,
	join: LocalizationJoin
): Omit<LocalizationQuality, "findings"> & {
	findings: Omit<LocalizationFindingList, "items"> & {
		items: (positions: readonly number[]) => readonly WorkspaceQualityItem[];
	};
} {
	const lines = new Map(join.lines.map((line) => [line.id, line]));
	const units = new Map(
		join.lines.flatMap((line) =>
			line.origin.kind === "corpus"
				? line.origin.unitIds.map((id) => [id, line] as const)
				: []
		)
	);
	const itemAt = (position: number) => {
		const finding = report.findings[position]!;
		return workspaceQualityItem(
			finding,
			"culture" in finding ? lines.get(finding.lineId) : units.get(finding.textUnitId)
		);
	};
	return {
		findings: {
			length: report.findings.length,
			culture: (position) => {
				const finding = report.findings[position]!;
				return ("culture" in finding ? finding.culture : undefined)!;
			},
			filter: (position) => workspaceQualityFilterOf(report.findings[position]!),
			severity: (position) => {
				const finding = report.findings[position]!;
				return "culture" in finding
					? finding.severity
					: workspaceQualitySeverity(workspaceQualityFilterOf(finding));
			},
			ruleId: (position) => report.findings[position]!.ruleId,
			eligible: (position) =>
				eligibleLocalizationChange(report.findings[position]!) !== undefined,
			reportedBySource: (position) => {
				const finding = report.findings[position]!;
				return (
					"culture" in finding &&
					finding.kind === "placeholder_text" &&
					finding.unreportedMatches?.length === 0
				);
			},
			find: (id, culture) => {
				const position = report.findings.findIndex(
					(finding) =>
						(!culture || ("culture" in finding && finding.culture === culture)) &&
						("culture" in finding
							? localizationFindingId(localizationFindingHash(finding))
							: textQualityFindingId(finding)) === id
				);
				return position < 0 ? undefined : position;
			},
			items: (positions: readonly number[]) => positions.map(itemAt),
			limits: (culture) => {
				const limits = new Map<LocalizationCheckDiagnostic["code"], number>();
				for (const diagnostic of report.checkDiagnostics) {
					if (!culture || diagnostic.culture === culture)
						limits.set(diagnostic.code, (limits.get(diagnostic.code) ?? 0) + 1);
				}
				return [...limits].map(([code, count]) => ({ code, count }));
			}
		},
		metadata: {
			join,
			rules: report.rules.map((rule) => rule.ruleId),
			...(report.customChecks ? { customChecks: report.customChecks } : undefined),
			unsupportedRuleCultures: report.ruleDiagnostics?.length ?? 0,
			status: report.status,
			coverage: report.coverage,
			lineOfUnit: (id) => units.get(id)
		}
	};
}

/** An already materialized report with the same async interface as native findings. */
export function localizationQuality(
	report: LocalizationQualityReport,
	join: LocalizationJoin
): LocalizationQuality {
	const quality = materializedLocalizationQuality(report, join);
	return {
		...quality,
		findings: {
			...quality.findings,
			items: (positions) => Effect.succeed(quality.findings.items(positions))
		}
	};
}

/**
 * The summary a list showing the rule file's source findings gives an item: a `placeholder_text`
 * finding names only the placeholders the source terminology does not report. The finding and its
 * ID are unchanged.
 */
function withoutSourceReported(item: WorkspaceQualityItem): WorkspaceQualityItem {
	const { finding, line } = item;
	if (!("culture" in finding) || finding.kind !== "placeholder_text") return item;
	const left = finding.unreportedMatches;
	if (!left?.length || left.length === finding.actual.matches.length) return item;
	return {
		...item,
		summary: {
			...workspaceQualityItem(
				{ ...finding, actual: { ...finding.actual, matches: left } },
				line
			).summary,
			id: item.summary.id
		}
	};
}

/**
 * The workspace over any finding list. Pages and exports list blocking findings, then normal, then
 * low; within a severity, source findings come first, then localization findings in report order.
 */
function localizationQualityReads(
	source: TextQualityReport | undefined,
	{
		findings: list,
		metadata
	}: Omit<LocalizationQuality, "findings"> & {
		readonly findings: Omit<LocalizationFindingList, "items">;
	}
) {
	const sourceFindings = source?.findings ?? [];
	const customFilters = (metadata.customChecks ?? []).map(({ ruleId, label }) => ({
		filter: customQualityFilter(ruleId),
		label
	}));
	// The last page's source IDs also serve focus without hashing every preceding finding.
	const pageSources = new Map<TextQualityFindingId, SourceFinding>();
	const sourceItem = (finding: SourceFinding) => {
		// A source summary with an occurrence already has its asset context. Only the joined key
		// is missing; reading all translations and evidence for that key costs far more.
		const item =
			metadata.sourceKeyOfUnit && finding.affectedOccurrences[0]
				? workspaceQualityItem(
						finding,
						undefined,
						metadata.sourceKeyOfUnit(finding.textUnitId)
					)
				: workspaceQualityItem(finding, metadata.lineOfUnit(finding.textUnitId));
		pageSources.set(item.summary.id, finding);
		return item;
	};
	const sourceItemAt = (position: number) => sourceItem(sourceFindings[position]!);
	const sourceCount = sourceFindings.length,
		total = sourceCount + list.length;
	let sourceGroups:
		| Array<{ filter: SourceFinding["kind"]; ruleId: RuleId; positions: Uint32Array }>
		| undefined;
	const groupedSource = () => {
		if (sourceGroups) return sourceGroups;
		const byRule = new Map<RuleId, { character_budget?: number[]; terminology?: number[] }>();
		const groups: Array<{
			filter: SourceFinding["kind"];
			ruleId: RuleId;
			positions: number[];
		}> = [];
		for (let position = 0; position < sourceCount; position++) {
			const finding = sourceFindings[position]!;
			let rule = byRule.get(finding.ruleId);
			if (!rule) {
				rule = {};
				byRule.set(finding.ruleId, rule);
			}
			let positions = rule[finding.kind];
			if (!positions) {
				positions = [];
				rule[finding.kind] = positions;
				groups.push({ filter: finding.kind, ruleId: finding.ruleId, positions });
			}
			positions.push(position);
		}
		return (sourceGroups = groups.map((group) => ({
			...group,
			positions: Uint32Array.from(group.positions)
		})));
	};
	// One list shows source and localization findings: a placeholder is reported once. The checks
	// ran with the rule document the source report comes from, and recorded which placeholders
	// its terminology reports; nothing is hydrated here.
	const hidden = (position: number) => source !== undefined && list.reportedBySource(position);
	const withSummary = (item: WorkspaceQualityItem) =>
		source === undefined ? item : withoutSourceReported(item);
	const inCulture = (request: { culture?: CultureCode | undefined }, position: number) =>
		position < sourceCount ||
		(!hidden(position - sourceCount) &&
			(!request.culture || list.culture(position - sourceCount) === request.culture));
	const filterAt = (position: number) =>
		position < sourceCount
			? workspaceQualityFilterOf(sourceFindings[position]!)
			: list.filter(position - sourceCount);
	/** Source findings have their rule kind's severity; localization findings their stored one. */
	const severityAt = (position: number): CheckSeverity => {
		if (position >= sourceCount) return list.severity(position - sourceCount);
		const filter = filterAt(position);
		return filter === "all" ? "normal" : workspaceQualitySeverity(filter);
	};
	const ruleAt = (position: number) =>
		position < sourceCount
			? sourceFindings[position]!.ruleId
			: list.ruleId(position - sourceCount);
	const eligibleAt = (position: number) =>
		position < sourceCount
			? eligibleLocalizationChange(sourceFindings[position]!) !== undefined
			: list.eligible(position - sourceCount);
	const itemsAt = function* (
		positions: readonly number[]
	): QualityRead<WorkspaceQualityItem[], WorkspaceQualityItem> {
		pageSources.clear();
		const localized = yield positions
			.filter((position) => position >= sourceCount)
			.map((p) => p - sourceCount);
		let next = 0;
		return positions.map((position) =>
			position < sourceCount ? sourceItemAt(position) : withSummary(localized[next++]!)
		);
	};
	/** Summaries in batches, so a large export never holds every finding and line at once. */
	const summariesAt = function* (
		positions: readonly number[]
	): QualityRead<WorkspaceFinding[], WorkspaceQualityItem> {
		const summaries: WorkspaceFinding[] = [];
		for (let start = 0; start < positions.length; start += 2048)
			for (const item of yield* itemsAt(positions.slice(start, start + 2048)))
				summaries.push(item.summary);
		return summaries;
	};
	/** Matching positions, blocking findings first, then normal, then low; else in order. */
	const matched = (request: WorkspaceQualityRequest, wanted = (_position: number) => true) => {
		const bySeverity = new Map<CheckSeverity, number[]>(
			CheckSeverity.literals.map((severity) => [severity, []])
		);
		for (let position = 0; position < total; position++)
			if (
				inCulture(request, position) &&
				(request.filter === "all" || request.filter === filterAt(position)) &&
				wanted(position)
			)
				bySeverity.get(severityAt(position))!.push(position);
		return [...bySeverity.values()].flat();
	};
	// Keep just the current selection's numeric positions and counts. Moving through its pages
	// neither rechecks findings nor walks the full list again; changing selection replaces it.
	const select = (request: WorkspaceQualityRequest) => {
		const typeCounts = new Map<WorkspaceQualityFilter, number>();
		const ruleCounts = new Map<string, number>();
		const severityCounts = { blocking: 0, normal: 0, low: 0 };
		const matchedBySeverity: SeverityBuckets<number> = {
			blocking: [],
			normal: [],
			low: []
		};
		let cultureCount = 0,
			matchedCount = 0,
			suggestedFixCount = 0;
		const record = (
			filter: WorkspaceQualityFilter,
			severity: CheckSeverity,
			rule: RuleId,
			count: number,
			eligible: number
		) => {
			cultureCount += count;
			typeCounts.set(filter, (typeCounts.get(filter) ?? 0) + count);
			ruleCounts.set(rule, (ruleCounts.get(rule) ?? 0) + count);
			severityCounts[severity] += count;
			if (request.filter !== "all" && request.filter !== filter) return false;
			matchedCount += count;
			suggestedFixCount += eligible;
			return true;
		};
		for (let position = 0; position < (list.groups ? 0 : total); position++) {
			if (!inCulture(request, position)) continue;
			const filter = filterAt(position),
				rule = ruleAt(position),
				severity = severityAt(position);
			if (record(filter, severity, rule, 1, eligibleAt(position) ? 1 : 0))
				matchedBySeverity[severity].push(position);
		}
		const runs: SeverityBuckets<{ positions: Uint32Array; base: number }> = {
			blocking: [],
			normal: [],
			low: []
		};
		for (const severity of CheckSeverity.literals)
			if (matchedBySeverity[severity].length)
				runs[severity].push({
					positions: Uint32Array.from(matchedBySeverity[severity]),
					base: 0
				});
		if (list.groups)
			for (const group of groupedSource()) {
				const severity = workspaceQualitySeverity(group.filter);
				if (record(group.filter, severity, group.ruleId, group.positions.length, 0))
					runs[severity].push({
						positions: group.positions,
						base: 0
					});
			}
		for (const group of list.groups ?? []) {
			if (
				(source && group.reportedBySource) ||
				(request.culture && request.culture !== group.culture)
			)
				continue;
			if (
				record(
					group.filter,
					group.severity,
					group.ruleId,
					group.positions.length,
					group.eligible ? group.positions.length : 0
				)
			)
				runs[group.severity].push({
					positions: group.positions,
					base: sourceCount
				});
		}
		const counts = Schema.decodeUnknownSync(WorkspaceQualityPage.fields.counts)(
			Object.fromEntries([
				...BuiltInQualityFilter.literals.map((filter) => [
					filter,
					filter === "all" ? cultureCount : (typeCounts.get(filter) ?? 0)
				]),
				...customFilters.map(({ filter }) => [filter, typeCounts.get(filter) ?? 0])
			])
		);
		return {
			culture: request.culture,
			filter: request.filter,
			positions: CheckSeverity.literals.map((severity) => runs[severity]),
			counts,
			customFilters,
			severityCounts,
			limits: [...list.limits(request.culture)],
			unsupportedRuleCultures: metadata.unsupportedRuleCultures,
			total: matchedCount,
			suggestedFixCount,
			rules: [...(source?.rules ?? []).map((rule) => rule.ruleId), ...metadata.rules].map(
				(ruleId) => ({ ruleId, findingCount: ruleCounts.get(ruleId) ?? 0 })
			)
		};
	};
	let selection: ReturnType<typeof select> | undefined;
	const search = function* (
		request: WorkspaceQualityRequest
	): QualityRead<WorkspaceQualityPage, WorkspaceQualityItem> {
		if (
			!selection ||
			selection.culture !== request.culture ||
			selection.filter !== request.filter
		)
			selection = select(request);
		const { culture: _culture, filter: _filter, positions, ...page } = selection;
		const offset = request.offset ?? 0;
		const selected: number[] = [];
		let skipped = 0;
		const lowerBound = (values: Uint32Array, value: number) => {
			let low = 0,
				high = values.length;
			while (low < high) {
				const middle = (low + high) >>> 1;
				if (values[middle]! < value) low = middle + 1;
				else high = middle;
			}
			return low;
		};
		// Select by rank across sorted fact groups, without merging or walking their full contents.
		for (const runs of positions) {
			const count = runs.reduce((sum, run) => sum + run.positions.length, 0);
			if (skipped + count <= offset) {
				skipped += count;
				continue;
			}
			const start = Math.max(0, offset - skipped);
			let low = 0,
				high = total;
			while (low < high) {
				const middle = Math.floor((low + high) / 2);
				const through = runs.reduce(
					(sum, run) => sum + lowerBound(run.positions, middle + 1 - run.base),
					0
				);
				if (through <= start) low = middle + 1;
				else high = middle;
			}
			const candidates: number[] = [];
			for (const run of runs) {
				const from = lowerBound(run.positions, low - run.base);
				for (const position of run.positions.subarray(from, from + 50 - selected.length))
					candidates.push(position + run.base);
			}
			candidates.sort((a, b) => a - b);
			selected.push(...candidates.slice(0, 50 - selected.length));
			skipped += count;
			if (selected.length === 50) break;
		}
		const { suggestedFixCount, rules, ...summary } = page;
		return {
			...summary,
			findings: (yield* itemsAt(selected)).map((item) => item.summary),
			suggestedFixCount,
			rules,
			...(offset + 50 < page.total ? { nextOffset: offset + 50 } : undefined)
		};
	};
	return {
		search,
		export: function* (
			request: WorkspaceQualityRequest
		): QualityRead<WorkspaceQualityReport, WorkspaceQualityItem> {
			const { nextOffset: _offset, ...page } = yield* search(request);
			return {
				...page,
				findings: yield* summariesAt(matched(request)),
				corpusCoverage: metadata.coverage,
				status: metadata.status,
				target: request.target,
				filter: request.filter,
				...(request.culture ? { culture: request.culture } : undefined)
			};
		},
		focus: function* (
			request: WorkspaceQualityFocusRequest
		): QualityRead<WorkspaceQualityFocusResult, WorkspaceQualityItem> {
			const sourceFinding =
				pageSources.get(request.id) ??
				(request.id.startsWith("quality-finding:")
					? sourceFindings.find((finding) => textQualityFindingId(finding) === request.id)
					: undefined);
			let item = sourceFinding ? sourceItem(sourceFinding) : undefined;
			if (!item) {
				const position = list.find(request.id, request.culture);
				item =
					position === undefined || hidden(position)
						? undefined
						: withSummary((yield [position])[0]!);
			}
			if (!item) return { status: "not_found" } as const;
			const { finding, line, summary } = item;
			if (!("culture" in finding)) {
				const offset = request.occurrenceOffset ?? 0;
				const previous = offset ? finding.affectedOccurrences[offset - 1]?.id : undefined;
				const focus =
					source &&
					textQualityQuery({ ...source, findings: [finding] }).focus({
						id: summary.id,
						pageSize: 50,
						...(previous ? { occurrenceCursor: previous } : undefined)
					});
				return focus
					? { status: "found" as const, focus: { kind: "source" as const, focus } }
					: { status: "not_found" as const };
			}
			if (!line) return { status: "not_found" } as const;
			const mark = line.cultures.find((mark) => mark.culture === finding.culture);
			const sourceText = findingSource(finding, line);
			const translation = mark ? localizationShippedTranslation(mark).value : null;
			const detail = localizationFocusPage(
				metadata.join,
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
			const change = eligibleLocalizationChange(finding);
			return {
				status: "found" as const,
				focus: {
					kind: "localization" as const,
					id: summary.id,
					source: sourceText.slice(0, 4096),
					translation: translation?.slice(0, 4096) ?? null,
					translationOrigin: finding.translationOrigin,
					sourceRanges: ranges(sourceText, finding, "source"),
					translationRanges: ranges(translation ?? "", finding, "translation"),
					truncated: sourceText.length > 4096 || (translation?.length ?? 0) > 4096,
					...(summary.sourceVariants
						? { sourceVariants: summary.sourceVariants }
						: undefined),
					problem: summary.problem,
					recovery: finding.recovery,
					check: summary.filter,
					severity: summary.severity,
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
		changes: function* (
			request: WorkspaceQualityRequest
		): QualityRead<WorkspaceChangesResult, WorkspaceQualityItem> {
			const changes: LocalizationChange[] = [];
			const seen = new Set<string>();
			let remaining = 0,
				bytes = 0,
				read = 0;
			const eligible = matched(request, eligibleAt);
			// Only format-argument findings suggest changes: one per line and culture, and a line's
			// identity is unique, so changes past the first 100 are counted without reading lines.
			while (read < eligible.length && changes.length < 100) {
				const batch = yield* itemsAt(eligible.slice(read, read + 128));
				read += batch.length;
				for (const { finding } of batch) {
					const change = eligibleLocalizationChange(finding);
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
			}
			remaining += eligible.length - read;
			// File authority stays in the host. A proposal records complete change identities, without filesystem paths.
			return {
				status: "ready" as const,
				document: {
					schemaVersion: 1 as const,
					provenance: { producer: "ue-shed.localization.checks", files: [] },
					changes
				},
				remaining
			};
		}
	};
}

/**
 * Target progress report request with optional culture-page offset. The request scopes
 * presentation and does not change project or target evidence.
 */
export const WorkspaceReportRequest = Schema.Struct({
	target: LocalizationTargetName,
	offset: Offset
});
export type WorkspaceReportRequest = typeof WorkspaceReportRequest.Type;
const Words = Schema.NullOr(Count);
/**
 * Per-culture progress row for a bounded host report. Unknown word/count evidence remains
 * explicit rather than being shown as confirmed translated work.
 */
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
/**
 * Bounded progress rows plus corpus/gather coverage, unknown reasons and optional baseline
 * summary. Failed and missing evidence counts qualify the displayed completion totals.
 */
export const WorkspaceReportPage = Schema.Struct({
	target: LocalizationTargetName,
	rows: Schema.Array(WorkspaceReportRow).check(Schema.isMaxLength(50)),
	totalCultures: Count,
	nextOffset: Offset,
	coverage: TextCorpus.fields.coverage,
	gatherFilesRead: Count,
	/** Every evidence file that failed, including files the working copy does not have. */
	gatherFilesFailed: Count,
	/** The failed files that are absent from the working copy rather than unreadable. */
	gatherFilesMissing: Schema.optionalKey(Count),
	/** The folder Game Text looked in for the target's evidence files. */
	localizationFolder: Schema.optionalKey(Schema.String),
	/** Failed evidence files, missing or unreadable, with their paths and error codes. */
	gatherFileProblems: Schema.optionalKey(
		Schema.Array(LocalizationFileProblem).check(Schema.isMaxLength(50))
	),
	wordCountUnknown: Count,
	unknownReasons: LocalizationProgressCulture.fields.unknownReasons,
	baseline: Schema.optionalKey(
		Schema.Struct({
			target: LocalizationTargetName,
			createdAt: Schema.String,
			/** Lines since the baseline: new keys, removed keys, changed keys and changed source. */
			since: Schema.optionalKey(
				Schema.Struct({ added: Count, removed: Count, keyChanged: Count, changed: Count })
			)
		})
	)
});
export type WorkspaceReportPage = typeof WorkspaceReportPage.Type;
/**
 * Progress report outcome with ready page, unavailable state or failure. Unavailable evidence
 * must not be rendered as a complete zero-line report.
 */
export const WorkspaceReportResult = Schema.Union([
	NotReady,
	Failure,
	Schema.Struct({ status: Schema.Literal("ready"), page: WorkspaceReportPage })
]);
export type WorkspaceReportResult = typeof WorkspaceReportResult.Type;
/**
 * Target-scoped save-baseline, compare-baseline or CSV-export operation. The host owns
 * destination selection and writable-file policy.
 */
export const WorkspaceReportFileRequest = Schema.Struct({
	target: LocalizationTargetName,
	operation: Schema.Literals(["save_baseline", "compare_baseline", "export_csv"])
});
export type WorkspaceReportFileRequest = typeof WorkspaceReportFileRequest.Type;
/**
 * Report-file operation outcome including cancellation, save confirmation or compared page.
 * Failed/unavailable operations retain guidance without claiming a file was persisted.
 */
export const WorkspaceReportFileResult = Schema.Union([
	NotReady,
	Failure,
	Schema.Struct({ status: Schema.Literal("cancelled") }),
	Schema.Struct({ status: Schema.Literal("saved"), message: Schema.String }),
	Schema.Struct({ status: Schema.Literal("compared"), page: WorkspaceReportPage })
]);
export type WorkspaceReportFileResult = typeof WorkspaceReportFileResult.Type;
/**
 * Projects a progress report into native-culture-first bounded rows and aggregate evidence
 * totals. Optional baseline metadata is retained for comparison presentation.
 */
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
	const problems = localizationFileProblems(report.gatherEvidence);
	const folder = localizationEvidenceFolder(report.gatherEvidence);
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
		gatherFilesFailed: problems.length,
		gatherFilesMissing: problems.filter((problem) => problem.state === "missing").length,
		...(folder === undefined ? undefined : { localizationFolder: folder }),
		...(problems.length > 0 ? { gatherFileProblems: problems.slice(0, 50) } : undefined),
		wordCountUnknown: report.wordCountDiagnostics.length,
		unknownReasons: reasons,
		...(offset + 50 < cultures.length ? { nextOffset: offset + 50 } : undefined),
		...(baseline
			? {
					baseline: {
						target: baseline.target,
						createdAt: baseline.provenance.createdAt,
						...(report.cultures[0]?.baselineDelta
							? {
									since: {
										added: report.cultures[0].baselineDelta.addedCounts.lines,
										removed:
											report.cultures[0].baselineDelta.removedCounts.lines,
										keyChanged:
											report.cultures[0].baselineDelta.keyChangedCounts.lines,
										changed:
											report.cultures[0].baselineDelta.changedCounts.lines
									}
								}
							: undefined)
					}
				}
			: undefined)
	};
}
/**
 * Formats the retained localization progress report as spreadsheet-safe CSV. Explicit unknown
 * metrics remain distinguishable from numeric zero.
 */
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

/** A spreadsheet of the same finding summaries the quality list displays. */
export function workspaceQualityCsv(report: WorkspaceQualityReport): string {
	const customLabels = new Map(report.customFilters.map(({ filter, label }) => [filter, label]));
	return spreadsheetCsv([
		[
			"Target",
			"Culture",
			"Severity",
			"Check",
			"Source",
			"Problem",
			"Context",
			"Finding ID",
			"Scan status"
		],
		...report.findings.map((finding) => [
			report.target,
			finding.culture ?? "Source",
			finding.severity,
			workspaceQualityLabel(finding.filter, customLabels),
			finding.source,
			finding.problem,
			finding.context,
			finding.id,
			report.status
		])
	]);
}

/** The workspace over native findings hydrates its selected positions asynchronously. */
export function localizationQualityWorkspaceOf(
	source: TextQualityReport | undefined,
	quality: LocalizationQuality
) {
	const reads = localizationQualityReads(source, quality);
	return {
		search: (request: WorkspaceQualityRequest) =>
			hydrateQualityRead(() => reads.search(request), quality.findings.items),
		export: (request: WorkspaceQualityRequest) =>
			hydrateQualityRead(() => reads.export(request), quality.findings.items),
		focus: (request: WorkspaceQualityFocusRequest) =>
			hydrateQualityRead(() => reads.focus(request), quality.findings.items),
		changes: (request: WorkspaceQualityRequest) =>
			hydrateQualityRead(() => reads.changes(request), quality.findings.items)
	};
}
