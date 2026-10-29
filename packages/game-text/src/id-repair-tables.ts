import { textLocationPath } from "./text-origin.js";
import { connectUnrealAuthoring } from "@ue-shed/unreal-connection";
import { stripPackageNamespace } from "@ue-shed/localization";
import {
	AUTHORING_MUTATION_CONTRACT_VERSION,
	GAME_TEXT_ACTIONS_CONTRACT,
	GAME_TEXT_ACTIONS_VERSION,
	ErrorGuidanceFields,
	type AuthoringApplyRequest,
	type AuthoringTableSnapshotV2,
	type GameTextActionsResult,
	type GameTextActionOutcome
} from "@ue-shed/protocol";
import { Effect, Schema } from "effect";
import type { TextIdRepairRequest } from "./id-repair-schema.js";
import { textIdNamespace } from "./id-repair.js";
import { mountedPackageName } from "./package-object-path.js";

/** A table's reviewed source/identity or live fingerprint no longer supports the proposal. */
export class TextIdTableRepairError extends Schema.TaggedError<TextIdTableRepairError>()(
	"TextIdTableRepairError",
	{
		...ErrorGuidanceFields
	}
) {}

/** The live row struct has no column for a reviewed saved property, so no cell was compared. */
export class TextIdTableColumnError extends Schema.TaggedError<TextIdTableColumnError>()(
	"TextIdTableColumnError",
	{
		...ErrorGuidanceFields,
		objectPath: Schema.String,
		propertyName: Schema.String,
		liveColumns: Schema.Array(Schema.String)
	}
) {}

const invalid = (message: string) =>
	new TextIdTableRepairError({
		message,
		recovery: "Rescan and review the table fix again.",
		retrySafe: true,
		nextStep: "fix_input"
	});

/**
 * Binds a saved reader's property name to the live column. Saved packages name a User Defined
 * Struct member by its FName (`DisplayName_2_<guid>`) while row values use its authored name, so
 * only the schema's `propertyName` joins them. Producers before snapshot 2.4 omit it; then a
 * column's name is its FName only for native structs, and Blueprint struct columns stay unbound.
 */
function liveColumn(table: AuthoringTableSnapshotV2["table"], propertyName: string) {
	const fields = table.schema.status === "available" ? table.schema.fields : [];
	const field = fields.find((item) => (item.propertyName ?? item.name) === propertyName);
	return {
		column: field && { name: field.name, propertyName: field.propertyName ?? field.name },
		liveColumns: fields.map((item) => item.propertyName ?? item.name),
		namesKnown: fields.length > 0 && fields.every((item) => item.propertyName !== undefined)
	};
}

/** Prepares Authoring's guarded all-or-nothing batch without applying or saving any table. */
export const prepareTextIdTableRepair = Effect.fn("GameText.idRepairs.tables.prepare")(function* (
	endpoint: string,
	request: TextIdRepairRequest,
	operationId: string
) {
	const connection = yield* connectUnrealAuthoring(endpoint);
	const commands: AuthoringApplyRequest["commands"][number][] = [];
	const tables: AuthoringApplyRequest["tables"][number][] = [];
	const outcomes: GameTextActionOutcome[] = [];
	const packages: GameTextActionsResult["packages"][number][] = [];
	for (const objectPath of new Set(
		request.changes.map((item) => textLocationPath(item.occurrence.location))
	)) {
		// Authoring resolves an object path, so bind it to the reviewed file before querying it.
		// The index moves a moved or copied file's paths to its package, but a request can still
		// carry a serialized one; the live table must also report the same package below.
		const changes = request.changes.filter(
			(item) => textLocationPath(item.occurrence.location) === objectPath
		);
		const packageNames = changes.map((item) =>
			mountedPackageName(request.projectKey, item.occurrence.packageFile)
		);
		const packageName = packageNames[0];
		if (
			!packageName ||
			packageNames.some((name) => name !== packageName) ||
			objectPath.split(".")[0] !== packageName
		)
			return yield* invalid(
				"The table's object path cannot be bound to its reviewed file. Open this table in Data Authoring or Unreal."
			);
		const snapshot = yield* connection.getTableSnapshot(objectPath);
		if (
			!("fingerprint" in snapshot) ||
			snapshot.fingerprint.status !== "available" ||
			snapshot.completeness !== "complete" ||
			snapshot.table.kind !== "data_table" ||
			snapshot.table.packageName !== packageName
		)
			return yield* invalid(
				"The table needs a complete, writable live snapshot and fingerprint."
			);
		tables.push({ objectPath, expectedFingerprint: snapshot.fingerprint.value });
		for (const change of changes) {
			const { occurrence, edit } = change;
			const location = occurrence.location;
			if (location.kind !== "data_table_cell" || occurrence.identity.status !== "resolved")
				return yield* invalid("Only localized DataTable text can use this repair path.");
			const row = snapshot.table.rows.find((item) => item.name === location.row);
			if (!row)
				return yield* invalid(
					`The live table has no row ${location.row}. It may have been renamed or removed.`
				);
			const { column, liveColumns, namesKnown } = liveColumn(
				snapshot.table,
				location.propertyPath
			);
			const current = column && row.fields.find((item) => item.name === column.name)?.value;
			if (!column || !current)
				return yield* new TextIdTableColumnError({
					message: `The live row struct has no column ${location.propertyPath}.`,
					recovery: namesKnown
						? "The row struct changed since the scan. Rescan and review the fix again."
						: "This editor's UE Shed plugin does not report struct property names. Update the UE Shed plugins, restart the editor and try again.",
					retrySafe: true,
					nextStep: "fix_input",
					objectPath,
					propertyName: location.propertyPath,
					liveColumns
				});
			if (
				current.kind !== "text" ||
				current.identity?.kind !== "localized" ||
				current.value !== occurrence.source ||
				current.identity.key !== occurrence.identity.key ||
				stripPackageNamespace(current.identity.namespace) !== textIdNamespace(occurrence)
			)
				return yield* invalid(
					"The live cell no longer holds the source and key you reviewed."
				);
			if (
				edit.kind !== "change_source" &&
				edit.kind !== "change_key" &&
				edit.kind !== "adopt_key"
			)
				return yield* invalid(
					"Use the shared localization text editing API for this operation."
				);
			const before = {
				namespace: textIdNamespace(occurrence),
				key: occurrence.identity.key,
				source: occurrence.source
			};
			const after =
				edit.kind === "change_source"
					? { ...before, source: edit.source }
					: {
							namespace: edit.namespace,
							key: edit.key,
							source: edit.kind === "adopt_key" ? edit.source : before.source
						};
			commands.push({
				id: occurrence.id,
				tableObjectPath: objectPath,
				body: {
					kind: "set_cell",
					// Authoring resolves an FName directly; an authored name needs its member scan.
					fieldName: column.propertyName,
					rowId: row.id,
					oldValue: current,
					newValue: {
						kind: "text",
						value: after.source,
						identity: {
							kind: "localized",
							namespace: after.namespace,
							key: after.key,
							sourceString: after.source
						}
					}
				}
			});
			outcomes.push({
				id: occurrence.id,
				place: {
					packageFile: occurrence.packageFile,
					objectPath,
					propertyPath: `${location.row}.${location.propertyPath}`
				},
				status: "planned",
				before,
				after
			});
		}
		const packageFile = request.changes.find(
			(item) => textLocationPath(item.occurrence.location) === objectPath
		)?.occurrence.packageFile;
		if (!packageFile) return yield* invalid("The table's saved file is missing.");
		packages.push({
			packageName: snapshot.table.packageName,
			packageFile,
			saved: false,
			persistence: "unsaved"
		});
	}
	const authoring: AuthoringApplyRequest = {
		contract: { name: "unreal-authoring-apply", version: AUTHORING_MUTATION_CONTRACT_VERSION },
		operationId,
		commands,
		tables
	};
	const limits = connection.manifest.authoringLimits;
	if (
		!limits ||
		tables.length > limits.maxTables ||
		commands.length > limits.maxCommands ||
		new TextEncoder().encode(JSON.stringify(authoring)).length > limits.maxPayloadBytes
	)
		return yield* invalid(
			"This fix exceeds the editor's advertised Authoring limits. Review fewer places."
		);
	const preview: GameTextActionsResult = {
		contract: GAME_TEXT_ACTIONS_CONTRACT,
		version: GAME_TEXT_ACTIONS_VERSION,
		mode: "dry_run",
		status: "ok",
		rolledBack: false,
		actions: outcomes,
		blueprints: [],
		packages,
		errors: []
	};
	return { authoring, preview };
});

/** Applies the exact reviewed fingerprints/old values and then saves; no mutation is retried. */
export const applyTextIdTableRepair = Effect.fn("GameText.idRepairs.tables.apply")(function* (
	endpoint: string,
	authoring: AuthoringApplyRequest,
	preview: GameTextActionsResult,
	retainApplied: (
		result: GameTextActionsResult
	) => Effect.Effect<void, { readonly message: string; readonly recovery: string }>
) {
	const connection = yield* connectUnrealAuthoring(endpoint);
	const applied = yield* connection.apply(authoring);
	if (applied.status !== "committed")
		return {
			...preview,
			mode: "apply",
			status: applied.status === "rejected" ? "rejected" : "failed",
			rolledBack: applied.status === "rolled_back",
			actions: preview.actions.map((item) => ({
				...item,
				status: applied.status === "rolled_back" ? "rolled_back" : "unchanged",
				after: item.before
			})),
			errors: applied.errors.map((error) => ({
				code: "stale_expected",
				message: error.message,
				recovery: "Rescan and review the fix again.",
				retrySafe: error.retrySafe,
				nextStep: "fix_input"
			}))
		} satisfies GameTextActionsResult;
	// The mutation is committed before the separate save call. Retain that evidence even if its
	// save reply is lost, so the host can reconcile without applying the cells again.
	yield* retainApplied({
		...preview,
		mode: "apply",
		status: "failed",
		actions: preview.actions.map((item) => ({ ...item, status: "applied" })),
		errors: [
			{
				code: "save_failed",
				message: "The table edits are applied; saving has not been confirmed.",
				recovery:
					"Inspect live and saved state before saving again. Do not replay the cell edits.",
				retrySafe: false,
				nextStep: "reconcile"
			}
		]
	});
	const saved = yield* connection.save({
		contract: { name: "unreal-authoring-save", version: AUTHORING_MUTATION_CONTRACT_VERSION },
		requestId: authoring.operationId,
		objectPaths: authoring.tables.map((item) => item.objectPath)
	});
	return {
		...preview,
		mode: "apply",
		status: saved.status === "complete" ? "ok" : "failed",
		actions: preview.actions.map((item) => ({ ...item, status: "applied" })),
		packages: preview.packages.map((item) => {
			const persisted =
				saved.packages.find((entry) => entry.packageName === item.packageName)?.status ===
				"saved";
			return { ...item, saved: persisted, persistence: persisted ? "saved" : "unsaved" };
		}),
		errors: saved.packages
			.filter((item) => item.status !== "saved")
			.map((item) => ({
				code: "save_failed",
				message: item.message ?? `Could not save ${item.packageName}.`,
				recovery:
					"The edit is live. Save the table in Unreal, then rescan; do not replay the edit.",
				retrySafe: false,
				nextStep: "reconcile"
			}))
	} satisfies GameTextActionsResult;
});
