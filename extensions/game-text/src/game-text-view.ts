import { textAssetName } from "@ue-shed/game-text/corpus";
import {
	type TextLocation,
	type TextOccurrence,
	type TextUnit,
	type TextUnitSearchResult
} from "@ue-shed/game-text/schema";

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

/** The object Unreal opens for a saved place; a code place has none. */
export function savedObjectPath(location: TextLocation): string | undefined {
	return location.kind === "code_place" ? undefined : location.objectPath;
}

/** The copy button's label for a place's path. */
export function copyPathLabel(location: TextLocation): string {
	return location.kind === "code_place" ? "Copy file path" : "Copy asset path";
}

/** Where a place is, to read or copy: a code place's `file:line`, else the object path. */
export function placePath(location: TextLocation): string {
	if (location.kind !== "code_place") return location.objectPath;
	return location.line === undefined ? location.file : `${location.file}:${location.line}`;
}

/** Writer-facing authored context derived only from evidence present in the saved package. */
export function textContext(location: TextLocation): TextContextPresentation {
	if (location.kind === "code_place") {
		const file = location.file.split("/").at(-1) ?? location.file;
		return {
			detail: `${location.wrapper ?? location.macro} in code`,
			kind: "Code",
			title: location.line === undefined ? file : `${file}:${location.line}`
		};
	}
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
	if (location.kind === "code_place")
		return location.line === undefined
			? location.macro
			: `Line ${location.line} · ${location.macro}`;
	return location.propertyPath;
}
