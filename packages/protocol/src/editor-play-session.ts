import { Schema } from "effect";

export const EditorPlaySessionContract = Schema.Struct({
	name: Schema.Literal("unreal-editor-play-session"),
	version: Schema.Struct({ major: Schema.Literal(1), minor: Schema.Literal(0) })
});
export interface EditorPlaySessionContract extends Schema.Schema.Type<
	typeof EditorPlaySessionContract
> {}

export const EditorPlaySessionMode = Schema.Literals(["play", "simulate"]);
export type EditorPlaySessionMode = Schema.Schema.Type<typeof EditorPlaySessionMode>;

export const EditorPlaySessionId = Schema.NonEmptyString.pipe(Schema.brand("EditorPlaySessionId"));
export type EditorPlaySessionId = Schema.Schema.Type<typeof EditorPlaySessionId>;

const ActiveSessionFields = {
	mode: EditorPlaySessionMode,
	sessionId: EditorPlaySessionId
};

export const EditorPlaySessionState = Schema.Union([
	Schema.Struct({ status: Schema.Literal("stopped") }),
	Schema.Struct({ status: Schema.Literal("starting"), ...ActiveSessionFields }),
	Schema.Struct({ status: Schema.Literal("running"), ...ActiveSessionFields }),
	Schema.Struct({ status: Schema.Literal("paused"), ...ActiveSessionFields }),
	Schema.Struct({ status: Schema.Literal("stopping"), ...ActiveSessionFields })
]).annotate({ identifier: "EditorPlaySessionState" });
export type EditorPlaySessionState = Schema.Schema.Type<typeof EditorPlaySessionState>;

export const EditorPlaySessionStateResponse = Schema.Struct({
	contract: EditorPlaySessionContract,
	state: EditorPlaySessionState
}).annotate({ identifier: "EditorPlaySessionStateResponse" });
export type EditorPlaySessionStateResponse = Schema.Schema.Type<
	typeof EditorPlaySessionStateResponse
>;

export const EditorPlaySessionCommand = Schema.Literals([
	"start_play",
	"start_simulate",
	"stop",
	"pause",
	"resume"
]);
export type EditorPlaySessionCommand = Schema.Schema.Type<typeof EditorPlaySessionCommand>;

const CommandFields = {
	command: EditorPlaySessionCommand,
	contract: EditorPlaySessionContract,
	state: EditorPlaySessionState
};

export const EditorPlaySessionCommandResponse = Schema.Union([
	Schema.Struct({ outcome: Schema.Literal("accepted"), ...CommandFields }),
	Schema.Struct({ outcome: Schema.Literal("already_satisfied"), ...CommandFields }),
	Schema.Struct({
		outcome: Schema.Literal("rejected"),
		...CommandFields,
		code: Schema.Literals(["invalid_state", "unavailable", "unsupported"]),
		message: Schema.String,
		recovery: Schema.String
	})
]).annotate({ identifier: "EditorPlaySessionCommandResponse" });
export type EditorPlaySessionCommandResponse = Schema.Schema.Type<
	typeof EditorPlaySessionCommandResponse
>;

export const decodeEditorPlaySessionStateResponse = Schema.decodeUnknownEffect(
	EditorPlaySessionStateResponse
);
export const decodeEditorPlaySessionCommandResponse = Schema.decodeUnknownEffect(
	EditorPlaySessionCommandResponse
);

export function makeEditorPlaySessionJsonSchema(contract: Schema.Top) {
	const document = Schema.toJsonSchemaDocument(contract);
	return {
		$schema: "https://json-schema.org/draft/2020-12/schema",
		$defs: document.definitions,
		...document.schema
	};
}
