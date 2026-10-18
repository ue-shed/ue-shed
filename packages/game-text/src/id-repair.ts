import { stripPackageNamespace } from "@ue-shed/localization/browser";
import type { GameTextActionEdit } from "@ue-shed/protocol";
import type { TextIdRepairChange } from "./id-repair-schema.js";
import type { TextCorpusFocus, TextOccurrence } from "./schema.js";
import type { TextUnitId } from "./identifiers.js";

/** Mutation route for a saved place. Unsupported places remain reviewable and navigable. */
export function textIdRepairSupport(
	occurrence: TextOccurrence,
	edit?: GameTextActionEdit
): string | undefined {
	if (occurrence.identity.status !== "resolved") return "Change this text in Unreal";
	// Saved properties remain read-only in the corpus. The optional editor plugin owns live
	// writability and rejects unsupported, cooked or generated places during its dry run.
	if (occurrence.location.kind === "asset_property") return undefined;
	if (occurrence.editCapability !== "source_editable") return "Read-only text";
	if (occurrence.location.kind === "data_table_cell") return undefined;
	if (occurrence.location.kind === "string_table_entry")
		return edit && edit.kind !== "change_source"
			? "Use the localization API's explicit String Table copy/reference migration operations for this key change"
			: undefined;
	return undefined;
}

/** Authored selector for the shared native editing API; plain properties retain their wire shape. */
export function textIdRepairPlace(occurrence: TextOccurrence) {
	const location = occurrence.location;
	const pin =
		location.kind === "asset_property"
			? /^Pins\[(\d+)\]\.DefaultTextValue$/u.exec(location.propertyPath)
			: undefined;
	return {
		objectPath: location.objectPath,
		propertyPath:
			location.kind === "string_table_entry" ? location.entryKey : location.propertyPath,
		...(location.kind === "data_table_cell"
			? { selector: { kind: "data_table_cell" as const, row: location.row } }
			: location.kind === "string_table_entry"
				? { selector: { kind: "string_table_entry" as const, entryKey: location.entryKey } }
				: pin
					? { selector: { kind: "graph_pin" as const, index: Number(pin[1]) } }
					: {})
	};
}

/** Human-facing meaning of every supported editing primitive, including explicit conversions. */
export function textIdRepairEditLabel(edit: GameTextActionEdit): string {
	switch (edit.kind) {
		case "change_source":
			return `Use text: ${edit.source}`;
		case "regenerate_key":
			return "Generate a new localization key";
		case "remove_string_table_entry":
			return "Delete old entry from the String Table";
		case "change_string_table_namespace":
			return `Change the whole table namespace to ${edit.namespace}`;
		case "retarget_string_table":
			return `Use String Table ${edit.tableId} · ${edit.key}`;
		default:
			return `Use key: ${edit.namespace} · ${edit.key}`;
	}
}

/** Conflict groups come from authored places; compiled copies stay attached to their owner. */
export function textIdConflictGroups(focus: TextCorpusFocus) {
	const groups = new Map<string, TextOccurrence[]>();
	for (const occurrence of focus.occurrences) {
		const group = groups.get(occurrence.source) ?? [];
		group.push(occurrence);
		groups.set(occurrence.source, group);
	}
	return [...groups].map(([source, occurrences]) => ({ source, occurrences }));
}

/** A stable new key is chosen during review, so every place in a split shares the previewed key. */
export function newTextIdKey(): string {
	return globalThis.crypto.randomUUID().replaceAll("-", "").toUpperCase();
}

/** Builds reviewed place edits without mutating text or silently choosing a preferred variant. */
export function textIdRepairChanges(
	unitId: TextUnitId,
	occurrences: readonly TextOccurrence[],
	edit: GameTextActionEdit
): readonly TextIdRepairChange[] {
	return occurrences.map((occurrence) => ({ unitId, occurrence, edit }));
}

/** The namespace Unreal gathers, without its saved-package marker. */
export function textIdNamespace(occurrence: TextOccurrence): string {
	return occurrence.identity.status === "resolved"
		? stripPackageNamespace(occurrence.identity.namespace)
		: "";
}

/** Human-readable instructions for places whose mutation capability is unavailable. */
export function textIdRepairInstructions(changes: readonly TextIdRepairChange[]): string {
	return changes
		.map(({ occurrence, edit }) => {
			const location = occurrence.location;
			const field =
				location.kind === "string_table_entry" ? location.entryKey : location.propertyPath;
			const target = textIdRepairEditLabel(edit);
			return `${occurrence.packageFile}\n${location.objectPath}\n${field}\nBefore: ${occurrence.source}\n${target}`;
		})
		.join("\n\n");
}
