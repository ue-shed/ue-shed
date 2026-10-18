import { Schema } from "effect";

/** Immutable snapshot coordinate passed to a scoped native reader or policy worker. */
export const IndexReaderDescriptor = Schema.Struct({
	configuration: Schema.Struct({
		cacheRoot: Schema.NonEmptyString,
		projectKey: Schema.NonEmptyString,
		targetKey: Schema.NonEmptyString,
		projectView: Schema.optionalKey(
			Schema.Union([
				Schema.Struct({ kind: Schema.Literal("source") }),
				Schema.Struct({
					kind: Schema.Literal("localization"),
					target: Schema.NonEmptyString
				})
			])
		)
	}),
	generation: Schema.NonEmptyString,
	joinedKey: Schema.NonEmptyString
});
export type IndexReaderDescriptor = typeof IndexReaderDescriptor.Type;
