import {
	AuthoringCommand as AuthoringCommandSchema,
	AuthoringTableSnapshot as AuthoringTableSnapshotSchema,
	type AuthoringFieldValue,
	type AuthoringCommand,
	type AuthoringRow,
	type AuthoringTableSnapshot,
	type AuthoringTypeDescriptor,
	type AuthoringValue
} from "@ue-shed/protocol";
import { Effect, Schema } from "effect";

export type { AuthoringCommand } from "@ue-shed/protocol";

export interface CommandEnvelope {
	readonly id: string;
	readonly groupId: string;
	readonly authoredAt: string;
	readonly author?: string | undefined;
	readonly tableObjectPath: string;
	readonly baseFingerprint: string;
	readonly body: AuthoringCommand;
}

export interface DraftSession {
	readonly version: 2;
	readonly id: string;
	readonly base: Readonly<Record<string, AuthoringTableSnapshot>>;
	readonly fingerprints: Readonly<Record<string, string>>;
	readonly commands: readonly CommandEnvelope[];
	readonly undoPointer: number;
	readonly applyReceipts: readonly ApplyReceipt[];
	readonly saveReceipts: readonly SaveReceipt[];
	readonly awaitingSave: readonly string[];
}

export interface ApplyReceipt {
	readonly operationId: string;
	readonly appliedAt: string;
	readonly tableObjectPaths: readonly string[];
	readonly status: "committed" | "rolled_back" | "rejected" | "indeterminate";
}

export interface SaveReceipt {
	readonly requestId: string;
	readonly savedAt: string;
	readonly status: "complete" | "partial" | "failed";
	readonly packages: readonly {
		readonly objectPath: string;
		readonly packageName: string;
		readonly status: "saved" | "failed";
		readonly retrySafe: boolean;
		readonly message?: string | undefined;
	}[];
}

const CommandEnvelopeSchema = Schema.Struct({
	author: Schema.optional(Schema.String),
	authoredAt: Schema.String,
	baseFingerprint: Schema.String,
	body: AuthoringCommandSchema,
	groupId: Schema.String,
	id: Schema.String,
	tableObjectPath: Schema.String
});

const ApplyReceiptsSchema = Schema.Array(
	Schema.Struct({
		appliedAt: Schema.String,
		operationId: Schema.String,
		status: Schema.Literals(["committed", "rolled_back", "rejected", "indeterminate"]),
		tableObjectPaths: Schema.Array(Schema.String)
	})
);

const DraftSessionV1Schema = Schema.Struct({
	applyReceipts: ApplyReceiptsSchema,
	awaitingSave: Schema.Array(Schema.String),
	base: Schema.Record(Schema.String, AuthoringTableSnapshotSchema),
	commands: Schema.Array(CommandEnvelopeSchema),
	fingerprints: Schema.Record(Schema.String, Schema.String),
	id: Schema.String,
	undoPointer: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
	version: Schema.Literal(1)
});

export const DraftSessionSchema = Schema.Struct({
	applyReceipts: ApplyReceiptsSchema,
	awaitingSave: Schema.Array(Schema.String),
	base: Schema.Record(Schema.String, AuthoringTableSnapshotSchema),
	commands: Schema.Array(CommandEnvelopeSchema),
	fingerprints: Schema.Record(Schema.String, Schema.String),
	id: Schema.String,
	saveReceipts: Schema.Array(
		Schema.Struct({
			packages: Schema.Array(
				Schema.Struct({
					message: Schema.optional(Schema.String),
					objectPath: Schema.String,
					packageName: Schema.String,
					retrySafe: Schema.Boolean,
					status: Schema.Literals(["saved", "failed"])
				})
			),
			requestId: Schema.String,
			savedAt: Schema.String,
			status: Schema.Literals(["complete", "partial", "failed"])
		})
	),
	undoPointer: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
	version: Schema.Literal(2)
});

const decodePersistedDraftSession = Schema.decodeUnknownEffect(
	Schema.Union([DraftSessionV1Schema, DraftSessionSchema])
);

export function decodeDraftSession(input: unknown) {
	return decodeDraftSessionWithMigration(input).pipe(Effect.map(({ draft }) => draft));
}

export function decodeDraftSessionWithMigration(input: unknown) {
	return decodePersistedDraftSession(input).pipe(
		Effect.map((session) =>
			session.version === 1
				? {
						draft: { ...session, saveReceipts: [], version: 2 } satisfies DraftSession,
						migrated: true as const
					}
				: { draft: session, migrated: false as const }
		)
	);
}

export class DraftFoldError extends Schema.TaggedErrorClass<DraftFoldError>()("DraftFoldError", {
	commandId: Schema.String,
	message: Schema.String
}) {}

export class DraftBuildError extends Schema.TaggedErrorClass<DraftBuildError>()("DraftBuildError", {
	message: Schema.String
}) {}

export class DraftIntentError extends Schema.TaggedErrorClass<DraftIntentError>()(
	"DraftIntentError",
	{
		code: Schema.Literals([
			"duplicate_row_name",
			"incompatible_value",
			"invalid_row_name",
			"invalid_row_order",
			"missing_field",
			"row_not_found",
			"stale_fingerprint",
			"unsupported_edit",
			"unsupported_add"
		]),
		message: Schema.String,
		recovery: Schema.String
	}
) {}

function fail(command: CommandEnvelope, message: string): never {
	throw new DraftFoldError({ commandId: command.id, message });
}

function replaceField(
	fields: readonly AuthoringFieldValue[],
	fieldName: string,
	value: AuthoringValue,
	command: CommandEnvelope
): readonly AuthoringFieldValue[] {
	const index = fields.findIndex((field) => field.name === fieldName);
	if (index === -1) {
		return fail(command, `Field ${fieldName} does not exist`);
	}
	return fields.map((field, current) => (current === index ? { ...field, value } : field));
}

export function foldTable(
	base: AuthoringTableSnapshot,
	commands: readonly CommandEnvelope[]
): AuthoringTableSnapshot {
	let rows = [...base.table.rows];
	for (const command of commands) {
		if (command.tableObjectPath !== base.table.objectPath) {
			continue;
		}
		const body = command.body;
		switch (body.kind) {
			case "set_cell": {
				const index = rows.findIndex((row) => row.id === body.rowId);
				if (index === -1) fail(command, `Row ${body.rowId} does not exist`);
				const row = rows[index]!;
				const current = row.fields.find((field) => field.name === body.fieldName);
				if (!current || JSON.stringify(current.value) !== JSON.stringify(body.oldValue)) {
					fail(
						command,
						`Field ${body.fieldName} no longer matches its recorded old value`
					);
				}
				rows[index] = {
					...row,
					fields: replaceField(row.fields, body.fieldName, body.newValue, command)
				};
				break;
			}
			case "add_row": {
				if (rows.some((row) => row.id === body.row.id || row.name === body.row.name)) {
					fail(command, `Row ${body.row.name} already exists`);
				}
				if (body.atIndex < 0 || body.atIndex > rows.length)
					fail(command, "Add index is invalid");
				rows.splice(body.atIndex, 0, body.row);
				break;
			}
			case "remove_row": {
				const index = rows.findIndex((row) => row.id === body.row.id);
				if (index === -1) fail(command, `Row ${body.row.id} does not exist`);
				if (index !== body.atIndex)
					fail(command, `Row ${body.row.id} moved before removal`);
				rows.splice(index, 1);
				break;
			}
			case "rename_row": {
				const index = rows.findIndex((row) => row.id === body.rowId);
				if (index === -1) fail(command, `Row ${body.rowId} does not exist`);
				if (rows[index]!.name !== body.oldName) {
					fail(command, `Row ${body.rowId} no longer has its recorded old name`);
				}
				if (rows.some((row) => row.name === body.newName)) {
					fail(command, `Row ${body.newName} already exists`);
				}
				rows[index] = { ...rows[index]!, name: body.newName };
				break;
			}
			case "reorder_rows": {
				if (JSON.stringify(rows.map((row) => row.id)) !== JSON.stringify(body.oldOrder)) {
					fail(command, "Rows no longer match the recorded old order");
				}
				const current = rows.map((row) => row.id).toSorted();
				const requested = [...body.newOrder].toSorted();
				if (JSON.stringify(current) !== JSON.stringify(requested)) {
					fail(command, "Reorder must be a permutation of current row identities");
				}
				const byId = new Map(rows.map((row) => [row.id, row]));
				rows = body.newOrder.map((id) => byId.get(id)!);
				break;
			}
		}
	}
	if ("producer" in base) {
		return { ...base, table: { ...base.table, rows } };
	}
	return { ...base, table: { ...base.table, rows } };
}

export function appendCommandGroup(
	session: DraftSession,
	commands: readonly CommandEnvelope[]
): DraftSession {
	if (commands.length === 0) return session;
	const groupId = commands[0]!.groupId;
	if (commands.some((command) => command.groupId !== groupId)) {
		throw new Error("One append must contain exactly one command group");
	}
	const active = session.commands.slice(0, session.undoPointer);
	return {
		...session,
		commands: [...active, ...commands],
		undoPointer: active.length + commands.length
	};
}

export function undo(session: DraftSession): DraftSession {
	if (session.undoPointer === 0) return session;
	const groupId = session.commands[session.undoPointer - 1]!.groupId;
	let pointer = session.undoPointer;
	while (pointer > 0 && session.commands[pointer - 1]!.groupId === groupId) pointer--;
	return { ...session, undoPointer: pointer };
}

export function redo(session: DraftSession): DraftSession {
	if (session.undoPointer >= session.commands.length) return session;
	const groupId = session.commands[session.undoPointer]!.groupId;
	let pointer = session.undoPointer;
	while (pointer < session.commands.length && session.commands[pointer]!.groupId === groupId)
		pointer++;
	return { ...session, undoPointer: pointer };
}

export function workingTable(session: DraftSession, objectPath: string): AuthoringTableSnapshot {
	const base = session.base[objectPath];
	if (!base) throw new Error(`Session has no base snapshot for ${objectPath}`);
	return foldTable(base, session.commands.slice(0, session.undoPointer));
}

export function createDraftSession(
	id: string,
	snapshots: readonly AuthoringTableSnapshot[],
	fingerprint: (snapshot: AuthoringTableSnapshot) => string
): DraftSession {
	const base: Record<string, AuthoringTableSnapshot> = {};
	const fingerprints: Record<string, string> = {};
	for (const snapshot of snapshots) {
		base[snapshot.table.objectPath] = snapshot;
		fingerprints[snapshot.table.objectPath] = fingerprint(snapshot);
	}
	return {
		applyReceipts: [],
		awaitingSave: [],
		base,
		commands: [],
		fingerprints,
		id,
		saveReceipts: [],
		undoPointer: 0,
		version: 2
	};
}

export function buildSetCellCommand(args: {
	readonly session: DraftSession;
	readonly tableObjectPath: string;
	readonly rowName: string;
	readonly fieldName: string;
	readonly value: AuthoringValue;
	readonly commandId: string;
	readonly groupId: string;
	readonly authoredAt: string;
	readonly author?: string;
}): CommandEnvelope {
	const table = workingTable(args.session, args.tableObjectPath);
	const row = table.table.rows.find((candidate) => candidate.name === args.rowName);
	if (!row) {
		return rowIntentError(
			"row_not_found",
			`Row ${args.rowName} does not exist`,
			"Refresh the session and choose an existing row."
		);
	}
	const field = row.fields.find((candidate) => candidate.name === args.fieldName);
	if (!field) {
		return rowIntentError(
			"missing_field",
			`Field ${args.fieldName} does not exist`,
			"Refresh the session and choose a field declared by the table schema."
		);
	}
	validateCellEdit(table, field, args.value);
	return {
		authoredAt: args.authoredAt,
		baseFingerprint: baseFingerprint(args.session, args.tableObjectPath),
		body: {
			fieldName: args.fieldName,
			kind: "set_cell",
			newValue: args.value,
			oldValue: field.value,
			rowId: row.id
		},
		groupId: args.groupId,
		id: args.commandId,
		tableObjectPath: args.tableObjectPath,
		...(args.author === undefined ? {} : { author: args.author })
	};
}

export function buildSetCellCommandGroup(args: {
	readonly session: DraftSession;
	readonly tableObjectPath: string;
	readonly edits: readonly {
		readonly rowId: string;
		readonly fieldName: string;
		readonly value: AuthoringValue;
	}[];
	readonly commandIds: readonly string[];
	readonly groupId: string;
	readonly authoredAt: string;
	readonly author?: string;
}): readonly CommandEnvelope[] {
	if (args.edits.length !== args.commandIds.length) {
		throw new DraftBuildError({ message: "Every cell edit requires one command identity" });
	}
	let staged = args.session;
	const commands: CommandEnvelope[] = [];
	for (const [index, edit] of args.edits.entries()) {
		const commandId = args.commandIds[index];
		if (commandId === undefined) {
			throw new DraftBuildError({ message: "Every cell edit requires one command identity" });
		}
		const table = workingTable(staged, args.tableObjectPath);
		const row = table.table.rows.find((candidate) => candidate.id === edit.rowId);
		if (!row) {
			return rowIntentError(
				"row_not_found",
				`Row ${edit.rowId} does not exist`,
				"Refresh the session and retry the complete gesture against existing rows."
			);
		}
		const field = row.fields.find((candidate) => candidate.name === edit.fieldName);
		if (!field) {
			return rowIntentError(
				"missing_field",
				`Field ${edit.fieldName} does not exist`,
				"Refresh the session and retry the complete gesture against declared fields."
			);
		}
		validateCellEdit(table, field, edit.value);
		const command: CommandEnvelope = {
			authoredAt: args.authoredAt,
			baseFingerprint: baseFingerprint(args.session, args.tableObjectPath),
			body: {
				fieldName: edit.fieldName,
				kind: "set_cell",
				newValue: edit.value,
				oldValue: field.value,
				rowId: edit.rowId
			},
			groupId: args.groupId,
			id: commandId,
			tableObjectPath: args.tableObjectPath,
			...(args.author === undefined ? {} : { author: args.author })
		};
		commands.push(command);
		staged = appendCommandGroup(staged, [command]);
	}
	return commands;
}

interface RowCommandMetadata {
	readonly session: DraftSession;
	readonly tableObjectPath: string;
	readonly commandId: string;
	readonly groupId: string;
	readonly authoredAt: string;
	readonly author?: string;
}

function rowIntentError(code: DraftIntentError["code"], message: string, recovery: string): never {
	throw new DraftIntentError({ code, message, recovery });
}

function baseFingerprint(session: DraftSession, tableObjectPath: string): string {
	const fingerprint = session.fingerprints[tableObjectPath];
	if (fingerprint === undefined) {
		return rowIntentError(
			"stale_fingerprint",
			`Session has no base fingerprint for ${tableObjectPath}`,
			"Refresh the table and create a new session from the current authority."
		);
	}
	return fingerprint;
}

export function authoringValueCompatibility(
	value: AuthoringValue,
	type: AuthoringTypeDescriptor,
	path: string
): string | undefined {
	switch (type.kind) {
		case "scalar":
			if (value.kind !== type.valueKind) return `${path} requires ${type.valueKind}`;
			if (value.kind === "int" && !/^-?\d+$/.test(value.value)) {
				return `${path} requires an exact signed integer`;
			}
			if (value.kind === "uint" && !/^\d+$/.test(value.value)) {
				return `${path} requires an exact unsigned integer`;
			}
			if (
				value.kind === "guid" &&
				!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value.value)
			) {
				return `${path} requires a canonical GUID`;
			}
			return undefined;
		case "enum":
			if (value.kind !== "enum") return `${path} requires an enum value`;
			return type.options.some((option) => option.name === value.value)
				? undefined
				: `${path} is not one of the declared enum options`;
		case "reference":
			return value.kind === type.valueKind ? undefined : `${path} requires ${type.valueKind}`;
		case "vector":
			return value.kind === "vector" ? undefined : `${path} requires a vector`;
		case "array":
		case "set": {
			if (value.kind !== type.kind) return `${path} requires ${type.kind}`;
			for (const [index, item] of value.values.entries()) {
				const mismatch = authoringValueCompatibility(
					item,
					type.element,
					`${path}[${index}]`
				);
				if (mismatch !== undefined) return mismatch;
			}
			return undefined;
		}
		case "map": {
			if (value.kind !== "map") return `${path} requires a map`;
			for (const [index, entry] of value.entries.entries()) {
				const keyMismatch = authoringValueCompatibility(
					entry.key,
					type.key,
					`${path}.key[${index}]`
				);
				if (keyMismatch !== undefined) return keyMismatch;
				const entryMismatch = authoringValueCompatibility(
					entry.value,
					type.value,
					`${path}.value[${index}]`
				);
				if (entryMismatch !== undefined) return entryMismatch;
			}
			return undefined;
		}
		case "struct": {
			if (value.kind !== "struct") return `${path} requires a struct`;
			for (const descriptor of type.fields) {
				const field = value.fields.find((candidate) => candidate.name === descriptor.name);
				if (!field) {
					if (descriptor.presence === "required") {
						return `${path}.${descriptor.name} is required`;
					}
					continue;
				}
				const mismatch = authoringValueCompatibility(
					field.value,
					descriptor.type,
					`${path}.${descriptor.name}`
				);
				if (mismatch !== undefined) return mismatch;
			}
			return undefined;
		}
		case "unsupported":
			return `${path} uses unsupported type ${type.typeName}`;
	}
}

function validateCellEdit(
	table: AuthoringTableSnapshot,
	field: AuthoringFieldValue,
	value: AuthoringValue
): void {
	if (!("schema" in table.table) || table.table.schema.status !== "available") {
		if (field.value.kind === "unsupported") {
			return rowIntentError(
				"unsupported_edit",
				`Field ${field.name} is represented as an unsupported value`,
				"Use a compatible live authoring producer or leave this field unchanged."
			);
		}
		if (field.value.kind !== value.kind) {
			return rowIntentError(
				"incompatible_value",
				`Field ${field.name} requires ${field.value.kind}, received ${value.kind}`,
				"Submit a value with the same typed authoring kind as the current field."
			);
		}
		return;
	}
	const descriptor = table.table.schema.fields.find((candidate) => candidate.name === field.name);
	if (!descriptor) {
		return rowIntentError(
			"missing_field",
			`Field ${field.name} is absent from the table schema`,
			"Refresh the table schema before editing this field."
		);
	}
	if (descriptor.editability.kind === "read_only" || descriptor.annotations.readOnly) {
		return rowIntentError(
			"unsupported_edit",
			`Field ${field.name} is read-only: ${
				descriptor.editability.kind === "read_only"
					? descriptor.editability.reason
					: "schema annotation"
			}`,
			"Leave the field unchanged or edit it through an authority that permits mutation."
		);
	}
	const mismatch = authoringValueCompatibility(value, descriptor.type, field.name);
	if (mismatch !== undefined) {
		return rowIntentError(
			"incompatible_value",
			mismatch,
			"Submit a value compatible with the reflected authoring field schema."
		);
	}
}

function validateNewRowName(table: AuthoringTableSnapshot, rowName: string, rowId?: string): void {
	if (rowName.length === 0 || rowName.toLowerCase() === "none" || rowName.includes("\0")) {
		rowIntentError(
			"invalid_row_name",
			`Row name ${JSON.stringify(rowName)} cannot be represented as an Unreal FName`,
			"Choose a non-empty row name other than None."
		);
	}
	const duplicate = table.table.rows.find(
		(row) => row.id !== rowId && row.name.toLowerCase() === rowName.toLowerCase()
	);
	if (duplicate) {
		rowIntentError(
			"duplicate_row_name",
			`Row ${rowName} conflicts with existing row ${duplicate.name}`,
			"Choose a row name that is unique without regard to letter case."
		);
	}
}

function rowEnvelope(args: RowCommandMetadata, body: AuthoringCommand): CommandEnvelope {
	return {
		authoredAt: args.authoredAt,
		baseFingerprint: baseFingerprint(args.session, args.tableObjectPath),
		body,
		groupId: args.groupId,
		id: args.commandId,
		tableObjectPath: args.tableObjectPath,
		...(args.author === undefined ? {} : { author: args.author })
	};
}

function defaultRow(table: AuthoringTableSnapshot, rowId: string, rowName: string): AuthoringRow {
	if (!("schema" in table.table) || table.table.schema.status !== "available") {
		return rowIntentError(
			"unsupported_add",
			`Table ${table.table.objectPath} does not expose schema-proven field defaults`,
			"Open the table through an authoring v2 producer with an available schema, or duplicate an existing row."
		);
	}
	const fields = table.table.schema.fields.map((field): AuthoringFieldValue => {
		if (field.defaultValue.status !== "known") {
			return rowIntentError(
				"unsupported_add",
				`Field ${field.name} has no schema-proven default value`,
				"Duplicate an existing row, or use a producer that reports this field's default."
			);
		}
		return { name: field.name, typeName: field.typeName, value: field.defaultValue.value };
	});
	return { fields, id: rowId, name: rowName };
}

export function buildAddRowCommand(
	args: RowCommandMetadata & {
		readonly rowId: string;
		readonly rowName: string;
		readonly atIndex?: number;
	}
): CommandEnvelope {
	const table = workingTable(args.session, args.tableObjectPath);
	validateNewRowName(table, args.rowName);
	const atIndex = args.atIndex ?? table.table.rows.length;
	if (!Number.isInteger(atIndex) || atIndex < 0 || atIndex > table.table.rows.length) {
		return rowIntentError(
			"invalid_row_order",
			`Add index ${atIndex} is outside the table row range`,
			`Choose an insertion index from 0 through ${table.table.rows.length}.`
		);
	}
	return rowEnvelope(args, {
		atIndex,
		kind: "add_row",
		row: defaultRow(table, args.rowId, args.rowName)
	});
}

export function buildDuplicateRowCommand(
	args: RowCommandMetadata & {
		readonly sourceRowId: string;
		readonly rowId: string;
		readonly rowName: string;
		readonly atIndex?: number;
	}
): CommandEnvelope {
	const table = workingTable(args.session, args.tableObjectPath);
	const sourceIndex = table.table.rows.findIndex((row) => row.id === args.sourceRowId);
	if (sourceIndex === -1) {
		return rowIntentError(
			"row_not_found",
			`Row ${args.sourceRowId} does not exist`,
			"Refresh the session and choose an existing row to duplicate."
		);
	}
	validateNewRowName(table, args.rowName);
	const atIndex = args.atIndex ?? sourceIndex + 1;
	if (!Number.isInteger(atIndex) || atIndex < 0 || atIndex > table.table.rows.length) {
		return rowIntentError(
			"invalid_row_order",
			`Duplicate index ${atIndex} is outside the table row range`,
			`Choose an insertion index from 0 through ${table.table.rows.length}.`
		);
	}
	const source = table.table.rows[sourceIndex]!;
	return rowEnvelope(args, {
		atIndex,
		kind: "add_row",
		row: { fields: source.fields, id: args.rowId, name: args.rowName }
	});
}

export function buildRemoveRowCommand(
	args: RowCommandMetadata & { readonly rowId: string }
): CommandEnvelope {
	const table = workingTable(args.session, args.tableObjectPath);
	const atIndex = table.table.rows.findIndex((row) => row.id === args.rowId);
	if (atIndex === -1) {
		return rowIntentError(
			"row_not_found",
			`Row ${args.rowId} does not exist`,
			"Refresh the session and choose an existing row to remove."
		);
	}
	return rowEnvelope(args, { atIndex, kind: "remove_row", row: table.table.rows[atIndex]! });
}

export function buildRenameRowCommand(
	args: RowCommandMetadata & { readonly rowId: string; readonly rowName: string }
): CommandEnvelope {
	const table = workingTable(args.session, args.tableObjectPath);
	const row = table.table.rows.find((candidate) => candidate.id === args.rowId);
	if (!row) {
		return rowIntentError(
			"row_not_found",
			`Row ${args.rowId} does not exist`,
			"Refresh the session and choose an existing row to rename."
		);
	}
	validateNewRowName(table, args.rowName, row.id);
	return rowEnvelope(args, {
		kind: "rename_row",
		newName: args.rowName,
		oldName: row.name,
		rowId: row.id
	});
}

export function buildReorderRowsCommand(
	args: RowCommandMetadata & { readonly rowIds: readonly string[] }
): CommandEnvelope {
	const table = workingTable(args.session, args.tableObjectPath);
	const oldOrder = table.table.rows.map((row) => row.id);
	const requested = [...args.rowIds];
	if (
		requested.length !== oldOrder.length ||
		new Set(requested).size !== requested.length ||
		requested.some((rowId) => !oldOrder.includes(rowId))
	) {
		return rowIntentError(
			"invalid_row_order",
			"Reorder must name every current row identity exactly once",
			"Refresh the session and submit a complete permutation of the current row identities."
		);
	}
	return rowEnvelope(args, { kind: "reorder_rows", newOrder: requested, oldOrder });
}

export function invertCommand(command: AuthoringCommand): AuthoringCommand {
	switch (command.kind) {
		case "set_cell":
			return { ...command, newValue: command.oldValue, oldValue: command.newValue };
		case "add_row":
			return { atIndex: command.atIndex, kind: "remove_row", row: command.row };
		case "remove_row":
			return { atIndex: command.atIndex, kind: "add_row", row: command.row };
		case "rename_row":
			return {
				kind: "rename_row",
				newName: command.oldName,
				oldName: command.newName,
				rowId: command.rowId
			};
		case "reorder_rows":
			return { kind: "reorder_rows", newOrder: command.oldOrder, oldOrder: command.newOrder };
	}
}
