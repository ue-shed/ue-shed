import { Schema } from "effect";
import {
	AuthoringCommand,
	AuthoringRow,
	AuthoringTableSnapshot,
	AuthoringValue
} from "./authoring.js";

/**
 * Where a session sits on the Draft, Applied, Saved path. `indeterminate` means an Apply or Save
 * reply was lost, so its outcome is unknown and must be reconciled rather than replayed.
 */
export const AuthoringSessionPipeline = Schema.Union([
	Schema.Struct({ canApply: Schema.Boolean, kind: Schema.Literal("draft") }),
	Schema.Struct({ kind: Schema.Literal("applying"), operationId: Schema.String }),
	Schema.Struct({
		id: Schema.String,
		kind: Schema.Literal("indeterminate"),
		operation: Schema.Literals(["apply", "save"])
	}),
	Schema.Struct({ kind: Schema.Literal("applied"), objectPaths: Schema.Array(Schema.String) }),
	Schema.Struct({ kind: Schema.Literal("saving"), requestId: Schema.String }),
	Schema.Struct({ kind: Schema.Literal("saved") })
]).annotate({ identifier: "AuthoringSessionPipeline" });
export type AuthoringSessionPipeline = Schema.Schema.Type<typeof AuthoringSessionPipeline>;

/**
 * A validation finding on a session's working state, located by table and optionally by row and
 * field. Any `error` makes its table and the session invalid; warnings do not.
 */
export const AuthoringReviewDiagnostic = Schema.Struct({
	code: Schema.String,
	fieldName: Schema.optionalKey(Schema.String),
	message: Schema.String,
	path: Schema.optionalKey(Schema.String),
	recovery: Schema.String,
	rowId: Schema.optionalKey(Schema.String),
	severity: Schema.Literals(["error", "warning"]),
	tableObjectPath: Schema.String
}).annotate({ identifier: "AuthoringReviewDiagnostic" });
export interface AuthoringReviewDiagnostic extends Schema.Schema.Type<
	typeof AuthoringReviewDiagnostic
> {}

/**
 * One difference between a table's base snapshot and its working state, derived by diffing rather
 * than copied from the command log. Rows are identified by session-stable `rowId`.
 */
export const AuthoringTableChange = Schema.Union([
	Schema.Struct({ kind: Schema.Literal("row_added"), row: AuthoringRow }),
	Schema.Struct({ kind: Schema.Literal("row_removed"), row: AuthoringRow }),
	Schema.Struct({
		kind: Schema.Literal("row_renamed"),
		newName: Schema.String,
		oldName: Schema.String,
		rowId: Schema.String
	}),
	Schema.Struct({
		fieldName: Schema.String,
		kind: Schema.Literal("cell_changed"),
		newValue: AuthoringValue,
		oldValue: AuthoringValue,
		rowId: Schema.String,
		rowName: Schema.String
	}),
	Schema.Struct({
		kind: Schema.Literal("rows_reordered"),
		newOrder: Schema.Array(Schema.String),
		oldOrder: Schema.Array(Schema.String)
	})
]).annotate({ identifier: "AuthoringTableChange" });
export type AuthoringTableChange = Schema.Schema.Type<typeof AuthoringTableChange>;

/**
 * Review of one table in a session: the base snapshot, the working state folded from active
 * commands, their differences, and its diagnostics. `valid` is false when any diagnostic is an
 * error.
 */
export const AuthoringTableReview = Schema.Struct({
	base: AuthoringTableSnapshot,
	changes: Schema.Array(AuthoringTableChange),
	diagnostics: Schema.Array(AuthoringReviewDiagnostic),
	dirtyCells: Schema.Array(Schema.Struct({ fieldName: Schema.String, rowId: Schema.String })),
	dirtyRowIds: Schema.Array(Schema.String),
	objectPath: Schema.String,
	valid: Schema.Boolean,
	working: AuthoringTableSnapshot
}).annotate({ identifier: "AuthoringTableReview" });
export interface AuthoringTableReview extends Schema.Schema.Type<typeof AuthoringTableReview> {}

/**
 * Commands drafted by one gesture, possibly spanning several tables. `active` is false once the
 * group has been undone; inactive groups remain listed so they can be redone.
 */
export const AuthoringCommandGroupReview = Schema.Struct({
	active: Schema.Boolean,
	author: Schema.optionalKey(Schema.String),
	authoredAt: Schema.String,
	commands: Schema.Array(
		Schema.Struct({
			body: AuthoringCommand,
			id: Schema.String,
			tableObjectPath: Schema.String
		})
	),
	groupId: Schema.String,
	tableObjectPaths: Schema.Array(Schema.String)
}).annotate({ identifier: "AuthoringCommandGroupReview" });
export interface AuthoringCommandGroupReview extends Schema.Schema.Type<
	typeof AuthoringCommandGroupReview
> {}

/**
 * Diagnostics from every table in a session with their error and warning counts. `valid` is false
 * when any diagnostic is an error.
 */
export const AuthoringSessionValidation = Schema.Struct({
	diagnostics: Schema.Array(AuthoringReviewDiagnostic),
	errorCount: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
	valid: Schema.Boolean,
	warningCount: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))
}).annotate({ identifier: "AuthoringSessionValidation" });
export interface AuthoringSessionValidation extends Schema.Schema.Type<
	typeof AuthoringSessionValidation
> {}

/**
 * A reviewable view of one authoring session: every table, command group, validation, undo and
 * redo availability, and pipeline state. `activeCommandCount` is the command log's undo pointer.
 */
export const AuthoringSessionReview = Schema.Struct({
	activeCommandCount: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
	canRedo: Schema.Boolean,
	canUndo: Schema.Boolean,
	commandGroups: Schema.Array(AuthoringCommandGroupReview),
	createdAt: Schema.String,
	lifecycle: Schema.Literals(["open", "closed"]),
	pipeline: AuthoringSessionPipeline,
	project: Schema.Struct({ id: Schema.String, root: Schema.String }),
	sessionId: Schema.String,
	tables: Schema.Array(AuthoringTableReview),
	updatedAt: Schema.String,
	validation: AuthoringSessionValidation
}).annotate({ identifier: "AuthoringSessionReview" });
export interface AuthoringSessionReview extends Schema.Schema.Type<typeof AuthoringSessionReview> {}
