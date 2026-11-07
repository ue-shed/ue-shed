import { Schema } from "effect";
import { localizationLineUnits } from "./gathered-text.js";
import { LocalizationCarriedTranslation, LocalizationKeyChangeMatch } from "./localization-schema.js";
import { LocalizationIdentity } from "@ue-shed/localization/browser";
import { localizationShippedTranslation } from "./localization-shipped-translation.js";
import { textFileKey } from "./text-origin.js";
/** The line fields that pair keys across a gather, with the translations the earlier keys had. */
export const KEY_CHANGE_FIELDS = ["identity", "source", "manifest", "marks"];
/** A key that left Unreal's manifest, paired with the key that took its place. */
export const LocalizationKeyChangePair = Schema.Struct({
    from: LocalizationIdentity,
    to: LocalizationIdentity,
    match: LocalizationKeyChangeMatch,
    sourceChanged: Schema.Boolean,
    previousSource: Schema.String,
    translations: Schema.Array(LocalizationCarriedTranslation)
});
/**
 * A saved place as Unreal's gatherer writes it: the object path, then the property chain.
 * Unreal writes dynamic array elements as `(n)` and the saved-package reader as `[n]`.
 */
function placeKey(path) {
    return path
        .trim()
        .replaceAll("\\", "/")
        .toLowerCase()
        .replace(/\((\d+)\)/gu, "[$1]");
}
/**
 * The place a gathered manifest path names, when it names one line of text: an object path with
 * its property chain, or a source file with its line. A String Table's manifest path is the table
 * alone, shared by every entry, so it is no place.
 */
export function manifestPlace(path) {
    const place = placeKey(path);
    if (place.startsWith("/"))
        return /^\/[^.]+\.[^.:]+[.:].+/u.test(place) ? place : undefined;
    // 4.27 writes a source line as `file:12`, 5.x as `file(12)`; both are `file[12]`.
    return /(?:\[\d+\]|:\d+)$/u.test(place) ? place.replace(/:(\d+)$/u, "[$1]") : undefined;
}
function occurrencePlace(location) {
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
        case "code_place":
            return location.line === undefined
                ? undefined
                : placeKey(`${location.file}(${location.line})`);
    }
}
/** How many lines carry each text on one side of a comparison. */
function textCounts(sources) {
    const counts = new Map();
    for (const source of sources)
        counts.set(source, (counts.get(source) ?? 0) + 1);
    return counts;
}
const manifestSource = (line) => line.manifest[0]?.source.Text ?? line.source;
const textKeys = (candidate) => (candidate.source === "" ? [] : [candidate.source]);
const identityKey = (line) => line.identity === null
    ? undefined
    : JSON.stringify([line.identity.namespace, line.identity.key]);
/**
 * Each tier's keys for pairing, and the looser keys that count a new key as ambiguous when it
 * matched an earlier key but could not pair. Text alone pairs only when it names one line on
 * each side, so text an unchanged line also has never moves a translation.
 */
const tiers = [
    ["same_place", (candidate) => candidate.places, (candidate) => candidate.places],
    [
        "same_text_in_package",
        (candidate) => candidate.source === ""
            ? []
            : candidate.packages.map((file) => `${file}\0${candidate.source}`),
        (candidate) => candidate.source === ""
            ? []
            : candidate.packages.map((file) => `${file}\0${candidate.source}`)
    ],
    ["same_text", (candidate) => (candidate.unique ? textKeys(candidate) : []), textKeys]
];
function index(candidates, keys) {
    const byKey = new Map();
    for (const candidate of candidates)
        for (const key of keys(candidate))
            byKey.set(key, (byKey.get(key) ?? new Set()).add(candidate));
    return byKey;
}
function reachable(candidate, keys, byKey) {
    return new Set(keys(candidate).flatMap((key) => [...(byKey.get(key) ?? [])]));
}
/** The earlier key's translations that shipped, per non-native culture. */
function carriedTranslations(line, nativeCulture) {
    if (line.marks)
        return line.marks.flatMap((mark) => mark.culture === nativeCulture || mark.translation === null || mark.translation === ""
            ? []
            : [{ culture: mark.culture, translation: mark.translation }]);
    return (line.cultures ?? []).flatMap((culture) => {
        if (culture.culture === nativeCulture)
            return [];
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
function pair(earlier, fresh, nativeCulture) {
    let olds = [...earlier];
    let news = [...fresh];
    const pairs = [];
    for (const [match, keys] of tiers) {
        const oldByKey = index(olds, keys);
        const newByKey = index(news, keys);
        const pairedOld = new Set();
        const pairedNew = new Set();
        for (const candidate of news) {
            const olderMatches = reachable(candidate, keys, oldByKey);
            if (olderMatches.size !== 1)
                continue;
            const [older] = olderMatches;
            if (older === undefined || pairedOld.has(older))
                continue;
            const back = reachable(older, keys, newByKey);
            if (back.size !== 1 || !back.has(candidate))
                continue;
            if (older.line.identity === null || candidate.line.identity === null)
                continue;
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
    // Each tier's index over the earlier keys left, built once rather than per new key.
    const remaining = tiers.map(([, , loose]) => [loose, index(olds, loose)]);
    const ambiguous = news.filter((candidate) => remaining.some(([loose, byKey]) => reachable(candidate, loose, byKey).size > 0)).length;
    return { pairs, ambiguous };
}
function manifestCandidate(texts) {
    return (line) => {
        const source = manifestSource(line);
        return {
            line,
            places: line.manifest.flatMap((entry) => {
                const place = manifestPlace(entry.path);
                return place === undefined ? [] : [place];
            }),
            packages: line.manifest.map((entry) => textFileKey(entry.path)),
            source,
            unique: texts.get(source) === 1
        };
    };
}
const hasState = (line, state) => line.cultures.some((culture) => culture.state === state);
/**
 * Before a gather: asset text whose key changed in a saved package. The earlier key is still in
 * the manifest but no longer saved anywhere scanned (`not_found`); the new key is saved but not
 * gathered yet (`not_gathered`). C++ and config text is not in the saved scan, so it is paired
 * across a gather instead.
 */
export function localizationKeyChanges(join, corpus) {
    const units = new Map(corpus.units.map((unit) => [unit.id, unit]));
    // Text uniqueness counts every gathered line, and every saved line.
    const gatheredTexts = textCounts(join.lines.filter((line) => line.manifest.length > 0).map(manifestSource));
    const savedTexts = textCounts(join.lines.filter((line) => line.origin.kind === "corpus").map((line) => line.source));
    const earlier = join.lines
        .filter((line) => line.origin.kind === "evidence" &&
        line.identity !== null &&
        hasState(line, "not_found"))
        .map(manifestCandidate(gatheredTexts));
    const fresh = join.lines.flatMap((line) => {
        if (line.origin.kind !== "corpus" || line.identity === null)
            return [];
        if (!hasState(line, "not_gathered"))
            return [];
        const occurrences = localizationLineUnits(line, units).flatMap((unit) => unit.occurrences);
        return [
            {
                line,
                places: occurrences.flatMap((occurrence) => {
                    const place = occurrencePlace(occurrence.location);
                    return place === undefined ? [] : [place];
                }),
                packages: occurrences.map((occurrence) => textFileKey(occurrence.packageFile)),
                source: line.source,
                unique: savedTexts.get(line.source) === 1
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
export function localizationKeyChangesAcross(before, after) {
    const gathered = (join) => join.lines.filter((line) => line.identity !== null && line.manifest.length > 0);
    const beforeKeys = new Set(gathered(before).map(identityKey));
    const afterKeys = new Set(gathered(after).map(identityKey));
    return pair(gathered(before)
        .filter((line) => !afterKeys.has(identityKey(line)))
        .map(manifestCandidate(textCounts(gathered(before).map(manifestSource)))), gathered(after)
        .filter((line) => !beforeKeys.has(identityKey(line)))
        .map(manifestCandidate(textCounts(gathered(after).map(manifestSource)))), before.nativeCulture);
}
/**
 * The translations of keys that changed in a gather, as change-set entries for the new keys,
 * ready for `LocalizationChangeSet`. Pairs whose text changed too are left out: those
 * translations were written for the earlier text. Proposals record `previousTranslation: null`,
 * so applying them revalidates that the new key is still untranslated.
 */
export function localizationCarryChanges(before, after) {
    const { pairs, ambiguous } = localizationKeyChangesAcross(before, after);
    const sources = new Map(after.lines.flatMap((line) => line.identity === null
        ? []
        : [
            [
                JSON.stringify([line.identity.namespace, line.identity.key]),
                line.manifest[0]?.source.Text
            ]
        ]));
    const carried = pairs.filter((item) => !item.sourceChanged);
    const changes = carried.flatMap((item) => {
        const source = sources.get(JSON.stringify([item.to.namespace, item.to.key]));
        return source === undefined
            ? []
            : item.translations.map((translation) => ({
                target: after.target,
                culture: translation.culture,
                namespace: item.to.namespace,
                key: item.to.key,
                source,
                previousTranslation: null,
                translation: translation.translation
            }));
    });
    return { changes, keys: carried.length, textChanged: pairs.length - carried.length, ambiguous };
}
/** Pairs from several sources; the first pair for a new key wins, and each key pairs once. */
export function mergeLocalizationKeyChanges(...sources) {
    const key = (identity) => JSON.stringify([identity.namespace, identity.key]);
    const used = new Set();
    return sources.flat().filter((item) => {
        if (used.has(key(item.to)) || used.has(key(item.from)))
            return false;
        used.add(key(item.to));
        used.add(key(item.from));
        return true;
    });
}
/** Marks both lines of every pair; a pair whose earlier key is gone marks only the new key. */
export function applyLocalizationKeyChanges(join, pairs) {
    if (pairs.length === 0)
        return join;
    const key = (identity) => JSON.stringify([identity.namespace, identity.key]);
    const changes = new Map();
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
