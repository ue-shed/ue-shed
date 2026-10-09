import { Schema } from "effect";
import type { LocalizationJoin, LocalizationLine } from "./localization-schema.js";
import { localizationShippedTranslation } from "./localization-shipped-translation.js";
import type { TextCorpusQuery } from "./query.js";
import {
	TextFileScopeSummary,
	type TextCorpus,
	type TextFilterClause,
	type TextWhere
} from "./schema.js";
import type { LocalizationTargetEvidence } from "@ue-shed/localization/browser";
import { textFileKey, textFileLabel, textFileScope } from "./text-origin.js";

/**
 * What a change's text is checked for, in the order results list them:
 * - `key_changed`: a key changed and its earlier key has translations, which a gather run
 *   outside UE Shed would drop;
 * - `conflicting_source`: one key with two texts, so Unreal ships one of them everywhere;
 * - `translated_text_changed`: text changed after it was translated, so those languages show the
 *   new text untranslated until it is translated again;
 * - `text_changed`: text changed since the last gather, with nothing translated yet;
 * - `not_gathered`: new text Unreal has not gathered yet;
 * - `unresolved_key`: text without a reliable key, which cannot be translated;
 * - `removed`: gathered text its file no longer has, or a file that could not be read;
 * - `gathered_source`: text gathered from source code or config, whose keys are checked only
 *   across a gather.
 */
export const LocalizationGateCheck = Schema.Literals([
	"key_changed",
	"conflicting_source",
	"translated_text_changed",
	"text_changed",
	"not_gathered",
	"unresolved_key",
	"removed",
	"gathered_source"
]);
export type LocalizationGateCheck = typeof LocalizationGateCheck.Type;

/** The checks that fail a change unless a project says otherwise. */
export const DEFAULT_GATE_FAILURES: readonly LocalizationGateCheck[] = [
	"key_changed",
	"conflicting_source",
	"translated_text_changed"
];

/** The most lines a target's result lists; the rest are counted. */
export const MAX_GATE_ITEMS = 200;

const Count = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0));
const Outcome = Schema.Literals(["passed", "failed"]);

export const LocalizationGateItem = Schema.Struct({
	check: LocalizationGateCheck,
	severity: Schema.Literals(["fail", "warn"]),
	namespace: Schema.NullOr(Schema.String),
	key: Schema.NullOr(Schema.String),
	source: Schema.String,
	file: Schema.String,
	guidance: Schema.String
});
export type LocalizationGateItem = typeof LocalizationGateItem.Type;

export const LocalizationGateTarget = Schema.Struct({
	target: Schema.String,
	status: Outcome,
	/** Lines whose text lives in a listed file. */
	lines: Count,
	checks: Schema.Struct({
		key_changed: Count,
		conflicting_source: Count,
		translated_text_changed: Count,
		text_changed: Count,
		not_gathered: Count,
		unresolved_key: Count,
		removed: Count,
		gathered_source: Count
	} satisfies Record<LocalizationGateCheck, typeof Count>),
	items: Schema.Array(LocalizationGateItem).check(Schema.isMaxLength(MAX_GATE_ITEMS)),
	omitted: Count,
	fileScope: Schema.optionalKey(TextFileScopeSummary)
});
export type LocalizationGateTarget = typeof LocalizationGateTarget.Type;

export const LocalizationGateResult = Schema.Struct({
	schemaVersion: Schema.Literal(1),
	status: Outcome,
	failOn: Schema.Array(LocalizationGateCheck),
	targets: Schema.Array(LocalizationGateTarget),
	/** Targets left out, such as one Unreal has never gathered, with why. */
	skipped: Schema.Array(Schema.Struct({ target: Schema.String, reason: Schema.String }))
});
export type LocalizationGateResult = typeof LocalizationGateResult.Type;

/** The checks that fail: the defaults, plus `failOn`, less `warnOn`. */
export function localizationGateFailures(
	failOn: readonly LocalizationGateCheck[] = [],
	warnOn: readonly LocalizationGateCheck[] = []
): readonly LocalizationGateCheck[] {
	const failing = new Set([...DEFAULT_GATE_FAILURES, ...failOn]);
	for (const check of warnOn) failing.delete(check);
	return LocalizationGateCheck.literals.filter((check) => failing.has(check));
}

const MAX_SOURCE = 200;
const identityText = (identity: LocalizationLine["identity"]) =>
	identity === null ? "an unknown key" : `${identity.namespace},${identity.key}`;

function guidance(check: LocalizationGateCheck, line: LocalizationLine): string {
	switch (check) {
		case "key_changed": {
			const other = line.keyChange?.other ?? null;
			const earlier = line.keyChange?.direction === "from" ? line.identity : other;
			return (
				`Its earlier key ${identityText(earlier)} has translations that the next gather drops. ` +
				"Carry them with loc run prepare --carry and loc apply --sync, or keep the earlier key in Unreal."
			);
		}
		case "conflicting_source":
			return "This key has more than one text, so Unreal ships one of them everywhere. Give one of the texts its own key in Unreal.";
		case "translated_text_changed":
			return "Its translations were written for the earlier text. After the next gather those languages show this text untranslated until it is translated again.";
		case "text_changed":
			return "Changed since the last gather; nothing is translated yet.";
		case "not_gathered":
			return "New text that Unreal has not gathered yet; gather to send it for translation.";
		case "unresolved_key":
			return "This text has no reliable key, so it cannot be translated. Make it localizable in Unreal.";
		case "removed":
			return "Unreal lists this text in a changed file that no longer has it, or could not be read. The next gather drops it and its translations.";
		case "gathered_source":
			return "Gathered from source code or config, which UE Shed reads only after a gather. Key changes here show once UE Shed runs the gather.";
	}
}

/**
 * Judges the text that lives in a list of changed files, for one target. Each line is checked
 * against the evidence on disk now; nothing records what the files held before, so a problem
 * already in a listed file counts too.
 */
export function localizationGateTarget(input: {
	readonly corpus: TextCorpus;
	readonly query: TextCorpusQuery;
	readonly join: LocalizationJoin;
	readonly files: NonNullable<TextWhere["files"]>;
	readonly failOn: readonly LocalizationGateCheck[];
}): LocalizationGateTarget {
	const { query, join } = input;
	const base = {
		capability: "all" as const,
		query: "",
		localization: { target: join.target },
		where: { files: input.files }
	};
	const lines = query.localizationLines(base);
	const having = (clause: TextFilterClause) =>
		new Set(query.localizationLines({ ...base, filter: [clause] }).map((line) => line.id));
	const conflicting = having({ field: "problem", op: "is", values: ["conflicting_source"] });
	const changed = having({ field: "problem", op: "is", values: ["changed_since_gather"] });
	const notGathered = having({ field: "problem", op: "is", values: ["not_gathered"] });
	const unresolved = having({ field: "finding", op: "is", values: ["unresolved"] });
	const identityKey = (identity: LocalizationLine["identity"]) =>
		identity === null ? "" : JSON.stringify([identity.namespace, identity.key]);
	const listed = new Set(lines.map((line) => identityKey(line.identity)));
	const translated = (line: LocalizationLine) =>
		line.cultures.some((culture) => {
			if (culture.culture === join.nativeCulture) return false;
			const value = localizationShippedTranslation(culture).value;
			return value !== null && value !== "";
		});
	const checksFor = (line: LocalizationLine): LocalizationGateCheck[] => {
		const found: LocalizationGateCheck[] = [];
		const change = line.keyChange;
		// A key change is judged once, on its new key, unless only the earlier key's file is listed.
		const judged =
			change !== undefined &&
			(change.direction === "to" || !listed.has(identityKey(change.other)));
		if (judged && change.translations.length > 0) found.push("key_changed");
		if (conflicting.has(line.id)) found.push("conflicting_source");
		if (changed.has(line.id))
			found.push(translated(line) ? "translated_text_changed" : "text_changed");
		if (notGathered.has(line.id) && !found.includes("key_changed")) found.push("not_gathered");
		if (unresolved.has(line.id)) found.push("unresolved_key");
		if (line.origin.kind === "evidence") {
			if (line.cultures.some((culture) => culture.state === "gathered_only"))
				found.push("gathered_source");
			else if (change === undefined) found.push("removed");
		}
		return found;
	};
	// The file the change touched, as the project spells it: of the line's saved packages and
	// gathered paths, the first one in the list.
	const scope = textFileScope(input.files);
	const listedFile = (path: string) => scope?.keys.has(textFileKey(path)) ?? false;
	const packages = new Map(
		input.corpus.units.map(
			(unit) =>
				[unit.id, unit.occurrences.map((occurrence) => occurrence.packageFile)] as const
		)
	);
	const lineFile = (line: LocalizationLine) => {
		const places = [
			...(line.origin.kind === "corpus"
				? line.origin.unitIds.flatMap((id) => packages.get(id) ?? [])
				: []),
			...line.manifest.map((entry) => entry.path)
		];
		return textFileLabel(places.find(listedFile) ?? places[0] ?? "");
	};
	const failing = new Set(input.failOn);
	const checks = {
		key_changed: 0,
		conflicting_source: 0,
		translated_text_changed: 0,
		text_changed: 0,
		not_gathered: 0,
		unresolved_key: 0,
		removed: 0,
		gathered_source: 0
	} satisfies Record<LocalizationGateCheck, number>;
	const items: LocalizationGateItem[] = [];
	for (const line of lines)
		for (const check of checksFor(line)) {
			checks[check]++;
			items.push({
				check,
				severity: failing.has(check) ? "fail" : "warn",
				namespace: line.identity?.namespace ?? null,
				key: line.identity?.key ?? null,
				source:
					line.source.length > MAX_SOURCE
						? line.source.slice(0, MAX_SOURCE - 1) + "…"
						: line.source,
				file: lineFile(line),
				guidance: guidance(check, line)
			});
		}
	const order = (item: LocalizationGateItem) =>
		(item.severity === "fail" ? 0 : LocalizationGateCheck.literals.length) +
		LocalizationGateCheck.literals.indexOf(item.check);
	items.sort((left, right) => order(left) - order(right));
	const fileScope = query.search({ ...base, pageSize: 1 }).fileScope;
	return {
		target: join.target,
		status: items.some((item) => item.severity === "fail") ? "failed" : "passed",
		lines: lines.length,
		checks,
		items: items.slice(0, MAX_GATE_ITEMS),
		omitted: Math.max(0, items.length - MAX_GATE_ITEMS),
		...(fileScope === undefined ? undefined : { fileScope })
	};
}

/**
 * Target files that exist but could not be read or parsed, as `path (code)`. A missing archive or
 * PO file means nothing is translated; an unreadable one means the translations are unknown, and
 * a verdict built on them could pass a change that loses translations.
 */
export function localizationGateUnreadEvidence(
	evidence: LocalizationTargetEvidence
): readonly string[] {
	const files = [
		evidence.manifest,
		...evidence.cultures.flatMap((culture) => [culture.archive, culture.po])
	];
	return files.flatMap((file) =>
		file.status === "failed" && file.error.code !== "file_missing"
			? [`${file.relativePath ?? "a localization file"} (${file.error.code})`]
			: []
	);
}

/**
 * Listed saved packages the scan could not read completely. Their text cannot be judged, so a
 * verdict that ignored them could pass new or conflicting text.
 */
export function localizationGateUnreadPackages(
	corpus: TextCorpus,
	files: readonly string[]
): readonly string[] {
	const scope = textFileScope(files);
	if (scope === undefined) return [];
	return (corpus.packageCoverage ?? []).flatMap((coverage) =>
		coverage.status !== "complete" && scope.keys.has(textFileKey(coverage.packageFile))
			? [`${textFileLabel(coverage.packageFile)} (${coverage.status})`]
			: []
	);
}

/** The whole change: failed when any target failed. */
export function localizationGateResult(
	targets: readonly LocalizationGateTarget[],
	failOn: readonly LocalizationGateCheck[],
	skipped: LocalizationGateResult["skipped"] = []
): LocalizationGateResult {
	return {
		schemaVersion: 1,
		status: targets.some((target) => target.status === "failed") ? "failed" : "passed",
		failOn,
		targets,
		skipped
	};
}
