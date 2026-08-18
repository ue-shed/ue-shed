import {
	searchTextCorpus,
	type TextCorpus,
	type TextLocation,
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

function leafName(objectPath: string): string {
	const leaf = objectPath.split("/").at(-1) ?? objectPath;
	return leaf.split(".").at(-1) ?? leaf;
}

function words(value: string): string {
	return value
		.replace(/^(?:DT|ST|T|WBP|BP)_/u, "")
		.replaceAll(/[_./]+/gu, " ")
		.replace(/([a-z0-9])([A-Z])/gu, "$1 $2")
		.trim();
}

export interface TextContextPresentation {
	readonly detail: string;
	readonly kind: string;
	readonly title: string;
}

/** Writer-facing authored context derived only from evidence present in the saved package. */
export function textContext(location: TextLocation): TextContextPresentation {
	const asset = words(leafName(location.objectPath));
	if (location.kind === "string_table_entry") {
		return {
			detail: "Shared String Table entry",
			kind: "String Table",
			title: `${asset} · ${words(location.entryKey)}`
		};
	}
	if (location.kind === "data_table_cell") {
		return {
			detail: `${words(location.propertyPath)} field`,
			kind: "DataTable",
			title: `${asset} · ${words(location.row)}`
		};
	}
	return {
		detail: `${words(location.propertyPath)} property`,
		kind: words(location.classPath.split(".").at(-1) ?? "Asset"),
		title: asset
	};
}

export function primaryContext(
	unit: Pick<TextUnitSearchResult, "contexts" | "remainingContextCount">
) {
	return {
		context: unit.contexts[0],
		additional: unit.remainingContextCount + Math.max(0, unit.contexts.length - 1)
	};
}

export function sourceLength(unit: TextUnitPresentation): number {
	return sourceText(unit).length;
}

export function occurrenceContext(occurrence: TextOccurrence): string {
	return textContext(occurrence.location).title;
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
