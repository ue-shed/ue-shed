import {
	AuthoringApplyRequest,
	GameTextActionEdit,
	GameTextActionsResult
} from "@ue-shed/protocol";
import { Schema } from "effect";
import { TextUnitId } from "./identifiers.js";
import { TextOccurrence } from "./schema.js";

/** A reviewed saved place and the requested edit; hosts resolve these IDs again before planning. */
export const TextIdRepairChange = Schema.Struct({
	unitId: TextUnitId,
	occurrence: TextOccurrence,
	edit: GameTextActionEdit
});
export type TextIdRepairChange = typeof TextIdRepairChange.Type;

/** Bounded proposal input, tied to the host's selected project. No filesystem authority is granted. */
export const TextIdRepairRequest = Schema.Struct({
	projectKey: Schema.NonEmptyString,
	title: Schema.NonEmptyString.check(Schema.isMaxLength(4096)),
	changes: Schema.Array(TextIdRepairChange).check(Schema.isMinLength(1), Schema.isMaxLength(256))
});
export type TextIdRepairRequest = typeof TextIdRepairRequest.Type;

/** Durable proposal ID. It is a filename-safe UUID, never a caller-selected path. */
export const TextIdRepairId = Schema.String.check(
	Schema.isPattern(/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/u)
).pipe(Schema.brand("TextIdRepairId"));
export type TextIdRepairId = typeof TextIdRepairId.Type;

/** Saved preview. Applying this ID explicitly approves compilation and saving its listed packages. */
export const TextIdRepairPlan = Schema.Struct({
	id: TextIdRepairId,
	request: TextIdRepairRequest,
	endpoint: Schema.String,
	sessionId: Schema.String,
	preview: GameTextActionsResult,
	artifact: Schema.String,
	authoring: Schema.optionalKey(AuthoringApplyRequest)
});
export type TextIdRepairPlan = typeof TextIdRepairPlan.Type;

/** A repair receipt retains native per-place outcomes, persistence and recovery information. */
export const TextIdRepairResult = Schema.Union([
	Schema.Struct({ status: Schema.Literal("prepared"), plan: TextIdRepairPlan }),
	Schema.Struct({
		status: Schema.Literal("finished"),
		plan: TextIdRepairPlan,
		result: GameTextActionsResult,
		verified: Schema.Boolean
	}),
	Schema.Struct({
		status: Schema.Literal("unavailable"),
		message: Schema.String,
		recovery: Schema.String,
		retrySafe: Schema.Boolean,
		nextStep: Schema.Literals(["fix_input", "retry", "reconcile", "escalate"])
	})
]);
export type TextIdRepairResult = typeof TextIdRepairResult.Type;

/** Two occurrences are the same reviewed place only when their saved provenance also agrees. */
export function sameRepairOccurrence(left: TextOccurrence, right: TextOccurrence): boolean {
	return sameOccurrence(left, right);
}
const sameOccurrence = Schema.toEquivalence(TextOccurrence);
