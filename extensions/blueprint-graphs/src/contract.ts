import { BlueprintGraphRead } from "@ue-shed/protocol";
import { Schema } from "effect";

export const BlueprintAssetPath = Schema.Trim.check(
	Schema.isNonEmpty(),
	Schema.isMaxLength(32_768)
);
export type BlueprintAssetPath = Schema.Schema.Type<typeof BlueprintAssetPath>;

export const BLUEPRINT_ASSET_SEARCH_LIMIT = 80;

export const BlueprintAssetSearchRequest = Schema.Struct({
	query: Schema.Trim.check(Schema.isMaxLength(256))
});
export interface BlueprintAssetSearchRequest extends Schema.Schema.Type<
	typeof BlueprintAssetSearchRequest
> {}

export const BlueprintAssetCandidate = Schema.Struct({
	assetName: Schema.NonEmptyString.check(Schema.isMaxLength(1_024)),
	assetPath: BlueprintAssetPath,
	className: Schema.NonEmptyString.check(Schema.isMaxLength(1_024)),
	packageName: Schema.NonEmptyString.check(Schema.isMaxLength(32_768)),
	relativePath: Schema.NonEmptyString.check(Schema.isMaxLength(32_768))
});
export interface BlueprintAssetCandidate extends Schema.Schema.Type<
	typeof BlueprintAssetCandidate
> {}

export const BlueprintAssetSearchResult = Schema.Union([
	Schema.Struct({ status: Schema.Literal("not_configured") }),
	Schema.Struct({
		assets: Schema.Array(BlueprintAssetCandidate).check(
			Schema.isMaxLength(BLUEPRINT_ASSET_SEARCH_LIMIT)
		),
		matchCount: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
		projectName: Schema.NonEmptyString,
		status: Schema.Literal("ready")
	}),
	Schema.Struct({
		message: Schema.NonEmptyString,
		recovery: Schema.NonEmptyString,
		status: Schema.Literal("failed")
	})
]);
export type BlueprintAssetSearchResult = Schema.Schema.Type<typeof BlueprintAssetSearchResult>;

export const BlueprintGraphFailureReason = Schema.Literals([
	"control_rig",
	"malformed_package",
	"missing_reader",
	"reader_failure",
	"unsupported_asset",
	"unsupported_version"
]);
export type BlueprintGraphFailureReason = Schema.Schema.Type<typeof BlueprintGraphFailureReason>;

export const BlueprintGraphReadResult = Schema.Union([
	Schema.Struct({
		assetPath: BlueprintAssetPath,
		...BlueprintGraphRead.fields,
		status: Schema.Literal("ready")
	}),
	Schema.Struct({ status: Schema.Literal("cancelled") }),
	Schema.Struct({
		assetPath: Schema.optionalKey(BlueprintAssetPath),
		message: Schema.NonEmptyString,
		reason: BlueprintGraphFailureReason,
		recovery: Schema.NonEmptyString,
		status: Schema.Literal("failed")
	})
]);
export type BlueprintGraphReadResult = Schema.Schema.Type<typeof BlueprintGraphReadResult>;
