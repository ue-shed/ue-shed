import { Schema } from "effect";
import {
	TextQualityAffectedOccurrence,
	TextQualityRuleDocument,
	TextQualityRoleSummary,
	TextQualityRuleSummary,
	type TextQualityFinding,
	type TextQualityReport
} from "./quality-schema.js";
import { TextCorpus, TextOccurrenceId, TextUnitId } from "./schema.js";

const Count = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0));
const PageSize = Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 50 }));

export const TextQualityFindingId = Schema.String.pipe(Schema.brand("TextQualityFindingId"));
export type TextQualityFindingId = Schema.Schema.Type<typeof TextQualityFindingId>;
export const makeTextQualityFindingId = TextQualityFindingId.make;

export const TextQualityFindingKind = Schema.Literals(["character_budget", "terminology"]);
export type TextQualityFindingKind = Schema.Schema.Type<typeof TextQualityFindingKind>;

export const TextQualityFilter = Schema.Literals(["all", "character_budget", "terminology"]);
export type TextQualityFilter = Schema.Schema.Type<typeof TextQualityFilter>;

export const TextQualityQuerySummary = Schema.Struct({
	characterBudgetCount: Count,
	coverage: TextCorpus.fields.coverage,
	diagnosticCount: Count,
	findingCount: Count,
	roles: Schema.Array(TextQualityRoleSummary),
	rules: Schema.Array(TextQualityRuleSummary),
	ruleDocumentVersion: Schema.Literal(1),
	schemaVersion: Schema.Literal(1),
	status: TextCorpus.fields.status,
	terminologyCount: Count
});
export type TextQualityQuerySummary = Schema.Schema.Type<typeof TextQualityQuerySummary>;

export const TextQualityQueryRunResult = Schema.Union([
	Schema.Struct({
		document: TextQualityRuleDocument,
		status: Schema.Literal("completed"),
		summary: TextQualityQuerySummary
	}),
	Schema.Struct({ status: Schema.Literal("cancelled") }),
	Schema.Struct({ status: Schema.Literal("not_ready") }),
	Schema.Struct({
		status: Schema.Literal("failed"),
		error: Schema.Struct({
			code: Schema.Literals(["invalid_rules", "read_failed", "contract_failure"]),
			message: Schema.String,
			recovery: Schema.String,
			retrySafe: Schema.Boolean
		})
	})
]);
export type TextQualityQueryRunResult = Schema.Schema.Type<typeof TextQualityQueryRunResult>;
export const decodeTextQualityQueryRunResult =
	Schema.decodeUnknownEffect(TextQualityQueryRunResult);

export const TextQualityRuleUpdateResult = Schema.Union([
	Schema.Struct({
		document: TextQualityRuleDocument,
		status: Schema.Literal("completed"),
		summary: TextQualityQuerySummary
	}),
	Schema.Struct({ status: Schema.Literal("not_ready") }),
	Schema.Struct({
		status: Schema.Literal("failed"),
		error: Schema.Struct({
			code: Schema.Literals(["invalid_rules", "write_failed", "contract_failure"]),
			message: Schema.String,
			recovery: Schema.String,
			retrySafe: Schema.Boolean
		})
	})
]);
export type TextQualityRuleUpdateResult = Schema.Schema.Type<typeof TextQualityRuleUpdateResult>;
export const decodeTextQualityRuleUpdateResult = Schema.decodeUnknownEffect(
	TextQualityRuleUpdateResult
);

export const TextQualityFindingSummary = Schema.Struct({
	actual: Schema.String.check(Schema.isMaxLength(512)),
	expectation: Schema.String.check(Schema.isMaxLength(512)),
	id: TextQualityFindingId,
	kind: TextQualityFindingKind,
	occurrenceCount: Count,
	recovery: Schema.String.check(Schema.isMaxLength(2048)),
	role: Schema.String,
	ruleId: Schema.String,
	sourceExcerpt: Schema.String.check(Schema.isMaxLength(512)),
	textUnitId: TextUnitId
});
export type TextQualityFindingSummary = Schema.Schema.Type<typeof TextQualityFindingSummary>;

export const TextQualitySearchRequest = Schema.Struct({
	cursor: Schema.optional(TextQualityFindingId),
	filter: TextQualityFilter,
	pageSize: PageSize
});
export type TextQualitySearchRequest = Schema.Schema.Type<typeof TextQualitySearchRequest>;

export const TextQualitySearchPage = Schema.Struct({
	findings: Schema.Array(TextQualityFindingSummary).check(Schema.isMaxLength(50)),
	nextCursor: Schema.optional(TextQualityFindingId),
	total: Count
});
export type TextQualitySearchPage = Schema.Schema.Type<typeof TextQualitySearchPage>;

export const TextQualitySearchResult = Schema.Union([
	Schema.Struct({ status: Schema.Literal("ready"), page: TextQualitySearchPage }),
	Schema.Struct({ status: Schema.Literal("not_ready") })
]);
export type TextQualitySearchResult = Schema.Schema.Type<typeof TextQualitySearchResult>;
export const decodeTextQualitySearchResult = Schema.decodeUnknownEffect(TextQualitySearchResult);

export const TextQualityFocusRequest = Schema.Struct({
	id: TextQualityFindingId,
	occurrenceCursor: Schema.optional(TextOccurrenceId),
	pageSize: PageSize
});
export type TextQualityFocusRequest = Schema.Schema.Type<typeof TextQualityFocusRequest>;

const FocusBase = {
	affectedOccurrences: Schema.Array(TextQualityAffectedOccurrence).check(Schema.isMaxLength(50)),
	id: TextQualityFindingId,
	nextOccurrenceCursor: Schema.optional(TextOccurrenceId),
	recovery: Schema.String,
	role: Schema.String,
	ruleId: Schema.String,
	sourceExcerpt: Schema.String.check(Schema.isMaxLength(4096)),
	sourceTruncated: Schema.Boolean,
	textUnitId: TextUnitId,
	totalOccurrences: Count
};

export const TextQualityFocus = Schema.Union([
	Schema.Struct({
		...FocusBase,
		actual: Schema.Struct({ characterCount: Count, kind: Schema.Literal("character_count") }),
		expectation: Schema.Struct({
			kind: Schema.Literal("maximum_characters"),
			maximumCharacters: Schema.Int.check(Schema.isGreaterThan(0))
		}),
		kind: Schema.Literal("character_budget")
	}),
	Schema.Struct({
		...FocusBase,
		actual: Schema.Struct({
			end: Count,
			kind: Schema.Literal("terminology_match"),
			start: Count,
			term: Schema.String
		}),
		expectation: Schema.Union([
			Schema.Struct({ kind: Schema.Literal("forbidden_term"), term: Schema.String }),
			Schema.Struct({
				discouragedTerm: Schema.String,
				kind: Schema.Literal("preferred_term"),
				preferredTerm: Schema.String
			})
		]),
		kind: Schema.Literal("terminology")
	})
]);
export type TextQualityFocus = Schema.Schema.Type<typeof TextQualityFocus>;

export const TextQualityFocusResult = Schema.Union([
	Schema.Struct({ status: Schema.Literal("found"), focus: TextQualityFocus }),
	Schema.Struct({ status: Schema.Literal("not_found") }),
	Schema.Struct({ status: Schema.Literal("not_ready") })
]);
export type TextQualityFocusResult = Schema.Schema.Type<typeof TextQualityFocusResult>;
export const decodeTextQualityFocusResult = Schema.decodeUnknownEffect(TextQualityFocusResult);

function excerpt(source: string, maximum: number): string {
	return source.length <= maximum ? source : `${source.slice(0, maximum - 1)}…`;
}

function actualLabel(finding: TextQualityFinding): string {
	return finding.kind === "character_budget"
		? `${finding.actual.characterCount} characters`
		: `“${finding.actual.term}” at ${finding.actual.start}–${finding.actual.end}`;
}

function expectationLabel(finding: TextQualityFinding): string {
	if (finding.kind === "character_budget") {
		return `Maximum ${finding.expectation.maximumCharacters} characters`;
	}
	return finding.expectation.kind === "forbidden_term"
		? `Remove forbidden term “${finding.expectation.term}”`
		: `Prefer “${finding.expectation.preferredTerm}”`;
}

function sourceOf(finding: TextQualityFinding): string {
	return finding.actual.source;
}

interface IndexedFinding {
	readonly finding: TextQualityFinding;
	readonly id: TextQualityFindingId;
	readonly summary: TextQualityFindingSummary;
}

/** Retained, bounded presentation query over a full quality report. */
export interface TextQualityQuery {
	readonly focus: (request: TextQualityFocusRequest) => TextQualityFocus | undefined;
	readonly search: (request: TextQualitySearchRequest) => TextQualitySearchPage;
	readonly summary: () => TextQualityQuerySummary;
}

export function textQualityQuery(report: TextQualityReport): TextQualityQuery {
	const indexed: readonly IndexedFinding[] = report.findings.map((finding, index) => {
		const id = makeTextQualityFindingId(`quality-finding:${index + 1}`);
		return {
			finding,
			id,
			summary: {
				actual: excerpt(actualLabel(finding), 512),
				expectation: excerpt(expectationLabel(finding), 512),
				id,
				kind: finding.kind,
				occurrenceCount: finding.affectedOccurrences.length,
				recovery: excerpt(finding.recovery, 2048),
				role: finding.role,
				ruleId: finding.ruleId,
				sourceExcerpt: excerpt(sourceOf(finding), 512),
				textUnitId: finding.textUnitId
			}
		};
	});
	const summary: TextQualityQuerySummary = {
		characterBudgetCount: indexed.filter(({ finding }) => finding.kind === "character_budget")
			.length,
		coverage: report.coverage,
		diagnosticCount: report.diagnostics.length,
		findingCount: indexed.length,
		roles: report.roles,
		rules: report.rules,
		ruleDocumentVersion: report.ruleDocumentVersion,
		schemaVersion: 1,
		status: report.status,
		terminologyCount: indexed.filter(({ finding }) => finding.kind === "terminology").length
	};

	return {
		summary: () => summary,
		search: (request) => {
			const matched = indexed.filter(
				({ finding }) => request.filter === "all" || finding.kind === request.filter
			);
			const cursorIndex = request.cursor
				? matched.findIndex(({ id }) => id === request.cursor) + 1
				: 0;
			const start = Math.max(0, cursorIndex);
			const page = matched.slice(start, start + request.pageSize);
			const final = page.at(-1)?.id;
			return {
				findings: page.map(({ summary: finding }) => finding),
				total: matched.length,
				...(final !== undefined && start + page.length < matched.length
					? { nextCursor: final }
					: {})
			};
		},
		focus: (request) => {
			const indexedFinding = indexed.find(({ id }) => id === request.id);
			if (!indexedFinding) return undefined;
			const { finding, id } = indexedFinding;
			const cursorIndex = request.occurrenceCursor
				? finding.affectedOccurrences.findIndex(
						(occurrence) => occurrence.id === request.occurrenceCursor
					) + 1
				: 0;
			const start = Math.max(0, cursorIndex);
			const affectedOccurrences = finding.affectedOccurrences.slice(
				start,
				start + request.pageSize
			);
			const final = affectedOccurrences.at(-1)?.id;
			const source = sourceOf(finding);
			const base = {
				affectedOccurrences,
				id,
				recovery: finding.recovery,
				role: finding.role,
				ruleId: finding.ruleId,
				sourceExcerpt: excerpt(source, 4096),
				sourceTruncated: source.length > 4096,
				textUnitId: finding.textUnitId,
				totalOccurrences: finding.affectedOccurrences.length,
				...(final !== undefined &&
				start + affectedOccurrences.length < finding.affectedOccurrences.length
					? { nextOccurrenceCursor: final }
					: {})
			};
			return finding.kind === "character_budget"
				? {
						...base,
						actual: {
							characterCount: finding.actual.characterCount,
							kind: finding.actual.kind
						},
						expectation: finding.expectation,
						kind: finding.kind
					}
				: {
						...base,
						actual: {
							end: finding.actual.end,
							kind: finding.actual.kind,
							start: finding.actual.start,
							term: finding.actual.term
						},
						expectation: finding.expectation,
						kind: finding.kind
					};
		}
	};
}
