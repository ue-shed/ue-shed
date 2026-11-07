/**
 * Text that is fine to repeat under many keys: numbers, punctuation, symbols, format arguments
 * and markup, or a single letter.
 */
function isTrivialText(text) {
    const stripped = text.replace(/\{[^{}]*\}/gu, "").replace(/<[^<>]*>/gu, "");
    return (stripped.match(/\p{L}/gu)?.length ?? 0) < 2;
}
/** Levenshtein distance, giving up past `limit` (returns `limit + 1`). */
function editDistance(a, b, limit = Number.POSITIVE_INFINITY) {
    if (a === b)
        return 0;
    if (Math.abs(a.length - b.length) > limit)
        return limit + 1;
    if (a.length === 0)
        return b.length;
    if (b.length === 0)
        return a.length;
    let previous = Array.from({ length: b.length + 1 }, (_, index) => index);
    for (let i = 1; i <= a.length; i++) {
        const current = [i];
        let best = i;
        for (let j = 1; j <= b.length; j++) {
            const cost = a.charCodeAt(i - 1) === b.charCodeAt(j - 1) ? 0 : 1;
            const value = Math.min((previous[j] ?? 0) + 1, (current[j - 1] ?? 0) + 1, (previous[j - 1] ?? 0) + cost);
            current.push(value);
            if (value < best)
                best = value;
        }
        if (best > limit)
            return limit + 1;
        previous = current;
    }
    return previous[b.length] ?? 0;
}
/** How many characters a small edit may change in a text this long. */
function similarityLimit(a, b) {
    return Math.min(12, Math.max(1, Math.floor(Math.max(a.length, b.length) * 0.2)));
}
/** Text compared for a small edit: whitespace runs collapsed, case folded. */
const comparable = (text) => text.replace(/\s+/gu, " ").trim().toLocaleLowerCase();
/** Comparisons the cross-package pass may make before it stops. */
const MAX_COMPARISONS = 2_000_000;
/**
 * Pairs keys that left the manifest with new keys whose text is nearly the same. Strictly one to
 * one: a new key pairs only when exactly one earlier key is nearest, and that earlier key's
 * nearest is this new key. Same-package candidates are tried first; across packages only while
 * the work stays bounded.
 */
export function referenceSimilarKeyChanges(earlier, fresh) {
    const usable = (line) => line.identity !== null && !isTrivialText(line.source) && line.source.trim() !== "";
    const olds = earlier.filter(usable);
    const news = fresh.filter(usable);
    const text = new Map([...olds, ...news].map((line) => [line, comparable(line.source)]));
    const byPackage = new Map();
    for (const line of olds)
        for (const file of new Set(line.packages)) {
            const list = byPackage.get(file);
            if (list === undefined)
                byPackage.set(file, [line]);
            else
                list.push(line);
        }
    const byLength = olds.toSorted((a, b) => (text.get(a)?.length ?? 0) - (text.get(b)?.length ?? 0));
    let comparisons = 0;
    let truncated = false;
    const nearest = (line, pool) => {
        const own = text.get(line) ?? "";
        let best = [];
        for (const other of pool) {
            const theirs = text.get(other) ?? "";
            const limit = similarityLimit(own, theirs);
            if (Math.abs(own.length - theirs.length) > limit)
                continue;
            comparisons++;
            const distance = editDistance(own, theirs, limit);
            if (distance > limit)
                continue;
            if (best.length === 0 || distance < (best[0]?.distance ?? 0))
                best = [{ line: other, distance }];
            else if (distance === best[0]?.distance && !best.some((item) => item.line === other))
                best.push({ line: other, distance });
        }
        return best;
    };
    const window = (line) => {
        const length = text.get(line)?.length ?? 0;
        const reach = Math.min(12, Math.max(1, Math.ceil(length * 0.25)));
        return byLength.filter((other) => Math.abs((text.get(other)?.length ?? 0) - length) <= reach);
    };
    const proposals = [];
    for (const line of news) {
        const local = new Set(line.packages.flatMap((file) => byPackage.get(file) ?? []));
        let best = nearest(line, local);
        if (best.length === 0) {
            if (comparisons > MAX_COMPARISONS) {
                truncated = true;
                continue;
            }
            best = nearest(line, window(line));
        }
        const only = best.length === 1 ? best[0] : undefined;
        if (only !== undefined)
            proposals.push({ from: only.line, to: line, distance: only.distance });
    }
    // Each earlier key pairs once, with its single nearest new key.
    const byOld = new Map();
    for (const proposal of proposals) {
        const list = byOld.get(proposal.from);
        if (list === undefined)
            byOld.set(proposal.from, [proposal]);
        else
            list.push(proposal);
    }
    const pairs = [];
    for (const list of byOld.values()) {
        const sorted = list.toSorted((a, b) => a.distance - b.distance);
        const [first, second] = sorted;
        if (first === undefined || (second !== undefined && second.distance === first.distance))
            continue;
        pairs.push({ from: first.from, to: first.to, distance: first.distance });
    }
    return { pairs, truncated };
}
/** mulberry32: a small seeded generator, so a failing corpus can be generated again. */
function random(seed) {
    let state = seed >>> 0;
    return () => {
        state = (state + 0x6d2b79f5) >>> 0;
        let value = state;
        value = Math.imul(value ^ (value >>> 15), value | 1);
        value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
        return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
    };
}
const WORDS = [
    "open",
    "the",
    "door",
    "golden",
    "key",
    "collect",
    "reward",
    "receive",
    "quest",
    "map",
    "shield",
    "sword",
    "village",
    "north",
    "gate",
    "fire",
    "water",
    "light",
    "shadow",
    "stone",
    "river",
    "bridge",
    "merchant",
    "potion",
    "armor",
    "castle",
    "forest",
    "hidden",
    "ancient",
    "café",
    "naïve",
    "über",
    "{Count}",
    "<b>",
    "🔥"
];
const TRIVIAL = ["{0}", "{Count} x", "<b>{0}</>", "42", "?!", "A"];
const LETTERS = "abcdefghijklmnopqrstuvwxyzéü🔥 ";
/**
 * A seeded target: `earlier` keys only the manifest has, each gathered from one package, and
 * `fresh` keys only packages save. About 60% of the new keys are small edits of an earlier key's
 * text (some exact copies, which the join's exact tiers pair, and some edits of the same earlier
 * key, which tie), the rest unrelated; a few texts on each side are trivial.
 */
export function similarKeysCorpus(options) {
    const next = random(options.seed);
    const pick = (items) => {
        const item = items[Math.floor(next() * items.length)];
        if (item === undefined)
            throw new Error("Nothing to pick from.");
        return item;
    };
    const namespace = options.namespace ?? "UI";
    const count = options.packages.length;
    /** A package's object path: `Content/UI/Menu.uasset` is `/Game/UI/Menu.Menu`. */
    const object = (index) => {
        const path = (options.packages[index] ?? "")
            .replace(/^Content\//u, "")
            .replace(/\.uasset$/u, "");
        return `/Game/${path}.${path.slice(path.lastIndexOf("/") + 1)}`;
    };
    const phrase = () => {
        const words = Array.from({ length: 2 + Math.floor(next() * 6) }, () => pick(WORDS));
        const text = words.join(" ");
        return next() < 0.5 ? text[0]?.toUpperCase() + text.slice(1) : text;
    };
    /** One to three edits by code point, so no edit splits a surrogate pair. */
    const edit = (text) => {
        const points = Array.from(text);
        for (let count = 1 + Math.floor(next() * 3); count > 0; count--) {
            const at = Math.floor(next() * Math.max(1, points.length));
            const kind = next();
            if (kind < 0.25 && points.length > 3)
                points.splice(at, 1);
            else if (kind < 0.5)
                points.splice(at, 0, pick(Array.from(LETTERS)));
            else if (kind < 0.7)
                points[at] = pick(Array.from(LETTERS));
            else if (kind < 0.85)
                points[at] = (points[at] ?? "").toUpperCase();
            else
                points.splice(at, 0, " \t");
        }
        return points.join("");
    };
    const earlier = Array.from({ length: options.earlier }, (_, index) => ({
        key: `Old${index}`,
        source: next() < 0.03 ? pick(TRIVIAL) : phrase(),
        package: Math.floor(next() * count)
    }));
    const fresh = Array.from({ length: options.fresh }, (_, index) => {
        const derived = next() < 0.6;
        const base = derived ? pick(earlier) : undefined;
        const source = next() < 0.03
            ? pick(TRIVIAL)
            : base === undefined
                ? phrase()
                : next() < 0.06
                    ? base.source
                    : edit(base.source);
        const home = base !== undefined && next() < 0.5 ? base.package : Math.floor(next() * count);
        const packages = next() < 0.1 ? [home, (home + 1) % count] : [home];
        return { key: `New${index}`, source, packages };
    });
    /** The manifest's children for the earlier keys, each gathered from its package. */
    const children = earlier.map((line) => ({
        Source: { Text: line.source },
        Keys: [{ Key: line.key, Path: `${object(line.package)}.${line.key}` }]
    }));
    /** The archive's children for the earlier keys; German translates them. */
    const archiveChildren = (culture) => earlier.map((line) => ({
        Key: line.key,
        Source: { Text: line.source },
        Translation: { Text: culture === "de" ? `DE ${line.source}` : line.source }
    }));
    const occurrences = Array.from({ length: count }, () => []);
    const packagesOf = new Map();
    for (const line of fresh)
        for (const index of line.packages) {
            occurrences[index]?.push({
                source: line.source,
                dev_notes: "",
                identity: { status: "resolved", namespace, key: line.key },
                location: {
                    kind: "asset_property",
                    object_path: object(index),
                    class_path: "/Script/Engine.DataAsset",
                    property_path: line.key
                },
                edit_capability: "read_only"
            });
            const paths = packagesOf.get(line.key) ?? [];
            paths.push(options.packages[index] ?? "");
            packagesOf.set(line.key, paths);
        }
    return {
        earlier,
        fresh,
        children,
        archiveChildren,
        manifest: JSON.stringify({ FormatVersion: 1, Namespace: namespace, Children: children }),
        archive: (culture) => JSON.stringify({
            FormatVersion: 2,
            Namespace: namespace,
            Children: archiveChildren(culture)
        }),
        /** Every package with the new keys it saves, as the fixture's `addPackages` takes them. */
        packages: occurrences.map((items, index) => ({
            path: options.packages[index] ?? "",
            occurrences: items
        })),
        /** Each new key's saved packages, project-relative. */
        packagesOf
    };
}
/**
 * The reference's lines for a corpus, without an index: what a host would read for its earlier
 * and new keys if none of them were paired exactly and every package were scanned.
 */
export function similarKeysReferenceLines(corpus) {
    const namespace = "UI";
    return {
        olds: corpus.earlier.map((line) => ({
            id: line.key,
            identity: { namespace, key: line.key },
            source: line.source,
            packages: [String(line.package)]
        })),
        news: corpus.fresh.map((line) => ({
            id: line.key,
            identity: { namespace, key: line.key },
            source: line.source,
            packages: line.packages.map(String)
        }))
    };
}
