import {
	searchTextCorpus,
	textAssetName,
	type TextCorpus,
	type TextLocation,
	type TextOccurrence,
	type TextUnit,
	type TextUnitSearchResult
} from "@ue-shed/game-text/browser";

export type CapabilityFilter = "all" | "source_editable" | "read_only";

type TextUnitPresentation = Pick<TextUnit, "identity" | "source"> | TextUnitSearchResult;

export function sourceText(unit: TextUnitPresentation): string {
	return unit.source.status === "consistent" ? unit.source.value : unit.source.values.join(" ");
}

export function identityLabel(unit: TextUnitPresentation): string {
	if (unit.identity.status === "resolved") {
		return `${unit.identity.namespace || "global"} · ${unit.identity.key}`;
	}
	if (unit.identity.status === "string_table") {
		return `${unit.identity.tableId} · ${unit.identity.key}`;
	}
	return unit.identity.reason === "culture_invariant"
		? "Not localized (culture invariant)"
		: "Missing localization key";
}

export interface TextContextPresentation {
	readonly detail: string;
	readonly kind: string;
	readonly title: string;
}

/** Writer-facing authored context derived only from evidence present in the saved package. */
export function textContext(location: TextLocation): TextContextPresentation {
	const asset = textAssetName(location.objectPath);
	if (location.kind === "string_table_entry") {
		return {
			detail: "Shared String Table entry",
			kind: "String Table",
			title: `${asset} · ${location.entryKey}`
		};
	}
	if (location.kind === "data_table_cell") {
		return {
			detail: `${location.propertyPath} field`,
			kind: "DataTable",
			title: `${asset} · ${location.row} · ${location.propertyPath}`
		};
	}
	return {
		detail: `${location.propertyPath} property`,
		kind: location.classPath.split(".").at(-1) ?? "Asset",
		title: `${asset} · ${location.propertyPath}`
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

export function locationDetail(location: TextLocation): string {
	if (location.kind === "data_table_cell")
		return `Row ${location.row} · ${location.propertyPath}`;
	if (location.kind === "string_table_entry") return `Entry ${location.entryKey}`;
	return location.propertyPath;
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
