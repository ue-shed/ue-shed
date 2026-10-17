import { contractParser } from "./contract-parser.js";
import { Schema } from "effect";

/** The asset-navigation contract the UEShedCore plugin implements; only version 1.0 decodes. */
export const EditorAssetNavigationContract = Schema.Struct({
	name: Schema.Literal("unreal-editor-asset-navigation"),
	version: Schema.Struct({ major: Schema.Literal(1), minor: Schema.Literal(0) })
});
export type EditorAssetNavigationContract = Schema.Schema.Type<
	typeof EditorAssetNavigationContract
>;

/** Why an asset could not be shown in the editor's Content Browser. */
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

/**
 * `located` when the editor showed the asset, otherwise `unavailable` with a stable `reason`,
 * prose for people, a recovery step and whether the same request may simply be retried.
 */
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

/**
 * Decodes a locate reply; fails with a schema error when the reply is malformed or speaks another
 * contract version. A refusal decodes successfully as `status: "unavailable"`.
 */
export const decodeEditorAssetLocateResult = contractParser(
	EditorAssetLocateResult,
	"EditorAssetLocateResult"
);
