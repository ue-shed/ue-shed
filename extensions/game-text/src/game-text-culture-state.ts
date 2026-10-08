import type { LocalizationCultureMark, LocalizationState } from "@ue-shed/game-text/browser";

/** What one culture's cell says: shipped, missing, to update, not synced, or something else. */
export type CultureCell = "shipped" | "missing" | "to_update" | "not_synced" | "other";

export const CELL_WORDS = {
	shipped: "shipped",
	missing: "missing",
	to_update: "to update",
	not_synced: "not synced",
	other: "not settled"
} satisfies Record<CultureCell, string>;

/** The parts of a culture mark the strip reads; culture codes are plain text here. */
export interface CultureMark {
	readonly culture: string;
	readonly state: LocalizationCultureMark["state"];
	readonly facts: LocalizationCultureMark["facts"];
}

// Gather and project states describe the line, not a culture; the row says those once.
const LINE_STATES = new Set<LocalizationState>([
	"not_gathered",
	"changed_since_gather",
	"not_found",
	"gathered_only",
	"outside_target",
	"unknown"
]);

export function cultureCell(mark: Pick<CultureMark, "state" | "facts">): CultureCell {
	if (mark.state === "not_synced" || mark.facts.includes("not_synced")) return "not_synced";
	if (mark.state === "not_translated") return "missing";
	if (mark.state === "needs_update") return "to_update";
	if (mark.state === "translated") return "shipped";
	return "other";
}

/** The state every culture shares when it describes the line itself, such as not gathered yet. */
export function lineState(
	marks: readonly Pick<CultureMark, "state" | "facts">[]
): LocalizationState | undefined {
	const first = marks[0]?.state;
	if (first === undefined || !LINE_STATES.has(first)) return undefined;
	return marks.every((mark) => mark.state === first && !mark.facts.includes("not_synced"))
		? first
		: undefined;
}

/** "all missing", "ja, ko missing", "8 to update · ja not synced"; empty when all shipped. */
export function cultureSummary(marks: readonly CultureMark[]): string {
	const groups = new Map<CultureCell, string[]>();
	for (const mark of marks) {
		const cell = cultureCell(mark);
		if (cell === "shipped" || cell === "other") continue;
		groups.set(cell, [...(groups.get(cell) ?? []), mark.culture]);
	}
	return [...groups]
		.map(
			([cell, cultures]) =>
				(cultures.length === marks.length
					? "all"
					: cultures.length <= 2
						? cultures.join(", ")
						: cultures.length.toLocaleString()) +
				" " +
				CELL_WORDS[cell]
		)
		.join(" · ");
}
