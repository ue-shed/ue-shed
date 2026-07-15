import type { TextCorpus, TextUnit } from "./schema.js";

export function searchTextCorpus(corpus: TextCorpus, query: string): readonly TextUnit[] {
	const terms = query.toLocaleLowerCase().trim().split(/\s+/u).filter(Boolean);
	if (terms.length === 0) return corpus.units;
	return corpus.units.filter((unit) => {
		const identity =
			unit.identity.status === "resolved"
				? `${unit.identity.namespace} ${unit.identity.key}`
				: unit.identity.reason;
		const haystack = [
			...unit.occurrences.map((occurrence) => occurrence.source),
			identity,
			...unit.occurrences.flatMap((occurrence) => [
				occurrence.packageFile,
				occurrence.location.objectPath,
				occurrence.location.kind === "string_table_entry"
					? occurrence.location.entryKey
					: occurrence.location.propertyPath,
				occurrence.location.kind === "data_table_cell" ? occurrence.location.row : ""
			])
		]
			.join("\n")
			.toLocaleLowerCase();
		return terms.every((term) => haystack.includes(term));
	});
}
