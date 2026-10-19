import { Schema } from "effect";
import { contractParser } from "./contract-parser.js";

/** The separately negotiated asset-open contract implemented by UEShedCoreEditor. */
export const EditorAssetOpenContract = Schema.Struct({
	name: Schema.Literal("unreal-editor-asset-open"),
	version: Schema.Struct({ major: Schema.Literal(1), minor: Schema.Literal(0) })
});
export type EditorAssetOpenContract = Schema.Schema.Type<typeof EditorAssetOpenContract>;

/** Stable facts explaining why Unreal could not open the requested asset editor. */
export const EditorAssetOpenUnavailableReason = Schema.Literals([
	"invalid_object_path",
	"editor_unavailable",
	"asset_not_found",
	"asset_load_failed",
	"not_an_asset",
	"editor_refused"
]);
export type EditorAssetOpenUnavailableReason = Schema.Schema.Type<
	typeof EditorAssetOpenUnavailableReason
>;

const EditorAssetOpenBase = Schema.Struct({
	contract: EditorAssetOpenContract,
	objectPath: Schema.String
});

/**
 * `ok` means Unreal accepted the asset-editor open request (including an already open editor).
 * `unavailable` carries a stable reason and recovery guidance. Neither confirms OS foreground focus.
 */
export const EditorAssetOpenResult = Schema.Union([
	Schema.Struct({
		...EditorAssetOpenBase.fields,
		status: Schema.Literal("ok")
	}),
	Schema.Struct({
		...EditorAssetOpenBase.fields,
		status: Schema.Literal("unavailable"),
		reason: EditorAssetOpenUnavailableReason,
		message: Schema.String,
		recovery: Schema.String,
		retrySafe: Schema.Boolean
	})
]);
export type EditorAssetOpenResult = Schema.Schema.Type<typeof EditorAssetOpenResult>;

/** Decodes an open reply; malformed replies and unsupported contract versions are schema errors. */
export const decodeEditorAssetOpenResult = contractParser(
	EditorAssetOpenResult,
	"EditorAssetOpenResult"
);
