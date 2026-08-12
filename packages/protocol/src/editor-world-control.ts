import { Schema } from "effect";

const PackagePath = Schema.String.check(
	Schema.isMinLength(1),
	Schema.isMaxLength(1_024),
	Schema.isPattern(/^\/[A-Za-z0-9_./-]+$/)
);

const GameMapPath = PackagePath.check(Schema.isPattern(/^\/Game\/[A-Za-z0-9_./-]+$/));

const OperationId = Schema.String.check(
	Schema.isMinLength(1),
	Schema.isMaxLength(128),
	Schema.isPattern(/^[A-Za-z0-9][A-Za-z0-9._-]*$/)
).pipe(Schema.brand("EditorWorldOperationId"));

export const EditorWorldControlContract = Schema.Struct({
	name: Schema.Literal("unreal-editor-world-control"),
	version: Schema.Struct({ major: Schema.Literal(1), minor: Schema.Literal(0) })
});
export interface EditorWorldControlContract extends Schema.Schema.Type<
	typeof EditorWorldControlContract
> {}

export const EditorWorldOpenRequest = Schema.Struct({
	contract: EditorWorldControlContract,
	operationId: OperationId,
	targetMapPath: GameMapPath
});
export interface EditorWorldOpenRequest extends Schema.Schema.Type<typeof EditorWorldOpenRequest> {}

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

export const decodeEditorWorldOpenRequest = Schema.decodeUnknownEffect(EditorWorldOpenRequest);
export const decodeEditorWorldOpenResponse = Schema.decodeUnknownEffect(EditorWorldOpenResponse);
