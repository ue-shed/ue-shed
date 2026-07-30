import type { TextCorpus, TextUnit } from "./schema.js";

function sourceValues(unit: TextUnit): readonly string[] {
	return unit.source.status === "consistent" ? [unit.source.value] : unit.source.values;
}

/** Empty FText values are implementation noise, not searchable game text. */
export function hasSearchableSource(unit: TextUnit): boolean {
	return sourceValues(unit).some((source) => source.trim().length > 0);
}

/**
 * Game-text search deliberately indexes only player-facing source text. Identity and occurrence
 * metadata belong to the focused inspector, not the corpus query.
 */
export function searchableSourceText(unit: TextUnit): string {
	return sourceValues(unit).join("\n").toLocaleLowerCase();
}

export function searchTextCorpus(corpus: TextCorpus, query: string): readonly TextUnit[] {
	const terms = query.toLocaleLowerCase().trim().split(/\s+/u).filter(Boolean);
	return corpus.units.filter((unit) => {
		if (!hasSearchableSource(unit)) return false;
		const haystack = searchableSourceText(unit);
		return terms.every((term) => haystack.includes(term));
	});
}
