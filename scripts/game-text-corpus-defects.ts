import { isDeepStrictEqual } from "node:util";
import { Schema } from "effect";
import { CorpusSubject, sameCorpusSubject, subjectKey } from "./game-text-corpus-contract.ts";

/** Each exception pins both sides. Any unlisted field still has to agree exactly. */
export interface CorpusKnownDefect {
	case: string;
	defects: readonly string[];
	kind: "subject" | "probe";
	culture?: string;
	/** A subject pin that applies to every culture's subject carrying this finding check. */
	withCheck?: string;
	status: "defect" | "open";
	why: string;
	actual: typeof Schema.Json.Type;
	rightAnswer: typeof Schema.Json.Type;
}
/** Today's engine agrees with every planted answer; a newly found defect is pinned here. */
export const corpusKnownDefects: readonly CorpusKnownDefect[] = [];

const Dictionary = Schema.Record(Schema.String, Schema.Json);
const isStringArray = Schema.is(Schema.Array(Schema.String));
// These fields are sets in the portable diff; finding evidence and problem priority remain ordered.
type CorpusDefectValue = typeof Schema.Json.Type | undefined;
function sameDefectField(key: string, left: CorpusDefectValue, right: CorpusDefectValue) {
	if (
		["facts", "signals", "unknownReasons"].includes(key) &&
		isStringArray(left) &&
		isStringArray(right)
	)
		return isDeepStrictEqual([...left].sort(), [...right].sort());
	return isDeepStrictEqual(left, right);
}

type Difference = {
	case: string;
	subject?: string;
	expected: unknown;
	actual: unknown;
	duplicate?: true;
};
export function corpusDefectsFor(
	subjects: readonly CorpusSubject[],
	probes: readonly Difference[] = [],
	known: readonly CorpusKnownDefect[] = corpusKnownDefects
) {
	const result: (CorpusKnownDefect & { subject: string })[] = [];
	for (const subject of subjects) {
		const predicted = {
			...subject,
			findings: [...subject.findings],
			facts: [...subject.facts],
			signals: [...subject.signals],
			problems: [...subject.problems]
		};
		const explanations: string[] = [],
			defectIds: string[] = [];
		for (const template of known) {
			if (template.kind !== "subject" || template.case !== subject.case.split("@")[0])
				continue;
			if (template.withCheck !== undefined) {
				if (!subject.findings.some((finding) => finding.check === template.withCheck))
					continue;
			} else if (template.culture !== subject.culture) continue;
			const right = Schema.decodeUnknownSync(Dictionary)(template.rightAnswer),
				value = Schema.decodeUnknownSync(Dictionary)(subject);
			if (!Object.keys(right).every((key) => sameDefectField(key, right[key], value[key])))
				throw new Error(`Known defect no longer describes the recipe: ${subject.case}`);
			Object.assign(predicted, Schema.decodeUnknownSync(Dictionary)(template.actual));
			explanations.push(template.why);
			defectIds.push(...template.defects);
		}

		if (explanations.length) {
			const actual = Schema.decodeUnknownSync(Dictionary)(predicted),
				wanted = Schema.decodeUnknownSync(Dictionary)(subject);
			const fields = Object.keys(actual).filter(
				(key) => !sameDefectField(key, actual[key], wanted[key])
			);
			result.push({
				case: subject.case,
				defects: [...new Set(defectIds)],
				kind: "subject",
				culture: subject.culture,
				status: "defect",
				subject: subjectKey(subject),
				why: explanations.join(" "),
				actual: Object.fromEntries(fields.map((key) => [key, actual[key]!])),
				rightAnswer: Object.fromEntries(fields.map((key) => [key, wanted[key]!]))
			});
		}
	}
	for (const probe of probes)
		for (const template of known) {
			if (template.kind !== "probe" || template.case !== probe.case.split("@")[0]) continue;
			result.push({
				...template,
				case: probe.case,
				subject: probe.subject!
			});
		}
	return result;
}

/** Pin each individual instance. A fixed instance must go stale even if its siblings still fail. */
export function triageCorpusDifferences(
	differences: readonly Difference[],
	subjects: readonly CorpusSubject[] = [],
	probes: readonly Difference[] = [],
	known: readonly CorpusKnownDefect[] = corpusKnownDefects
) {
	const defects = corpusDefectsFor(subjects, probes, known);
	const matched = new Set<(typeof defects)[number]>();
	const bySubject = new Map(
		defects.map((defect) => [`${defect.case}\0${defect.subject}`, defect])
	);
	const unexpected = differences.filter((difference) => {
		if (difference.duplicate) return true;
		const found = bySubject.get(`${difference.case}\0${difference.subject}`);
		// Each pinned defect excuses one result only.
		const candidates = found && !matched.has(found) ? [found] : [];
		if (
			Schema.is(CorpusSubject)(difference.expected) &&
			Schema.is(CorpusSubject)(difference.actual)
		) {
			const expected = difference.expected,
				actual = difference.actual,
				repaired = { ...actual };
			for (const defect of candidates) {
				const right = Schema.decodeUnknownSync(Dictionary)(defect.rightAnswer),
					today = Schema.decodeUnknownSync(Dictionary)(defect.actual);
				const e = Schema.decodeUnknownSync(Dictionary)(expected),
					a = Schema.decodeUnknownSync(Dictionary)(actual);
				if (
					!Object.keys(right).every(
						(key) =>
							sameDefectField(key, e[key], right[key]) &&
							sameDefectField(key, a[key], today[key])
					)
				)
					continue;
				Object.assign(repaired, right);
				matched.add(defect);
			}
			return !sameCorpusSubject(expected, repaired);
		}
		const defect = candidates.find(
			(defect) =>
				isDeepStrictEqual(defect.actual, difference.actual) &&
				isDeepStrictEqual(defect.rightAnswer, difference.expected)
		);
		if (defect) matched.add(defect);
		return !defect;
	});
	const unexpectedSet = new Set(unexpected);
	const pinned = differences.filter((difference) => !unexpectedSet.has(difference));
	const counts = new Map<string, number>();
	for (const difference of pinned)
		for (const id of bySubject.get(`${difference.case}\0${difference.subject}`)!.defects)
			counts.set(id, (counts.get(id) ?? 0) + 1);
	return {
		unexpected,
		stale: defects.filter((defect) => !matched.has(defect)),
		pinned: {
			total: pinned.length,
			byDefect: Object.fromEntries([...counts].sort(([a], [b]) => a.localeCompare(b)))
		}
	};
}

export interface CorpusPinnedSummary {
	total: number;
	/** Membership counts can overlap when one subject exhibits several independent defects. */
	byDefect: Readonly<Record<string, number>>;
}

/** Shared by the CLI and portable reporting tests; performs no scan or rule evaluation. */
export function formatCorpusComparisonSummary(
	subjects: number,
	disagreements: number,
	pinned: CorpusPinnedSummary
) {
	return `${subjects} subjects; ${disagreements} disagreements; ${pinned.total} pinned disagreements.\n`;
}
