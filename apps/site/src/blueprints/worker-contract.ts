import { Schema } from "effect";

export const BlueprintWorkerRequest = Schema.Struct({
	path: Schema.NonEmptyString.check(Schema.isMaxLength(32_768)),
	bytes: Schema.instanceOf(ArrayBuffer),
	operation: Schema.optionalKey(
		Schema.Literals(["blueprints", "inspect", "sequencer", "authoring"])
	)
});

export const BlueprintWorkerResponse = Schema.Union([
	Schema.Struct({
		status: Schema.Literals(["ok", "sequenced", "authored"]),
		output: Schema.Unknown
	}),
	Schema.Struct({
		status: Schema.Literal("inspected"),
		inspection: Schema.Unknown,
		sequenceOutput: Schema.Unknown,
		authoringOutput: Schema.Unknown,
		output: Schema.Unknown
	}),
	Schema.Struct({ status: Schema.Literal("failed"), message: Schema.NonEmptyString })
]);
export type BlueprintWorkerResponse = Schema.Schema.Type<typeof BlueprintWorkerResponse>;

export class BlueprintBrowserError extends Schema.TaggedErrorClass<BlueprintBrowserError>()(
	"BlueprintBrowserError",
	{ operation: Schema.String, message: Schema.String }
) {}
