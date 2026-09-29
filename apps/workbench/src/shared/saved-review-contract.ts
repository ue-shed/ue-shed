import { LevelSequenceRead } from "@ue-shed/protocol";
import { SavedReviewAsset } from "@ue-shed/unreal-assets/saved-review";
import { Schema } from "effect";

export const SavedReviewFailure = Schema.Struct({
	status: Schema.Literal("failed"),
	message: Schema.NonEmptyString,
	recovery: Schema.NonEmptyString
});
export const SequenceReadResult = Schema.Union([
	Schema.Struct({
		status: Schema.Literal("ready"),
		assetPath: Schema.NonEmptyString,
		...LevelSequenceRead.fields
	}),
	Schema.Struct({ status: Schema.Literal("cancelled") }),
	SavedReviewFailure
]);
export type SequenceReadResult = Schema.Schema.Type<typeof SequenceReadResult>;
export const SavedReviewInventory = Schema.Union([
	Schema.Struct({
		status: Schema.Literal("ready"),
		assets: Schema.Array(SavedReviewAsset),
		generation: Schema.Int
	}),
	SavedReviewFailure
]);
export type SavedReviewInventory = Schema.Schema.Type<typeof SavedReviewInventory>;
