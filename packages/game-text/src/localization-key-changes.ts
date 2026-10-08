import { Schema } from "effect";
import {
	LocalizationCarriedTranslation,
	LocalizationKeyChangeMatch,
	type LocalizationJoin,
	type LocalizationKeyChange,
	type LocalizationLine
} from "./localization-schema.js";
import { LocalizationIdentity } from "@ue-shed/localization/browser";
import { localizationShippedTranslation } from "./localization-shipped-translation.js";
import type { TextCorpus, TextLocation } from "./schema.js";
import { textFileKey } from "./text-origin.js";

/** A key that left Unreal's manifest, paired with the key that took its place. */
export const LocalizationKeyChangePair = Schema.Struct({
	from: LocalizationIdentity,
	to: LocalizationIdentity,
	match: LocalizationKeyChangeMatch,
	sourceChanged: Schema.Boolean,
	previousSource: Schema.String,
	translations: Schema.Array(LocalizationCarriedTranslation)
});
export type LocalizationKeyChangePair = typeof LocalizationKeyChangePair.Type;

export interface LocalizationKeyChanges {
	readonly pairs: readonly LocalizationKeyChangePair[];
	/** Changed keys left unpaired because more than one candidate matched. */
	readonly ambiguous: number;
}

/**
 * A saved place as Unreal's gatherer writes it: the object path, then the property chain.
 * Unreal writes dynamic array elements as `(n)` and the saved-package reader as `[n]`.
 */
function placeKey(path: string): string {
	return path
		.trim()
		.replaceAll("\\", "/")
		.toLowerCase()
		.replace(/\((\d+)\)/gu, "[$1]");
}

function occurrencePlace(location: TextLocation): string | undefined {
	switch (location.kind) {
		case "data_table_cell":
			return placeKey(`${location.objectPath}.${location.row}.${location.propertyPath}`);
		case "asset_property":
			return location.propertyPath === ""
				? undefined
				: placeKey(`${location.objectPath}.${location.propertyPath}`);
		case "string_table_entry":
			// The manifest names only the String Table, so an entry has no place of its own.
			return undefined;
	}
}

interface Candidate {
	readonly line: LocalizationLine;
	readonly places: readonly string[];
	readonly packages: readonly string[];
	readonly source: string;
}

const identityKey = (line: LocalizationLine) =>
	line.identity === null
		? undefined
		: JSON.stringify([line.identity.namespace, line.identity.key]);

const tiers: readonly (readonly [
	LocalizationKeyChangeMatch,
	(candidate: Candidate) => readonly string[]
])[] = [
	["same_place", (candidate) => candidate.places],
	[
		"same_text_in_package",
		(candidate) =>
			candidate.source === ""
				? []
				: candidate.packages.map((file) => `${file}\0${candidate.source}`)
	],
	["same_text", (candidate) => (candidate.source === "" ? [] : [candidate.source])]
];

function index(
	candidates: readonly Candidate[],
	keys: (candidate: Candidate) => readonly string[]
) {
	const byKey = new Map<string, Set<Candidate>>();
	for (const candidate of candidates)
		for (const key of keys(candidate))
			byKey.set(key, (byKey.get(key) ?? new Set()).add(candidate));
	return byKey;
}

function reachable(
	candidate: Candidate,
	keys: (candidate: Candidate) => readonly string[],
	byKey: ReadonlyMap<string, ReadonlySet<Candidate>>
): ReadonlySet<Candidate> {
	return new Set(keys(candidate).flatMap((key) => [...(byKey.get(key) ?? [])]));
}

/** The earlier key's translations that shipped, per non-native culture. */
function carriedTranslations(line: LocalizationLine, nativeCulture: string | null) {
	return line.cultures.flatMap((culture) => {
		if (culture.culture === nativeCulture) return [];
		const translation = localizationShippedTranslation(culture).value;
		return translation === null || translation === ""
			? []
			: [{ culture: culture.culture, translation }];
	});
}

/**
 * Pairs earlier keys with new keys strictly one to one, tier by tier. A pair forms only when the
 * tier's keys lead from the new key to exactly one earlier key and back to exactly that new key.
 */
function pair(
	earlier: readonly Candidate[],
	fresh: readonly Candidate[],
	nativeCulture: string | null
): LocalizationKeyChanges {
	let olds = [...earlier];
	let news = [...fresh];
	const pairs: LocalizationKeyChangePair[] = [];
	for (const [match, keys] of tiers) {
		const oldByKey = index(olds, keys);
		const newByKey = index(news, keys);
		const pairedOld = new Set<Candidate>();
		const pairedNew = new Set<Candidate>();
		for (const candidate of news) {
			const olderMatches = reachable(candidate, keys, oldByKey);
			if (olderMatches.size !== 1) continue;
			const [older] = olderMatches;
			if (older === undefined || pairedOld.has(older)) continue;
			const back = reachable(older, keys, newByKey);
			if (back.size !== 1 || !back.has(candidate)) continue;
			if (older.line.identity === null || candidate.line.identity === null) continue;
			pairedOld.add(older);
			pairedNew.add(candidate);
			pairs.push({
				from: older.line.identity,
				to: candidate.line.identity,
				match,
				sourceChanged: older.source !== candidate.source,
				previousSource: older.source,
				translations: carriedTranslations(older.line, nativeCulture)
			});
		}
		olds = olds.filter((candidate) => !pairedOld.has(candidate));
		news = news.filter((candidate) => !pairedNew.has(candidate));
	}
	const ambiguous = news.filter((candidate) =>
		tiers.some(([, keys]) => reachable(candidate, keys, index(olds, keys)).size > 0)
	).length;
	return { pairs, ambiguous };
}

function manifestCandidate(line: LocalizationLine): Candidate {
	return {
		line,
		places: line.manifest.map((entry) => placeKey(entry.path)),
		packages: line.manifest.map((entry) => textFileKey(entry.path)),
		source: line.manifest[0]?.source.Text ?? line.source
	};
}

const hasState = (line: LocalizationLine, state: string) =>
	line.cultures.some((culture) => culture.state === state);

/**
 * Before a gather: asset text whose key changed in a saved package. The earlier key is still in
 * the manifest but no longer saved anywhere scanned (`not_found`); the new key is saved but not
 * gathered yet (`not_gathered`). C++ and config text is not in the saved scan, so it is paired
 * across a gather instead.
 */
export function localizationKeyChanges(
	join: LocalizationJoin,
	corpus: TextCorpus
): LocalizationKeyChanges {
	const units = new Map(corpus.units.map((unit) => [unit.id, unit]));
	const earlier = join.lines
		.filter(
			(line) =>
				line.origin.kind === "evidence" &&
				line.identity !== null &&
				hasState(line, "not_found")
		)
		.map(manifestCandidate);
	const fresh = join.lines.flatMap((line): Candidate[] => {
		if (line.origin.kind !== "corpus" || line.identity === null) return [];
		if (!hasState(line, "not_gathered")) return [];
		const occurrences = line.origin.unitIds.flatMap((id) => units.get(id)?.occurrences ?? []);
		return [
			{
				line,
				places: occurrences.flatMap((occurrence) => {
					const place = occurrencePlace(occurrence.location);
					return place === undefined ? [] : [place];
				}),
				packages: occurrences.map((occurrence) => textFileKey(occurrence.packageFile)),
				source: line.source
			}
		];
	});
	return pair(earlier, fresh, join.nativeCulture);
}

/**
 * Across a gather UE Shed ran: keys that left the manifest paired with keys that joined it, for
 * any gathered text including C++ and config. Translations come from `before`, the evidence read
 * before Unreal trimmed the archives.
 */
export function localizationKeyChangesAcross(
	before: LocalizationJoin,
	after: LocalizationJoin
): LocalizationKeyChanges {
	const gathered = (join: LocalizationJoin) =>
		join.lines.filter((line) => line.identity !== null && line.manifest.length > 0);
	const beforeKeys = new Set(gathered(before).map(identityKey));
	const afterKeys = new Set(gathered(after).map(identityKey));
	return pair(
		gathered(before)
			.filter((line) => !afterKeys.has(identityKey(line)))
			.map(manifestCandidate),
		gathered(after)
			.filter((line) => !beforeKeys.has(identityKey(line)))
			.map(manifestCandidate),
		before.nativeCulture
	);
}

/** Marks both lines of every pair; a pair whose earlier key is gone marks only the new key. */
export function applyLocalizationKeyChanges(
	join: LocalizationJoin,
	pairs: readonly LocalizationKeyChangePair[]
): LocalizationJoin {
	if (pairs.length === 0) return join;
	const key = (identity: LocalizationKeyChangePair["from"]) =>
		JSON.stringify([identity.namespace, identity.key]);
	const changes = new Map<string, LocalizationKeyChange>();
	for (const item of pairs) {
		const shared = {
			match: item.match,
			sourceChanged: item.sourceChanged,
			previousSource: item.previousSource,
			translations: item.translations
		};
		changes.set(key(item.to), { direction: "to", other: item.from, ...shared });
		changes.set(key(item.from), { direction: "from", other: item.to, ...shared });
	}
	return {
		...join,
		lines: join.lines.map((line) => {
			const change = line.identity === null ? undefined : changes.get(key(line.identity));
			return change === undefined ? line : { ...line, keyChange: change };
		})
	};
}
