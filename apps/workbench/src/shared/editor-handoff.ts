import { Schema } from "effect";

export const EditorHandoffNotice = Schema.Struct({
	endpoint: Schema.String,
	message: Schema.NullOr(Schema.String)
});
export type EditorHandoffNotice = typeof EditorHandoffNotice.Type;
