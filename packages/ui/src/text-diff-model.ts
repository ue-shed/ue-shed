/**
 * The model behind `TextDiff`: keyed texts on two sides, whatever they were read from. A
 * changelist's game text, two `.po` files or two `.archive` files all become entries, each a key
 * on either side and the fields compared under it.
 */

export type TextDiffKind = "added" | "removed" | "rekeyed" | "edited";

export const TEXT_DIFF_KINDS = [
	"added",
	"removed",
	"rekeyed",
	"edited"
] as const satisfies readonly TextDiffKind[];

export const TEXT_DIFF_KIND_LABELS = {
	added: "Added",
	removed: "Removed",
	rekeyed: "New key",
	edited: "Edited"
} as const satisfies Record<TextDiffKind, string>;

/** A key as people read it, and the exact key for a tooltip or a copy. */
export interface TextDiffKey {
	readonly label: string;
	readonly full: string;
}

/** One compared field: the source text, a culture's translation, the notes. */
export interface TextDiffField {
	/** "Source", "French", "Notes". */
	readonly label: string;
	/** Absent on the side that has no such text. */
	readonly before?: string;
	readonly after?: string;
	/** An identifier rather than prose, such as a key: shown in the code font. */
	readonly code?: boolean;
}

export interface TextDiffEntry {
	/** Stable within one diff. */
	readonly id: string;
	readonly kind: TextDiffKind;
	readonly before?: TextDiffKey;
	readonly after?: TextDiffKey;
	/** The file the entry is in: an asset, a `.po`, an `.archive`. Entries group by it. */
	readonly file: string;
	/** Where in the file, short ("WBP_Menu › Play › Text"), and in full for its tooltip. */
	readonly place?: string;
	readonly placeTitle?: string;
	/** The fields compared, the main text first. */
	readonly fields: readonly TextDiffField[];
}

/** A run of text on one side of a field, and whether only that side has it. */
export interface DiffSegment {
	readonly text: string;
	readonly op: "same" | "removed" | "added";
}

/** A field's two lines, word by word: `before` marks what went, `after` what came. */
export interface FieldDiff {
	readonly before: readonly DiffSegment[];
	readonly after: readonly DiffSegment[];
}

/** Past this many token pairs a field is shown whole on each side, not word by word. */
const MAX_TOKEN_PAIRS = 250_000;

const segmenter = new Intl.Segmenter(undefined, { granularity: "word" });

/** Words, spaces and punctuation in order; scripts without spaces split into words too. */
export function diffTokens(text: string): string[] {
	return Array.from(segmenter.segment(text), (part) => part.segment);
}

function merge(segments: DiffSegment[]): DiffSegment[] {
	const merged: DiffSegment[] = [];
	for (const segment of segments) {
		const last = merged.at(-1);
		if (last !== undefined && last.op === segment.op)
			merged[merged.length - 1] = { text: last.text + segment.text, op: last.op };
		else merged.push(segment);
	}
	return merged;
}

/**
 * The words two texts share and those only one has, by longest common subsequence over words.
 * A space between two changed words joins the change, so "a big red" → "a small blue" reads as one
 * replaced run rather than two.
 */
export function diffField(before: string, after: string): FieldDiff {
	if (before === after) {
		const same = before === "" ? [] : [{ text: before, op: "same" as const }];
		return { before: same, after: same };
	}
	const a = diffTokens(before);
	const b = diffTokens(after);
	if (a.length * b.length > MAX_TOKEN_PAIRS)
		return {
			before: before === "" ? [] : [{ text: before, op: "removed" }],
			after: after === "" ? [] : [{ text: after, op: "added" }]
		};
	// Common prefix and suffix first: most edits touch a few words of a line.
	let start = 0;
	while (start < a.length && start < b.length && a[start] === b[start]) start += 1;
	let endA = a.length;
	let endB = b.length;
	while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) {
		endA -= 1;
		endB -= 1;
	}
	const midA = a.slice(start, endA);
	const midB = b.slice(start, endB);
	const width = midB.length + 1;
	const lengths = new Uint32Array((midA.length + 1) * width);
	// The longest common run from (i, j) to the ends.
	const at = (i: number, j: number) => lengths[i * width + j] ?? 0;
	for (let i = midA.length - 1; i >= 0; i -= 1)
		for (let j = midB.length - 1; j >= 0; j -= 1)
			lengths[i * width + j] =
				midA[i] === midB[j] ? at(i + 1, j + 1) + 1 : Math.max(at(i + 1, j), at(i, j + 1));
	const left: DiffSegment[] = [];
	const right: DiffSegment[] = [];
	const shared = a.slice(0, start).join("");
	if (shared !== "") {
		left.push({ text: shared, op: "same" });
		right.push({ text: shared, op: "same" });
	}
	let i = 0;
	let j = 0;
	while (i < midA.length || j < midB.length) {
		const word = midA[i];
		const other = midB[j];
		if (word !== undefined && other !== undefined && word === other) {
			left.push({ text: word, op: "same" });
			right.push({ text: other, op: "same" });
			i += 1;
			j += 1;
		} else if (other !== undefined && (word === undefined || at(i, j + 1) >= at(i + 1, j))) {
			right.push({ text: other, op: "added" });
			j += 1;
		} else {
			left.push({ text: word ?? "", op: "removed" });
			i += 1;
		}
	}
	const tail = a.slice(endA).join("");
	if (tail !== "") {
		left.push({ text: tail, op: "same" });
		right.push({ text: tail, op: "same" });
	}
	return {
		before: merge(absorbSpaces(left, "removed")),
		after: merge(absorbSpaces(right, "added"))
	};
}

/** A lone space between two changed runs belongs to the change. */
function absorbSpaces(segments: DiffSegment[], op: "removed" | "added"): DiffSegment[] {
	return segments.map((segment, index) =>
		segment.op === "same" &&
		segment.text.trim() === "" &&
		segments[index - 1]?.op === op &&
		segments[index + 1]?.op === op
			? { text: segment.text, op }
			: segment
	);
}

/** Whether a field differs between the sides, counting a side that lacks it. */
export function fieldChanged(field: TextDiffField): boolean {
	return field.before !== field.after;
}

/** Entries whose key, place or text holds `query`, ignoring case. */
export function filterEntries(
	entries: readonly TextDiffEntry[],
	query: string
): readonly TextDiffEntry[] {
	const needle = query.trim().toLocaleLowerCase();
	if (needle === "") return entries;
	return entries.filter((entry) =>
		[
			entry.before?.full,
			entry.after?.full,
			entry.file,
			entry.place,
			...entry.fields.flatMap((field) => [field.before, field.after])
		].some((value) => value?.toLocaleLowerCase().includes(needle) === true)
	);
}

/** Entries by file, files in the order their first entry comes. */
export interface TextDiffFile {
	readonly file: string;
	readonly entries: readonly TextDiffEntry[];
}

export function groupByFile(entries: readonly TextDiffEntry[]): TextDiffFile[] {
	const files = new Map<string, TextDiffEntry[]>();
	for (const entry of entries) {
		const list = files.get(entry.file);
		if (list === undefined) files.set(entry.file, [entry]);
		else list.push(entry);
	}
	return [...files].map(([file, list]) => ({ file, entries: list }));
}
