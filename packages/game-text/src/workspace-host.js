import { ErrorGuidanceFields } from "@ue-shed/protocol/errors";
import { Schema } from "effect";
/** A host hook failed; retains its original error and the host's recovery decision. */
export class GameTextWorkspaceHostFailure extends Schema.TaggedError()("GameTextWorkspaceHostFailure", {
    ...ErrorGuidanceFields,
    /** Use `already_exists` when an exclusive create refuses to replace existing bytes. */
    code: Schema.optionalKey(Schema.String),
    cause: Schema.optionalKey(Schema.Defect())
}) {
}
