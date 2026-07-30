import {
	searchTextCorpus,
	type TextCorpus,
	type TextOccurrence,
	type TextUnit,
	type TextUnitSearchResult
} from "@ue-shed/game-text/browser";

export type CapabilityFilter = "all" | "source_editable" | "read_only";

type TextUnitPresentation = Pick<TextUnit, "identity" | "source"> | TextUnitSearchResult;

export function sourceText(unit: TextUnitPresentation): string {
	return unit.source.status === "consistent" ? unit.source.value : unit.source.values.join(" / ");
}

export function identityLabel(unit: TextUnitPresentation): string {
	return unit.identity.status === "resolved"
		? `${unit.identity.namespace} · ${unit.identity.key}`
		: `Identity unresolved · ${unit.identity.reason.replaceAll("_", " ")}`;
}

export function occurrenceContext(occurrence: TextOccurrence): string {
	const location = occurrence.location;
	if (location.kind === "string_table_entry") return `String Table · ${location.entryKey}`;
	if (location.kind === "data_table_cell") {
		return `DataTable · ${location.row} / ${location.propertyPath}`;
	}
	return `${location.classPath.split(".").at(-1) ?? location.classPath} · ${location.propertyPath}`;
}

export function filterTextUnits(options: {
	readonly corpus: TextCorpus;
	readonly query: string;
	readonly capability: CapabilityFilter;
}): readonly TextUnit[] {
	return searchTextCorpus(options.corpus, options.query).filter(
		(unit) =>
			options.capability === "all" ||
			unit.occurrences.some((occurrence) => occurrence.editCapability === options.capability)
	);
}
