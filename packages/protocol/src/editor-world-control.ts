import { contractParser } from "./contract-parser.js";
import { Schema } from "effect";

const PackagePath = Schema.String.check(
	Schema.isMinLength(1),
	Schema.isMaxLength(1_024),
	Schema.isPattern(/^\/[A-Za-z0-9_./-]+$/u)
);

const GameMapPath = PackagePath.check(Schema.isPattern(/^\/Game\/[A-Za-z0-9_./-]+$/u));

const OperationId = Schema.String.check(
	Schema.isMinLength(1),
	Schema.isMaxLength(128),
	Schema.isPattern(/^[A-Za-z0-9][A-Za-z0-9._-]*$/u)
).pipe(Schema.brand("EditorWorldOperationId"));

/** The editor world-control contract the UEShedCore plugin implements; only version 1.0 decodes. */
export const EditorWorldControlContract = Schema.Struct({
	name: Schema.Literal("unreal-editor-world-control"),
	version: Schema.Struct({ major: Schema.Literal(1), minor: Schema.Literal(0) })
});
export interface EditorWorldControlContract extends Schema.Schema.Type<
	typeof EditorWorldControlContract
> {}

/**
 * Asks the editor to open a map under `/Game/`. `operationId` (1 to 128 characters) names the
 * request, so a host can poll an asynchronous open and a repeated ID is not a second open.
 */
export const EditorWorldOpenRequest = Schema.Struct({
	contract: EditorWorldControlContract,
	operationId: OperationId,
	targetMapPath: GameMapPath
});
export interface EditorWorldOpenRequest extends Schema.Schema.Type<typeof EditorWorldOpenRequest> {}

/**
 * The editor world before or after an open: the map package path, when a map is loaded, unsaved
 * world packages (at most 256 listed) and whether a play session is running.
 */
export const EditorWorldSnapshot = Schema.Struct({
	dirtyWorldPackages: Schema.Array(PackagePath).check(Schema.isMaxLength(256)),
	mapPath: Schema.optionalKey(PackagePath),
	playSessionActive: Schema.Boolean
});
export interface EditorWorldSnapshot extends Schema.Schema.Type<typeof EditorWorldSnapshot> {}

const ResponseFields = {
	after: EditorWorldSnapshot,
	before: EditorWorldSnapshot,
	contract: EditorWorldControlContract,
	operationId: OperationId,
	targetMapPath: GameMapPath
};

/**
 * The outcome of an open, with the world before and after. `rejected` carries a stable `code`;
 * `dirty_world` and `play_session_active` mean the editor refused rather than lose work or
 * interrupt play, and `retrySafe` says whether the same request may simply be sent again.
 */
export const EditorWorldOpenResponse = Schema.Union([
	Schema.Struct({ outcome: Schema.Literal("opened"), ...ResponseFields }),
	Schema.Struct({ outcome: Schema.Literal("already_open"), ...ResponseFields }),
	Schema.Struct({
		outcome: Schema.Literal("rejected"),
		...ResponseFields,
		code: Schema.Literals([
			"dirty_world",
			"invalid_request",
			"map_not_found",
			"open_failed",
			"play_session_active",
			"unavailable"
		]),
		message: Schema.String,
		recovery: Schema.String,
		retrySafe: Schema.Boolean
	})
]).annotate({ identifier: "EditorWorldOpenResponse" });
export type EditorWorldOpenResponse = typeof EditorWorldOpenResponse.Type;

/**
 * Decodes a world-open request; fails with a schema error for a path outside `/Game/`, an invalid
 * operation ID or another contract version.
 */
export const decodeEditorWorldOpenRequest = contractParser(
	EditorWorldOpenRequest,
	"EditorWorldOpenRequest"
);
/**
 * Decodes a world-open reply; fails with a schema error when the reply is malformed or speaks
 * another contract version. A refusal decodes successfully as `outcome: "rejected"`.
 */
export const decodeEditorWorldOpenResponse = contractParser(
	EditorWorldOpenResponse,
	"EditorWorldOpenResponse"
);

/** Acknowledgement/status of an asynchronous open; transport silence is not failure to load. */
export const EditorWorldOperation = Schema.Union([
	Schema.Struct({
		...EditorWorldOpenRequest.fields,
		status: Schema.Literals(["pending", "running"])
	}),
	Schema.Struct({
		...EditorWorldOpenRequest.fields,
		status: Schema.Literal("completed"),
		result: EditorWorldOpenResponse
	}),
	Schema.Struct({
		...EditorWorldOpenRequest.fields,
		status: Schema.Literal("unavailable"),
		code: Schema.Literals(["invalid_request", "busy", "conflict", "unknown_operation"]),
		message: Schema.String,
		recovery: Schema.String
	})
]);
export type EditorWorldOperation = typeof EditorWorldOperation.Type;

/**
 * The editor's project and current world. `projectRoot` is absent when the editor does not report
 * a project directory.
 */
export const EditorWorldState = Schema.Struct({
	contract: EditorWorldControlContract,
	projectName: Schema.String,
	projectRoot: Schema.optionalKey(Schema.NonEmptyString),
	snapshot: EditorWorldSnapshot
});
export interface EditorWorldState extends Schema.Schema.Type<typeof EditorWorldState> {}
