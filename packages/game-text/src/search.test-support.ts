import type { TextCorpus, TextUnit } from "./schema.js";
import { hasSearchableSource } from "./search.js";
export { hasSearchableSource } from "./search.js";

function sourceValues(unit: TextUnit): readonly string[] {
	return unit.source.status === "consistent" ? [unit.source.value] : unit.source.values;
}

/**
 * Game-text search deliberately indexes only player-facing source text. Identity and occurrence
 * metadata belong to the focused inspector, not the corpus query.
 */
export function searchableSourceText(unit: TextUnit): string {
	return sourceValues(unit).join("\n").toLocaleLowerCase();
}

/**
 * Searches a corpus using the bounded request and optional localization evidence. Returns a
 * presentation page while preserving whole-scope counts and raw coverage separately.
 */
export function searchTextCorpus(corpus: TextCorpus, query: string): readonly TextUnit[] {
	const terms = query.toLocaleLowerCase().trim().split(/\s+/u).filter(Boolean);
	return corpus.units.filter((unit) => {
		if (!hasSearchableSource(unit)) return false;
		const haystack = searchableSourceText(unit);
		return terms.every((term) => haystack.includes(term));
	});
}
