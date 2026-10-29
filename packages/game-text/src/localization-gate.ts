import { Effect, Schema } from "effect";
import type { LocalizationJoin, LocalizationLine } from "./localization-schema.js";
import type { TextCorpusSearchPage } from "./schema.js";
import { TextFileScopeSummary, type TextCorpus, type TextWhere } from "./schema.js";
import type { LocalizationLineView } from "./index-reads.js";
import type { NativeTextQuery } from "./native-query-contract.js";
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
 *   across a gather;
 * - `partial_read`: a listed package the reader read only in part, so text in the parts it could
 *   not read is not checked. The text it did read is checked like any other.
 */
export const LocalizationGateCheck = Schema.Literals([
	"key_changed",
	"conflicting_source",
	"translated_text_changed",
	"text_changed",
	"not_gathered",
	"unresolved_key",
	"removed",
	"gathered_source",
	"partial_read"
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

/**
 * One gate finding with authored fail/warn policy and file/identity context. guidance is for
 * people; callers branch on check and severity rather than parsing that prose.
 */
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

/**
 * Target gate outcome with full check counts and a bounded item preview. omitted counts
 * findings beyond MAX_GATE_ITEMS; lines counts text in the requested file scope.
 */
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
		gathered_source: Count,
		partial_read: Count
	} satisfies Record<LocalizationGateCheck, typeof Count>),
	items: Schema.Array(LocalizationGateItem).check(Schema.isMaxLength(MAX_GATE_ITEMS)),
	omitted: Count,
	fileScope: Schema.optionalKey(TextFileScopeSummary)
});
export type LocalizationGateTarget = typeof LocalizationGateTarget.Type;

/**
 * Aggregate gate outcome plus per-target results and skipped targets. failOn records the active
 * host policy, and skipped targets retain reasons instead of being counted as checked
 * successes.
 */
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

function guidance(
	check: LocalizationGateCheck,
	line: Pick<LocalizationLine, "identity" | "keyChange">
): string {
	switch (check) {
		case "key_changed": {
			const other = line.keyChange?.other ?? null;
			const earlier = line.keyChange?.direction === "from" ? line.identity : other;
			return (
				`Its earlier key ${identityText(earlier)} has translations that the next gather drops. ` +
				"Carry the translations to the new key and synchronize them with the project, or keep the earlier key in Unreal."
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
		case "partial_read":
			return "Part of this package could not be read, so text there is not checked.";
	}
}

/** A listed package the reader read only in part, and what it could not read. */
export interface LocalizationGatePartialRead {
	readonly file: string;
	readonly guidance: string;
}

/** Why the reader left a property unread, as a reviewer reads it. */
const GAP_REASONS = {
	feature_unavailable_for_engine_version: "not decoded for this engine version",
	unsupported_text_history: "a kind of text the reader does not support",
	legacy_container_element_without_type_information:
		"container elements saved without their type",
	property_decoder_rejected: "rejected by the reader's decoder"
} as const;

/**
 * Listed packages the scan read only in part, each with what it could not read, from the
 * package's `package_partially_decoded` diagnostic. The gate checks the text they did yield and
 * lists them as `partial_read`, so a reviewer knows which parts to look at in Unreal.
 */
export function localizationGatePartialPackages(
	corpus: Pick<TextCorpus, "packageCoverage" | "diagnostics">,
	files: readonly string[]
): readonly LocalizationGatePartialRead[] {
	const scope = textFileScope(files);
	if (scope === undefined) return [];
	const diagnostics = new Map(
		corpus.diagnostics
			.filter((diagnostic) => diagnostic.code === "package_partially_decoded")
			.map((diagnostic) => [textFileKey(diagnostic.packageFile), diagnostic])
	);
	return (corpus.packageCoverage ?? []).flatMap((coverage) => {
		const key = textFileKey(coverage.packageFile);
		if (coverage.status !== "partial" || !scope.keys.has(key)) return [];
		const diagnostic = diagnostics.get(key);
		const counts = Object.entries(diagnostic?.coverageGapCounts ?? {}).filter(
			(entry): entry is [keyof typeof GAP_REASONS, number] =>
				entry[0] in GAP_REASONS && entry[1] > 0
		);
		const total = counts.reduce((sum, [, count]) => sum + count, 0);
		const example =
			diagnostic?.propertyPath === undefined
				? ""
				: total === 1
					? ` (\`${diagnostic.propertyPath}\`)`
					: `, such as \`${diagnostic.propertyPath}\``;
		// With one reason its count is the total; with several, each has its own.
		const why = counts
			.map(([reason, count]) =>
				counts.length === 1 ? GAP_REASONS[reason] : `${GAP_REASONS[reason]} (${count})`
			)
			.join(", ");
		const what =
			total === 0
				? "Part of this package could not be read"
				: `${total} ${total === 1 ? "property was" : "properties were"} not read${example}: ${why}`;
		return [
			{
				file: textFileLabel(coverage.packageFile),
				guidance: `${what}. Text there is not checked; the package's other text is. Review those parts in Unreal.`
			}
		];
	});
}

/** The line fields a gate reads: one `selectLocalizationLines` call answers every check. */
export const LOCALIZATION_GATE_FIELDS = [
	"identity",
	"source",
	"origin",
	"keyChange",
	"manifest",
	"marks",
	"problems",
	"signals",
	"places"
] as const;
/** A line as the gate reads it. */
export type LocalizationGateLine = LocalizationLineView<(typeof LOCALIZATION_GATE_FIELDS)[number]>;

/**
 * Judges the text that lives in a list of changed files, for one target. Each line is checked
 * against the evidence on disk now; nothing records what the files held before, so a problem
 * already in a listed file counts too. Read the lines with `selectLocalizationLines` and
 * `LOCALIZATION_GATE_FIELDS` over the files, or use `indexedLocalizationGateTarget`.
 */
export function localizationGateTarget(input: {
	readonly lines: readonly LocalizationGateLine[];
	readonly fileScope?: TextCorpusSearchPage["fileScope"];
	readonly join: Pick<LocalizationJoin, "target" | "nativeCulture">;
	readonly files: NonNullable<TextWhere["files"]>;
	readonly failOn: readonly LocalizationGateCheck[];
	/** Listed packages read only in part, from `localizationGatePartialPackages`. */
	readonly partial?: readonly LocalizationGatePartialRead[];
}): LocalizationGateTarget {
	const { join, lines, fileScope } = input;
	const identityKey = (identity: LocalizationLine["identity"]) =>
		identity === null ? "" : JSON.stringify([identity.namespace, identity.key]);
	const listed = new Set(lines.map((line) => identityKey(line.identity)));
	const translated = (line: LocalizationGateLine) =>
		line.marks.some(
			(mark) =>
				mark.culture !== join.nativeCulture &&
				mark.translation !== null &&
				mark.translation !== ""
		);
	const checksFor = (line: LocalizationGateLine): LocalizationGateCheck[] => {
		const found: LocalizationGateCheck[] = [];
		const change = line.keyChange;
		// A key change is judged once, on its new key, unless only the earlier key's file is listed.
		const judged =
			change !== undefined &&
			(change.direction === "to" || !listed.has(identityKey(change.other)));
		if (judged && change.translations.length > 0) found.push("key_changed");
		if (line.problems.includes("conflicting_source")) found.push("conflicting_source");
		// The state, not the problem: a line Unreal gathered whose text is gone is `removed` below.
		if (line.marks.some((mark) => mark.state === "changed_since_gather"))
			found.push(translated(line) ? "translated_text_changed" : "text_changed");
		if (line.problems.includes("not_gathered") && !found.includes("key_changed"))
			found.push("not_gathered");
		if (line.signals.includes("unresolved")) found.push("unresolved_key");
		if (line.origin.kind === "evidence") {
			if (line.marks.some((mark) => mark.state === "gathered_only"))
				found.push("gathered_source");
			else if (change === undefined) found.push("removed");
		}
		return found;
	};
	// The file the change touched, as the project spells it: of the line's saved packages and
	// gathered paths, the first one in the list.
	const scope = textFileScope(input.files);
	const listedFile = (path: string) => scope?.keys.has(textFileKey(path)) ?? false;
	const lineFile = (line: LocalizationGateLine) => {
		const places = [
			...line.places.map((place) => place.packageFile),
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
		gathered_source: 0,
		partial_read: 0
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
	for (const read of input.partial ?? []) {
		checks.partial_read++;
		items.push({
			check: "partial_read",
			severity: failing.has("partial_read") ? "fail" : "warn",
			namespace: null,
			key: null,
			source: "",
			file: read.file,
			guidance: read.guidance
		});
	}
	const order = (item: LocalizationGateItem) =>
		(item.severity === "fail" ? 0 : LocalizationGateCheck.literals.length) +
		LocalizationGateCheck.literals.indexOf(item.check);
	items.sort((left, right) => order(left) - order(right));
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
 * Listed saved packages the scan could not read at all. Their text cannot be judged, so a verdict
 * that ignored them could pass new or conflicting text. A package read in part is checked and
 * listed by `localizationGatePartialPackages` instead; one Unreal's gather does not select
 * (`not_gatherable`) holds no text the target gathers, so there is nothing to judge, as in Unreal.
 */
export function localizationGateUnreadPackages(
	corpus: Pick<TextCorpus, "packageCoverage">,
	files: readonly string[]
): readonly string[] {
	const scope = textFileScope(files);
	if (scope === undefined) return [];
	return (corpus.packageCoverage ?? []).flatMap((coverage) =>
		coverage.status === "failed" && scope.keys.has(textFileKey(coverage.packageFile))
			? [`${textFileLabel(coverage.packageFile)} (${coverage.status})`]
			: []
	);
}

/**
 * Checks one target's lines in the changed files through an index model: one projected line read
 * and one file-scope count, in Rust, instead of the corpus and five line exports.
 */
export const indexedLocalizationGateTarget = Effect.fn("GameText.localizationGate")(function* (
	query: Pick<NativeTextQuery, "selectLocalizationLines" | "search">,
	input: {
		readonly join: Pick<LocalizationJoin, "target" | "nativeCulture">;
		readonly files: NonNullable<TextWhere["files"]>;
		readonly failOn: readonly LocalizationGateCheck[];
		readonly partial?: readonly LocalizationGatePartialRead[];
	}
) {
	const base = {
		query: "",
		capability: "all" as const,
		localization: { target: input.join.target },
		where: { files: input.files }
	};
	const lines = yield* query.selectLocalizationLines(base, LOCALIZATION_GATE_FIELDS);
	const page = yield* query.search({ ...base, pageSize: 1 });
	return localizationGateTarget({
		...input,
		lines,
		...(page.fileScope === undefined ? undefined : { fileScope: page.fileScope })
	});
});

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
