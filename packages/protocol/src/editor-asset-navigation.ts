import { Schema } from "effect";

export const EditorAssetNavigationContract = Schema.Struct({
	name: Schema.Literal("unreal-editor-asset-navigation"),
	version: Schema.Struct({ major: Schema.Literal(1), minor: Schema.Literal(0) })
});
export type EditorAssetNavigationContract = Schema.Schema.Type<
	typeof EditorAssetNavigationContract
>;

export const EditorAssetLocateUnavailableReason = Schema.Literals([
	"asset_not_found",
	"capability_missing",
	"editor_unavailable",
	"invalid_object_path",
	"not_connected"
]);
export type EditorAssetLocateUnavailableReason = Schema.Schema.Type<
	typeof EditorAssetLocateUnavailableReason
>;

const EditorAssetLocateBase = Schema.Struct({
	contract: EditorAssetNavigationContract,
	objectPath: Schema.String
});

export const EditorAssetLocateResult = Schema.Union([
	Schema.Struct({
		...EditorAssetLocateBase.fields,
		status: Schema.Literal("located")
	}),
	Schema.Struct({
		...EditorAssetLocateBase.fields,
		message: Schema.String,
		reason: EditorAssetLocateUnavailableReason,
		recovery: Schema.String,
		retrySafe: Schema.Boolean,
		status: Schema.Literal("unavailable")
	})
]);
export type EditorAssetLocateResult = Schema.Schema.Type<typeof EditorAssetLocateResult>;

export const decodeEditorAssetLocateResult = Schema.decodeUnknownEffect(EditorAssetLocateResult);
