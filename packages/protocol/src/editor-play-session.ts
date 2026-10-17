import { contractParser } from "./contract-parser.js";
import { makeWireJsonSchemaDocument } from "./json-schema.js";
import { Schema } from "effect";

/** The editor play-session contract the UEShedCore plugin implements; only version 1.0 decodes. */
export const EditorPlaySessionContract = Schema.Struct({
	name: Schema.Literal("unreal-editor-play-session"),
	version: Schema.Struct({ major: Schema.Literal(1), minor: Schema.Literal(0) })
});
export interface EditorPlaySessionContract extends Schema.Schema.Type<
	typeof EditorPlaySessionContract
> {}

/** Play In Editor (`play`) or Simulate In Editor (`simulate`). */
export const EditorPlaySessionMode = Schema.Literals(["play", "simulate"]);
export type EditorPlaySessionMode = Schema.Schema.Type<typeof EditorPlaySessionMode>;

/** Identifies one play session; a new start gets a new ID, so a stale ID means the session ended. */
export const EditorPlaySessionId = Schema.NonEmptyString.pipe(Schema.brand("EditorPlaySessionId"));
export type EditorPlaySessionId = Schema.Schema.Type<typeof EditorPlaySessionId>;

const ActiveSessionFields = {
	mode: EditorPlaySessionMode,
	sessionId: EditorPlaySessionId
};

/** The editor's play session: `stopped`, or a session in one of its transitional or running states. */
export const EditorPlaySessionState = Schema.Union([
	Schema.Struct({ status: Schema.Literal("stopped") }),
	Schema.Struct({ status: Schema.Literal("starting"), ...ActiveSessionFields }),
	Schema.Struct({ status: Schema.Literal("running"), ...ActiveSessionFields }),
	Schema.Struct({ status: Schema.Literal("paused"), ...ActiveSessionFields }),
	Schema.Struct({ status: Schema.Literal("stopping"), ...ActiveSessionFields })
]).annotate({ identifier: "EditorPlaySessionState" });
export type EditorPlaySessionState = Schema.Schema.Type<typeof EditorPlaySessionState>;

/** The editor's answer to a state query: the contract it speaks and the current session state. */
export const EditorPlaySessionStateResponse = Schema.Struct({
	contract: EditorPlaySessionContract,
	state: EditorPlaySessionState
}).annotate({ identifier: "EditorPlaySessionStateResponse" });
export type EditorPlaySessionStateResponse = Schema.Schema.Type<
	typeof EditorPlaySessionStateResponse
>;

/** A play-session transition a host asks the editor to make. */
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

/**
 * The outcome of a command. `already_satisfied` means the editor was already in the requested
 * state. `rejected` carries a stable `code` (`invalid_state`, `unavailable`, `unsupported`),
 * prose for people and a recovery step; in every outcome `state` is the state after the command.
 */
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

/**
 * Decodes an editor reply; fails with a schema error when the plugin speaks another contract
 * version or the reply is malformed.
 */
export const decodeEditorPlaySessionStateResponse = contractParser(
	EditorPlaySessionStateResponse,
	"EditorPlaySessionStateResponse"
);
/**
 * Decodes a command reply; fails with a schema error when the plugin speaks another contract
 * version or the reply is malformed. A rejection decodes successfully as `outcome: "rejected"`.
 */
export const decodeEditorPlaySessionCommandResponse = contractParser(
	EditorPlaySessionCommandResponse,
	"EditorPlaySessionCommandResponse"
);

/**
 * A standalone JSON Schema (draft 2020-12) document for one play-session wire schema, for the
 * language-neutral contract files the C++ plugin is checked against.
 */
export function makeEditorPlaySessionJsonSchema(contract: Schema.Top) {
	const document = makeWireJsonSchemaDocument(contract);
	return {
		$schema: "https://json-schema.org/draft/2020-12/schema",
		$defs: document.definitions,
		...document.schema
	};
}
