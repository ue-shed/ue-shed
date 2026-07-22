import type {
	AuthoringCommandGroupReview,
	AuthoringReviewDiagnostic,
	AuthoringSessionPipeline,
	AuthoringSessionReview,
	AuthoringTableChange,
	AuthoringTableReview,
	AuthoringTableSnapshot
} from "@ue-shed/protocol";
import { authoringValueCompatibility, workingTable, type DraftSession } from "./draft.js";
import type { AuthoringSessionDocument } from "./session-service.js";

export {
	AuthoringCommandGroupReview,
	AuthoringReviewDiagnostic,
	AuthoringSessionPipeline,
	AuthoringSessionReview,
	AuthoringSessionValidation,
	AuthoringTableChange,
	AuthoringTableReview
} from "@ue-shed/protocol";

function valuesEqual(left: unknown, right: unknown): boolean {
	return JSON.stringify(left) === JSON.stringify(right);
}

function isInvalidRowName(name: string): boolean {
	return name.length === 0 || name.toLowerCase() === "none" || name.includes("\0");
}

function validationDiagnostics(snapshot: AuthoringTableSnapshot): AuthoringReviewDiagnostic[] {
	const diagnostics: AuthoringReviewDiagnostic[] = snapshot.diagnostics.map((diagnostic) => ({
		code: diagnostic.code,
		message: diagnostic.message,
		...(diagnostic.path === undefined ? {} : { path: diagnostic.path }),
		recovery: "Review the source authority diagnostic before applying this draft.",
		severity: "warning" as const,
		tableObjectPath: snapshot.table.objectPath
	}));
	const names = new Map<string, string>();
	for (const row of snapshot.table.rows) {
		if (isInvalidRowName(row.name)) {
			diagnostics.push({
				code: "invalid_row_name",
				message: `Row name ${JSON.stringify(row.name)} cannot be represented as an Unreal FName`,
				recovery: "Rename the row to a non-empty name other than None.",
				rowId: row.id,
				severity: "error",
				tableObjectPath: snapshot.table.objectPath
			});
		}
		const normalized = row.name.toLowerCase();
		const existing = names.get(normalized);
		if (existing !== undefined) {
			diagnostics.push({
				code: "duplicate_row_name",
				message: `Rows ${existing} and ${row.name} conflict under Unreal FName comparison`,
				recovery: "Rename one row so names are unique without regard to letter case.",
				rowId: row.id,
				severity: "error",
				tableObjectPath: snapshot.table.objectPath
			});
		} else {
			names.set(normalized, row.name);
		}
	}
	if (!("schema" in snapshot.table) || snapshot.table.schema.status !== "available") {
		diagnostics.push({
			code: "schema_validation_unavailable",
			message: "The selected authority does not expose a complete editable field schema",
			recovery: "Connect a compatible live authoring producer for complete validation.",
			severity: "warning",
			tableObjectPath: snapshot.table.objectPath
		});
		return diagnostics;
	}
	for (const row of snapshot.table.rows) {
		for (const descriptor of snapshot.table.schema.fields) {
			if (
				descriptor.presence === "required" &&
				!row.fields.some((field) => field.name === descriptor.name)
			) {
				diagnostics.push({
					code: "missing_field",
					fieldName: descriptor.name,
					message: `Row ${row.name} is missing required field ${descriptor.name}`,
					recovery: "Refresh from a complete authority or restore the required field.",
					rowId: row.id,
					severity: "error",
					tableObjectPath: snapshot.table.objectPath
				});
			}
		}
		for (const field of row.fields) {
			const descriptor = snapshot.table.schema.fields.find(
				(candidate) => candidate.name === field.name
			);
			if (descriptor === undefined) {
				diagnostics.push({
					code: "field_schema_missing",
					fieldName: field.name,
					message: `Field ${field.name} is not described by the current schema`,
					recovery: "Refresh from a complete authority before changing this field.",
					rowId: row.id,
					severity: "warning",
					tableObjectPath: snapshot.table.objectPath
				});
				continue;
			}
			const mismatch = authoringValueCompatibility(
				field.value,
				descriptor.type,
				`${row.name}.${field.name}`
			);
			if (mismatch !== undefined) {
				diagnostics.push({
					code: "incompatible_value",
					fieldName: field.name,
					message: mismatch,
					recovery: "Restore a value compatible with the reflected field schema.",
					rowId: row.id,
					severity: "error",
					tableObjectPath: snapshot.table.objectPath
				});
			}
		}
	}
	return diagnostics;
}

export function diffAuthoringTable(
	base: AuthoringTableSnapshot,
	working: AuthoringTableSnapshot
): readonly AuthoringTableChange[] {
	const changes: AuthoringTableChange[] = [];
	const baseById = new Map(base.table.rows.map((row) => [row.id, row]));
	const workingById = new Map(working.table.rows.map((row) => [row.id, row]));
	for (const row of base.table.rows) {
		if (!workingById.has(row.id)) changes.push({ kind: "row_removed", row });
	}
	for (const row of working.table.rows) {
		const previous = baseById.get(row.id);
		if (!previous) {
			changes.push({ kind: "row_added", row });
			continue;
		}
		if (previous.name !== row.name) {
			changes.push({
				kind: "row_renamed",
				newName: row.name,
				oldName: previous.name,
				rowId: row.id
			});
		}
		const previousFields = new Map(previous.fields.map((field) => [field.name, field]));
		for (const field of row.fields) {
			const previousField = previousFields.get(field.name);
			if (previousField && !valuesEqual(previousField.value, field.value)) {
				changes.push({
					fieldName: field.name,
					kind: "cell_changed",
					newValue: field.value,
					oldValue: previousField.value,
					rowId: row.id,
					rowName: row.name
				});
			}
		}
	}
	const oldOrder = base.table.rows.map((row) => row.id);
	const newOrder = working.table.rows.map((row) => row.id);
	if (!valuesEqual(oldOrder, newOrder)) {
		changes.push({ kind: "rows_reordered", newOrder, oldOrder });
	}
	return changes;
}

function commandGroups(session: DraftSession): readonly AuthoringCommandGroupReview[] {
	const groups = new Map<string, { commands: typeof session.commands; start: number }>();
	for (const [index, command] of session.commands.entries()) {
		const existing = groups.get(command.groupId);
		groups.set(command.groupId, {
			commands: existing === undefined ? [command] : [...existing.commands, command],
			start: existing?.start ?? index
		});
	}
	return [...groups.entries()].map(([groupId, group]) => {
		const first = group.commands[0];
		if (first === undefined) throw new Error(`Command group ${groupId} is empty`);
		return {
			active: group.start < session.undoPointer,
			...(first.author === undefined ? {} : { author: first.author }),
			authoredAt: first.authoredAt,
			commands: group.commands.map((command) => ({
				body: command.body,
				id: command.id,
				tableObjectPath: command.tableObjectPath
			})),
			groupId,
			tableObjectPaths: [...new Set(group.commands.map((command) => command.tableObjectPath))]
		};
	});
}

export function sessionPipeline(document: AuthoringSessionDocument): AuthoringSessionPipeline {
	const pending = document.pendingOperation;
	if (pending.kind === "apply") {
		return pending.status === "indeterminate"
			? { id: pending.request.operationId, kind: "indeterminate", operation: "apply" }
			: { kind: "applying", operationId: pending.request.operationId };
	}
	if (pending.kind === "save") {
		return pending.status === "indeterminate"
			? { id: pending.request.requestId, kind: "indeterminate", operation: "save" }
			: { kind: "saving", requestId: pending.request.requestId };
	}
	if (document.draft.undoPointer > 0) {
		return { canApply: true, kind: "draft" };
	}
	if (document.draft.awaitingSave.length > 0) {
		return { kind: "applied", objectPaths: document.draft.awaitingSave };
	}
	if (document.draft.saveReceipts.length > 0) return { kind: "saved" };
	return { canApply: false, kind: "draft" };
}

export function reviewAuthoringSession(document: AuthoringSessionDocument): AuthoringSessionReview {
	const tables = Object.entries(document.draft.base)
		.map(([objectPath, base]): AuthoringTableReview => {
			const working = workingTable(document.draft, objectPath);
			const changes = diffAuthoringTable(base, working);
			const diagnostics = validationDiagnostics(working);
			const dirtyCells = changes
				.filter((change) => change.kind === "cell_changed")
				.map((change) => ({ fieldName: change.fieldName, rowId: change.rowId }));
			const dirtyRowIds = [
				...new Set(
					changes.flatMap((change) => {
						switch (change.kind) {
							case "cell_changed":
							case "row_renamed":
								return [change.rowId];
							case "row_added":
							case "row_removed":
								return [change.row.id];
							case "rows_reordered":
								return change.newOrder;
						}
					})
				)
			];
			return {
				base,
				changes,
				diagnostics,
				dirtyCells,
				dirtyRowIds,
				objectPath,
				valid: diagnostics.every((diagnostic) => diagnostic.severity !== "error"),
				working
			};
		})
		.toSorted((left, right) => left.objectPath.localeCompare(right.objectPath));
	const diagnostics = tables.flatMap((table) => table.diagnostics);
	return {
		activeCommandCount: document.draft.undoPointer,
		canRedo: document.draft.undoPointer < document.draft.commands.length,
		canUndo: document.draft.undoPointer > 0,
		commandGroups: commandGroups(document.draft),
		createdAt: document.createdAt,
		lifecycle: document.lifecycle,
		pipeline: sessionPipeline(document),
		project: document.project,
		sessionId: document.draft.id,
		tables,
		updatedAt: document.updatedAt,
		validation: {
			diagnostics,
			errorCount: diagnostics.filter((diagnostic) => diagnostic.severity === "error").length,
			valid: diagnostics.every((diagnostic) => diagnostic.severity !== "error"),
			warningCount: diagnostics.filter((diagnostic) => diagnostic.severity === "warning")
				.length
		}
	};
}
