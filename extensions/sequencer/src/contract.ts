import { LevelSequenceRead } from "@ue-shed/protocol";
import { Schema } from "effect";

export const SequenceAssetPath = Schema.Trim.check(Schema.isNonEmpty(), Schema.isMaxLength(32_768));
export type SequenceAssetPath = Schema.Schema.Type<typeof SequenceAssetPath>;

export const SEQUENCE_ASSET_SEARCH_LIMIT = 80;

export const SequenceAssetSearchRequest = Schema.Struct({
	query: Schema.Trim.check(Schema.isMaxLength(256))
});
export interface SequenceAssetSearchRequest extends Schema.Schema.Type<
	typeof SequenceAssetSearchRequest
> {}

export const SequenceAssetCandidate = Schema.Struct({
	assetName: Schema.NonEmptyString.check(Schema.isMaxLength(1_024)),
	assetPath: SequenceAssetPath,
	className: Schema.NonEmptyString.check(Schema.isMaxLength(1_024)),
	packageName: Schema.NonEmptyString.check(Schema.isMaxLength(32_768)),
	relativePath: Schema.NonEmptyString.check(Schema.isMaxLength(32_768))
});
export interface SequenceAssetCandidate extends Schema.Schema.Type<typeof SequenceAssetCandidate> {}

export const SequenceAssetSearchResult = Schema.Union([
	Schema.Struct({ status: Schema.Literal("not_configured") }),
	Schema.Struct({
		assets: Schema.Array(SequenceAssetCandidate).check(
			Schema.isMaxLength(SEQUENCE_ASSET_SEARCH_LIMIT)
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
export type SequenceAssetSearchResult = Schema.Schema.Type<typeof SequenceAssetSearchResult>;

export const SequenceFailureReason = Schema.Literals([
	"malformed_package",
	"missing_reader",
	"reader_failure",
	"unsupported_asset",
	"unsupported_version"
]);
export type SequenceFailureReason = Schema.Schema.Type<typeof SequenceFailureReason>;

export const SequenceReadFailure = Schema.Struct({
	status: Schema.Literal("failed"),
	assetPath: Schema.optionalKey(SequenceAssetPath),
	reason: SequenceFailureReason,
	message: Schema.NonEmptyString,
	recovery: Schema.NonEmptyString
});
export type SequenceReadFailure = Schema.Schema.Type<typeof SequenceReadFailure>;

export const SequenceReadResult = Schema.Union([
	Schema.Struct({
		status: Schema.Literal("ready"),
		assetPath: SequenceAssetPath,
		...LevelSequenceRead.fields
	}),
	Schema.Struct({ status: Schema.Literal("cancelled") }),
	SequenceReadFailure
]);
export type SequenceReadResult = Schema.Schema.Type<typeof SequenceReadResult>;
