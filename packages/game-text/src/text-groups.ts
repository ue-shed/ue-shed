import type { LocalizationCultureMark } from "./localization-schema.js";
import {
	MAX_TEXT_GROUPS,
	TextProblem,
	type TextCultureFacet,
	type TextGroup,
	type TextGroupBy,
	type TextGroupList
} from "./schema.js";
import {
	TEXT_ORIGIN_KINDS,
	TEXT_ORIGIN_LABELS,
	normalizeTextPath,
	textFileKey,
	textFolderLabel
} from "./text-origin.js";
import { TEXT_PROBLEM_LABELS, needsWork, type TextFacts } from "./text-problems.js";

interface Placed {
	readonly key: string;
	readonly label: string;
}

/** The group a line falls in: its worst problem, first file's folder or file, origin or namespace. */
export function textGroupOf(facts: TextFacts, by: TextGroupBy): Placed {
	switch (by) {
		case "problem": {
			const worst = facts.problems[0] ?? "up_to_date";
			return { key: worst, label: TEXT_PROBLEM_LABELS[worst] };
		}
		case "folder": {
			const file = facts.files[0];
			const folder = file === undefined ? "" : textFolderLabel(file);
			return { key: normalizeTextPath(folder), label: folder };
		}
		case "asset": {
			const file = facts.files[0] ?? "";
			return { key: textFileKey(file), label: file };
		}
		case "origin": {
			const origin = TEXT_ORIGIN_KINDS.find((kind) => facts.origins.includes(kind));
			return origin === undefined
				? { key: "", label: "" }
				: { key: origin, label: TEXT_ORIGIN_LABELS[origin] };
		}
		case "namespace": {
			const namespace = facts.namespace ?? "";
			return { key: namespace, label: namespace };
		}
	}
}

interface Tally {
	key: string;
	label: string;
	count: number;
	needWork: number;
	worst: number;
}

class Tallies {
	readonly #byKey = new Map<string, Tally>();

	add(place: Placed, facts: TextFacts) {
		const tally = this.#byKey.get(place.key) ?? {
			key: place.key,
			label: place.label,
			count: 0,
			needWork: 0,
			worst: TextProblem.literals.length
		};
		tally.count++;
		if (needsWork(facts.problems)) tally.needWork++;
		const worst = TextProblem.literals.indexOf(facts.problems[0] ?? "up_to_date");
		if (worst < tally.worst) tally.worst = worst;
		this.#byKey.set(place.key, tally);
	}

	/** Worst first, then most lines needing work, then most lines, then by label. */
	list(max = MAX_TEXT_GROUPS): TextGroupList {
		const sorted = [...this.#byKey.values()].sort(
			(left, right) =>
				left.worst - right.worst ||
				right.needWork - left.needWork ||
				right.count - left.count ||
				(left.label < right.label ? -1 : left.label > right.label ? 1 : 0)
		);
		const entries = sorted.slice(0, max).map(
			(tally): TextGroup => ({
				key: tally.key,
				label: tally.label,
				count: tally.count,
				needWork: tally.needWork,
				worst: TextProblem.literals[tally.worst] ?? "up_to_date"
			})
		);
		return { entries, more: Math.max(0, sorted.length - entries.length) };
	}
}

/** Every group of the given lines. */
export function textGroups(facts: Iterable<TextFacts>, by: TextGroupBy): TextGroupList {
	const tallies = new Tallies();
	for (const item of facts) tallies.add(textGroupOf(item, by), item);
	return tallies.list();
}

/**
 * The folders directly under `under` (normalized; empty for the top folders), each counting the
 * lines anywhere inside it once.
 */
export function textFolderFacet(facts: Iterable<TextFacts>, under: string): TextGroupList {
	const parent = normalizeTextPath(under).replace(/\/+$/u, "");
	const depth = parent === "" ? 1 : parent.split("/").length + 1;
	const tallies = new Tallies();
	for (const item of facts) {
		const children = new Map<string, string>();
		for (const file of item.files) {
			const folder = textFolderLabel(file);
			const key = normalizeTextPath(folder);
			if (parent !== "" && !key.startsWith(parent + "/")) continue;
			const segments = folder.split("/");
			if (segments.length < depth) continue;
			const label = segments.slice(0, depth).join("/");
			children.set(normalizeTextPath(label), label);
		}
		for (const [key, label] of children) tallies.add({ key, label }, item);
	}
	return tallies.list();
}

/** The files holding the lines, each counting its lines once. */
export function textAssetFacet(facts: Iterable<TextFacts>): TextGroupList {
	const tallies = new Tallies();
	for (const item of facts) {
		const files = new Map(item.files.map((file) => [textFileKey(file), file]));
		for (const [key, label] of files) tallies.add({ key, label }, item);
	}
	return tallies.list();
}

/** Where the lines come from; a line with several origins counts in each. */
export function textOriginFacet(facts: Iterable<TextFacts>): TextGroupList {
	const tallies = new Tallies();
	for (const item of facts)
		for (const origin of item.origins)
			tallies.add({ key: origin, label: TEXT_ORIGIN_LABELS[origin] }, item);
	return tallies.list();
}

/** Each culture's translation work over the given lines' marks, worst culture first. */
export function textCultureFacet(
	lines: Iterable<readonly LocalizationCultureMark[]>,
	cultures: readonly string[]
): readonly TextCultureFacet[] {
	const facets = new Map(
		cultures.map((culture) => [
			culture,
			{ culture, lines: 0, shipped: 0, missing: 0, toUpdate: 0, notSynced: 0 }
		])
	);
	for (const marks of lines)
		for (const mark of marks) {
			const facet = facets.get(mark.culture);
			if (!facet) continue;
			facet.lines++;
			if (mark.state === "translated") facet.shipped++;
			if (mark.state === "not_translated") facet.missing++;
			if (mark.state === "needs_update") facet.toUpdate++;
			if (mark.state === "not_synced" || mark.facts.includes("not_synced")) facet.notSynced++;
		}
	return [...facets.values()].sort(
		(left, right) =>
			right.missing + right.toUpdate - (left.missing + left.toUpdate) ||
			(left.culture < right.culture ? -1 : left.culture > right.culture ? 1 : 0)
	);
}
