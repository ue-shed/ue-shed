export {
	SequenceReadResult,
	SequenceReadFailure,
	SequenceFailureReason
} from "@ue-shed/extension-sequencer/contract";
import { SavedReviewAsset } from "@ue-shed/unreal-assets/saved-review";
import { Schema } from "effect";

export const SavedReviewFailure = Schema.Struct({
	status: Schema.Literal("failed"),
	message: Schema.NonEmptyString,
	recovery: Schema.NonEmptyString
});
export const SavedReviewInventory = Schema.Union([
	Schema.Struct({
		status: Schema.Literal("ready"),
		assets: Schema.Array(SavedReviewAsset),
		generation: Schema.Int,
		projectName: Schema.optionalKey(Schema.NonEmptyString)
	}),
	Schema.Struct({
		...SavedReviewFailure.fields,
		status: Schema.Literal("not_configured")
	}),
	SavedReviewFailure
]);
export type SavedReviewInventory = Schema.Schema.Type<typeof SavedReviewInventory>;
