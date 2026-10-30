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
	/**
	 * Shown even when it did not change, as context: a translation under a changed source, which
	 * the reader has to check.
	 */
	readonly context?: boolean;
	/** What the field's state means, beside its label: "made for the old source". */
	readonly note?: string;
	/** Detail an added or removed entry folds away, such as notes and references. */
	readonly secondary?: boolean;
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
	/** The section the entry is listed in, when the diff has sections. */
	readonly group?: string;
	/** One line under the entry's first, saying what the change means. */
	readonly note?: string;
}

/**
 * What a section's colour says: red and green for text that went and came, amber for text whose
 * translation needs attention, blue for other changes, grey for changes most readers can skip.
 */
export type TextDiffTone = "added" | "removed" | "attention" | "changed" | "quiet";

/** The tone each kind of entry has when a diff lists entries by file, not in groups. */
export const TEXT_DIFF_KIND_TONES = {
	added: "added",
	removed: "removed",
	rekeyed: "attention",
	edited: "changed"
} as const satisfies Record<TextDiffKind, TextDiffTone>;

/**
 * A section of a diff: entries of one consequence, such as text moved to a new key. Its tone
 * colours its entries; `count` is of every entry in it, loaded or not.
 */
export interface TextDiffGroup {
	readonly id: string;
	readonly label: string;
	readonly tone: TextDiffTone;
	readonly count: number;
	/** Of `count`, those the text filter lists, when a text filter is on. */
	readonly listed?: number;
	/** What the section means for the reader, under its heading. */
	readonly description?: string;
	/** Starts folded, for changes most readers skip, such as notes only. */
	readonly folded?: boolean;
}

/** Which entries a diff lists: one kind or section, and text. */
export interface TextDiffFilter {
	readonly kind?: string;
	readonly query: string;
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
	// One list of runs in reading order: shared, then what went and what came between them.
	const runs: DiffSegment[] = [];
	const shared = a.slice(0, start).join("");
	if (shared !== "") runs.push({ text: shared, op: "same" });
	let i = 0;
	let j = 0;
	while (i < midA.length || j < midB.length) {
		const word = midA[i];
		const other = midB[j];
		if (word !== undefined && other !== undefined && word === other) {
			runs.push({ text: word, op: "same" });
			i += 1;
			j += 1;
		} else if (other !== undefined && (word === undefined || at(i, j + 1) >= at(i + 1, j))) {
			runs.push({ text: other, op: "added" });
			j += 1;
		} else {
			runs.push({ text: word ?? "", op: "removed" });
			i += 1;
		}
	}
	const tail = a.slice(endA).join("");
	if (tail !== "") runs.push({ text: tail, op: "same" });
	const refined = refineWords(merge(absorbRuns(runs)));
	return {
		before: merge(refined.filter((run) => run.op !== "added")),
		after: merge(refined.filter((run) => run.op !== "removed"))
	};
}

/** Past this many characters on a side, a replaced run is not compared letter by letter. */
const MAX_REFINED_CHARACTERS = 200;

/**
 * A word replaced by a word that shares most of its letters ("It's" by "It’s", "0 %" by "0%")
 * marks only the letters that differ, so a changed apostrophe or a dropped space shows.
 */
function refineWords(runs: DiffSegment[]): DiffSegment[] {
	const refined: DiffSegment[] = [];
	for (let index = 0; index < runs.length; index += 1) {
		const run = runs[index];
		const next = runs[index + 1];
		if (
			run?.op === "removed" &&
			next?.op === "added" &&
			run.text.length <= MAX_REFINED_CHARACTERS &&
			next.text.length <= MAX_REFINED_CHARACTERS
		) {
			const letters = diffCharacters(run.text, next.text);
			const kept = letters
				.filter((letter) => letter.op === "same")
				.reduce((sum, letter) => sum + letter.text.length, 0);
			// Letters help only when most of the run stays; otherwise the whole word reads better.
			if (kept * 2 >= Math.max(run.text.length, next.text.length)) {
				refined.push(...letters);
				index += 1;
				continue;
			}
		}
		if (run !== undefined) refined.push(run);
	}
	return refined;
}

function diffCharacters(before: string, after: string): DiffSegment[] {
	const a = Array.from(before);
	const b = Array.from(after);
	const width = b.length + 1;
	const lengths = new Uint16Array((a.length + 1) * width);
	const at = (i: number, j: number) => lengths[i * width + j] ?? 0;
	for (let i = a.length - 1; i >= 0; i -= 1)
		for (let j = b.length - 1; j >= 0; j -= 1)
			lengths[i * width + j] =
				a[i] === b[j] ? at(i + 1, j + 1) + 1 : Math.max(at(i + 1, j), at(i, j + 1));
	const letters: DiffSegment[] = [];
	let i = 0;
	let j = 0;
	while (i < a.length || j < b.length) {
		const letter = a[i];
		const other = b[j];
		if (letter !== undefined && letter === other) {
			letters.push({ text: letter, op: "same" });
			i += 1;
			j += 1;
		} else if (other !== undefined && (letter === undefined || at(i, j + 1) >= at(i + 1, j))) {
			letters.push({ text: other, op: "added" });
			j += 1;
		} else {
			letters.push({ text: letter ?? "", op: "removed" });
			i += 1;
		}
	}
	return merge(letters);
}

/**
 * A lone space between two changed runs belongs to the change: it goes on both sides, so
 * "a big red box" → "a small blue box" reads as one replaced run.
 */
function absorbRuns(runs: DiffSegment[]): DiffSegment[] {
	const absorbed: DiffSegment[] = [];
	for (let index = 0; index < runs.length; index += 1) {
		const run = runs[index];
		if (run === undefined) continue;
		const changed = (other: DiffSegment | undefined) =>
			other !== undefined && other.op !== "same";
		if (
			run.op === "same" &&
			run.text.trim() === "" &&
			changed(absorbed.at(-1)) &&
			changed(runs[index + 1])
		) {
			absorbed.push({ text: run.text, op: "removed" }, { text: run.text, op: "added" });
			continue;
		}
		absorbed.push(run);
	}
	// Removed runs first, then added, between each pair of shared runs: one hunk per gap.
	const ordered: DiffSegment[] = [];
	let hunk: DiffSegment[] = [];
	const flush = () => {
		ordered.push(
			...hunk.filter((run) => run.op === "removed"),
			...hunk.filter((run) => run.op === "added")
		);
		hunk = [];
	};
	for (const run of absorbed) {
		if (run.op === "same") {
			flush();
			ordered.push(run);
		} else hunk.push(run);
	}
	flush();
	return ordered;
}

/** Whether a field differs between the sides, counting a side that lacks it. */
export function fieldChanged(field: TextDiffField): boolean {
	return field.before !== field.after;
}

/** A path's last part and the folder before it, split at either kind of slash. */
export interface TextDiffFileName {
	readonly name: string;
	readonly folder: string;
}

export function textDiffFileName(path: string): TextDiffFileName {
	const slash = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
	return { name: path.slice(slash + 1), folder: slash < 0 ? "" : path.slice(0, slash) };
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
