import type {
	GameTextActionsRequest,
	GameTextActionsResult,
	GameTextAction,
	GameTextActionEdit,
	GameTextActionOutcomeIdentity
} from "@ue-shed/protocol";
import type { SavedAssetPackageTextRecord, SavedAssetTextOccurrence } from "@ue-shed/unreal-assets";
import { gatheredNamespace } from "./gathered-text.js";

/** Compatibility names for the shared localization editing API. */
export {
	LOCALIZATION_TEXT_ACTIONS_CAPABILITY as GAME_TEXT_ACTIONS_CAPABILITY,
	LocalizationTextActionsError as GameTextActionsError,
	localizationTextActionsRequest as gameTextActionsRequest,
	runLocalizationTextActions as runGameTextActions,
	type LocalizationTextActionsOptions as GameTextActionsOptions
} from "@ue-shed/localization";

/**
 * One action for a text the saved-package reader found, expecting the id and source it read. The
 * reader reports the namespace as saved, with the package namespace marker (`[...]`); actions use
 * the namespace Gather reports, without it. Only
 * resolved text is mapped here, including table entries/cells and graph pin selectors. References
 * and unkeyed conversions require an explicit localization action. Keep the owning reader record's
 * packageFile with the occurrence; serialized object paths alone cannot identify copied assets.
 */
export function gameTextActionForOccurrence(
	id: string,
	occurrence: SavedAssetTextOccurrence,
	edit: GameTextActionEdit,
	packageFile: string
): GameTextAction | undefined {
	if (occurrence.identity.status !== "resolved") return undefined;
	const location = occurrence.location;
	const pin =
		location.kind === "asset_property"
			? /^Pins\[(\d+)\]\.DefaultTextValue$/u.exec(location.property_path)
			: undefined;
	return {
		id,
		place: {
			packageFile,
			objectPath: location.object_path,
			propertyPath:
				location.kind === "string_table_entry"
					? location.entry_key
					: location.property_path,
			...(location.kind === "data_table_cell"
				? { selector: { kind: "data_table_cell" as const, row: location.row } }
				: location.kind === "string_table_entry"
					? {
							selector: {
								kind: "string_table_entry" as const,
								entryKey: location.entry_key
							}
						}
					: pin
						? { selector: { kind: "graph_pin" as const, index: Number(pin[1]) } }
						: {})
		},
		expected: {
			namespace: gatheredNamespace(
				occurrence.identity.namespace,
				location.kind === "string_table_entry"
			),
			key: occurrence.identity.key,
			source: occurrence.source
		},
		edit
	};
}

/** One applied action whose re-read text is not what the editor reported. */
export interface GameTextActionMismatch {
	readonly actionId: string;
	readonly expected: GameTextActionOutcomeIdentity;
	/** The text the reader found at the place, or absent when it found none. */
	readonly found?: { readonly namespace: string; readonly key: string; readonly source: string };
}

/**
 * Saved-file verification after an editor apply. verified counts matching results, mismatches
 * retain provenance, and complete is false when a re-read package supplied only partial
 * evidence.
 */
export interface GameTextActionsVerification {
	readonly verified: number;
	readonly mismatches: readonly GameTextActionMismatch[];
	/** False when a re-read package was read only in part. */
	readonly complete: boolean;
}

/** Object paths inside the same physical file can retain an older serialized package name. */
function packageObjectPath(objectPath: string): string {
	objectPath = objectPath.replaceAll(":", ".");
	if (!objectPath.startsWith("/")) return objectPath;
	const dot = objectPath.indexOf(".");
	return dot < 0 ? objectPath : objectPath.slice(dot + 1);
}

function samePackageFile(left: string, right: string): boolean {
	return left.replaceAll("\\", "/") === right.replaceAll("\\", "/");
}

/**
 * Compares the packages re-read after an apply with what the editor reported for each applied
 * action, place by place. Pure; reading the packages stays with the caller.
 */
export function verifyGameTextActions(
	request: GameTextActionsRequest,
	result: GameTextActionsResult,
	records: readonly SavedAssetPackageTextRecord[]
): GameTextActionsVerification {
	const occurrences = records.flatMap((record) =>
		record.occurrences.map((occurrence) => ({ file: record.path, occurrence }))
	);
	const mismatches: GameTextActionMismatch[] = [];
	let verified = 0;
	for (const outcome of result.actions) {
		if (outcome.status !== "applied") continue;
		const action = request.actions.find((candidate) => candidate.id === outcome.id);
		if (!action) continue;
		const occurrence = occurrences.find(({ file, occurrence: candidate }) => {
			if (
				!samePackageFile(file, action.place.packageFile) ||
				packageObjectPath(candidate.location.object_path) !==
					packageObjectPath(action.place.objectPath)
			)
				return false;
			const selector = action.place.selector;
			if (selector?.kind === "data_table_cell")
				return (
					candidate.location.kind === "data_table_cell" &&
					candidate.location.row === selector.row &&
					candidate.location.property_path === action.place.propertyPath
				);
			if (selector?.kind === "string_table_entry")
				return (
					candidate.location.kind === "string_table_entry" &&
					candidate.location.entry_key ===
						(action.edit.kind === "copy_string_table_entry"
							? outcome.after.key
							: selector.entryKey)
				);
			return (
				candidate.location.kind === "asset_property" &&
				candidate.location.property_path === action.place.propertyPath
			);
		})?.occurrence;
		if (outcome.after.removed) {
			if (
				occurrence === undefined &&
				records.some(
					(record) =>
						samePackageFile(record.path, action.place.packageFile) &&
						record.status === "complete"
				)
			)
				verified++;
			else mismatches.push({ actionId: outcome.id, expected: outcome.after });
			continue;
		}
		if (outcome.after.tableId !== undefined) {
			if (
				occurrence?.identity.status === "string_table" &&
				occurrence.identity.table_id === outcome.after.tableId &&
				occurrence.identity.key === outcome.after.key
			)
				verified++;
			else mismatches.push({ actionId: outcome.id, expected: outcome.after });
			continue;
		}
		const found =
			occurrence?.identity.status === "resolved"
				? {
						namespace: gatheredNamespace(
							occurrence.identity.namespace,
							occurrence.location.kind === "string_table_entry"
						),
						key: occurrence.identity.key,
						source: occurrence.source
					}
				: undefined;
		const matches =
			found !== undefined &&
			found.namespace === outcome.after.namespace &&
			found.source === outcome.after.source &&
			(outcome.after.key === undefined || found.key === outcome.after.key);
		if (matches) verified += 1;
		else
			mismatches.push(
				found === undefined
					? { actionId: outcome.id, expected: outcome.after }
					: { actionId: outcome.id, expected: outcome.after, found }
			);
	}
	return {
		verified,
		mismatches,
		complete: records.every((record) => record.status === "complete")
	};
}
