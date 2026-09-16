import { Schema } from "effect";

const ProcessId = Schema.Int.check(Schema.isGreaterThan(0), Schema.isLessThan(4_294_967_295));

export const EditorWindowActivationRequest = Schema.Struct({ expectedProcessId: ProcessId });
export type EditorWindowActivationRequest = typeof EditorWindowActivationRequest.Type;

export const EditorWindowActivationResult = Schema.Struct({
	schemaVersion: Schema.Literal(1),
	processId: ProcessId,
	status: Schema.Literals([
		"activated",
		"blocked",
		"unavailable",
		"unsupported",
		"target_changed"
	]),
	target: Schema.Literals(["main_editor", "modal", "none"]),
	restored: Schema.Boolean,
	message: Schema.String,
	recovery: Schema.String
});
export type EditorWindowActivationResult = typeof EditorWindowActivationResult.Type;
