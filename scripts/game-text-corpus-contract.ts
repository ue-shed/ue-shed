import { isDeepStrictEqual } from "node:util";
import { Schema } from "effect";

/** Portable fixture contract. No game-text implementation (including type imports) belongs here. */
export const corpusPlanName = "UEShedGameTextCorpus.plan.json";
export const corpusExpectationsName = "UEShedGameTextCorpus.expected.json";
export const corpusCultures = ["en", "de", "fr", "ja"] as const;
export const CorpusSourceKind = Schema.Literals([
	"stringTableEntry",
	"dataTableCell",
	"blueprintVariable",
	"blueprintPin",
	"widgetText",
	"manifest"
]);
export type CorpusSourceKind = typeof CorpusSourceKind.Type;
export const CorpusFinding = Schema.Struct({
	check: Schema.String,
	actual: Schema.Json,
	expectation: Schema.Json
});
export type CorpusFinding = typeof CorpusFinding.Type;
/** Compiled and lag facts are carried for the next engine; today's public index exposes PO/archive. */
export const CorpusTranslationStages = Schema.Struct({
	po: Schema.NullOr(Schema.String),
	archive: Schema.NullOr(Schema.String),
	compiled: Schema.NullOr(Schema.String),
	importPending: Schema.Boolean,
	compilePending: Schema.Boolean
});
export const corpusNotExposedYet = {
	"stages.compiled": true,
	"stages.importPending": true,
	"stages.compilePending": true
} as const;
export const CorpusSubject = Schema.Struct({
	case: Schema.String,
	packagePath: Schema.String,
	namespace: Schema.String,
	key: Schema.String,
	kind: CorpusSourceKind,
	field: Schema.String,
	source: Schema.String,
	gatheredSource: Schema.NullOr(Schema.String),
	culture: Schema.String,
	state: Schema.String,
	facts: Schema.Array(Schema.String),
	unknownReasons: Schema.Array(Schema.String),
	problems: Schema.Array(Schema.String),
	signals: Schema.Array(Schema.String),
	findings: Schema.Array(CorpusFinding),
	stages: CorpusTranslationStages,
	absent: Schema.Array(Schema.String)
});
export type CorpusSubject = typeof CorpusSubject.Type;
export const CorpusExpectations = Schema.Struct({
	format: Schema.Literal("ue-shed-game-text-corpus-expectations"),
	version: Schema.Literal(1),
	seed: Schema.Int,
	lines: Schema.Int,
	root: Schema.String,
	target: Schema.String,
	cultures: Schema.Array(Schema.String),
	subjects: Schema.Array(CorpusSubject),
	counts: Schema.Record(Schema.String, Schema.Int),
	notExposedYet: Schema.Struct({
		"stages.compiled": Schema.Literal(true),
		"stages.importPending": Schema.Literal(true),
		"stages.compilePending": Schema.Literal(true)
	})
});
export type CorpusExpectations = typeof CorpusExpectations.Type;

export function subjectKey(
	subject: Pick<CorpusSubject, "packagePath" | "namespace" | "key" | "kind" | "field" | "culture">
) {
	return JSON.stringify([
		subject.packagePath,
		subject.namespace,
		subject.key,
		subject.kind,
		subject.field,
		subject.culture
	]);
}

export function findingCounts(subjects: readonly CorpusSubject[]) {
	const counts: Record<string, number> = {};
	for (const subject of subjects) {
		for (const finding of subject.findings)
			counts[finding.check] = (counts[finding.check] ?? 0) + 1;
		for (const signal of subject.signals)
			counts[`signal.${signal}`] = (counts[`signal.${signal}`] ?? 0) + 1;
	}
	return Object.fromEntries(Object.entries(counts).sort(([a], [b]) => a.localeCompare(b)));
}

export function decodeCorpusExpectations(contents: string): CorpusExpectations {
	const result = Schema.decodeUnknownSync(Schema.fromJsonString(CorpusExpectations))(contents);
	const keys = result.subjects.map(subjectKey);
	if (new Set(keys).size !== keys.length) throw new Error("Duplicate corpus subject identity.");
	if (!isDeepStrictEqual(findingCounts(result.subjects), result.counts))
		throw new Error("Corpus finding counts disagree with its subjects.");
	return result;
}

/** Compare findings as a multiset, facts/signals as sets, and evidence arrays in their reported order. */
export function sameCorpusSubject(
	intent: CorpusSubject,
	subject: CorpusSubject,
	includeUnexposedStages = false
) {
	const comparable = ({
		case: _case,
		absent: _absent,
		findings: _findings,
		...value
	}: CorpusSubject) => ({
		...value,
		facts: [...value.facts].sort(),
		signals: [...value.signals].sort(),
		unknownReasons: [...value.unknownReasons].sort(),
		stages: includeUnexposedStages
			? value.stages
			: { po: value.stages.po, archive: value.stages.archive }
	});
	const remaining = [...intent.findings];
	let sameFindings = remaining.length === subject.findings.length;
	for (const finding of subject.findings) {
		const position = remaining.findIndex((candidate) => isDeepStrictEqual(candidate, finding));
		if (position < 0) sameFindings = false;
		else remaining.splice(position, 1);
	}
	return sameFindings && isDeepStrictEqual(comparable(intent), comparable(subject));
}

/** Exact set comparison, including extra subjects/findings and all evidence. Never runs checks. */
export function diffCorpus(
	expected: CorpusExpectations,
	actual: readonly CorpusSubject[],
	includeUnexposedStages = false
) {
	const wanted = new Map(expected.subjects.map((subject) => [subjectKey(subject), subject]));
	const seen = new Set<string>();
	const differences: { case: string; subject: string; expected: unknown; actual: unknown }[] = [];
	for (const subject of actual) {
		const key = subjectKey(subject);
		const intent = wanted.get(key);
		if (seen.has(key) || !intent || !sameCorpusSubject(intent, subject, includeUnexposedStages))
			differences.push({
				case: intent?.case ?? "unplanned",
				subject: key,
				expected: intent ?? null,
				actual: subject
			});
		seen.add(key);
	}
	for (const [key, subject] of wanted)
		if (!seen.has(key))
			differences.push({ case: subject.case, subject: key, expected: subject, actual: null });
	return differences;
}
