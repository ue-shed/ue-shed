import { Schema } from "effect";

export const WorkbenchProjectSummary = Schema.Struct({
	inputAtlas: Schema.Literals(["ready", "failed"]),
	mapCount: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
	packageCount: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
	projectName: Schema.NonEmptyString,
	projectRoot: Schema.NonEmptyString
});
export interface WorkbenchProjectSummary extends Schema.Schema.Type<
	typeof WorkbenchProjectSummary
> {}

export const WorkbenchProjectFailure = Schema.Struct({
	message: Schema.NonEmptyString,
	recovery: Schema.NonEmptyString
});
export interface WorkbenchProjectFailure extends Schema.Schema.Type<
	typeof WorkbenchProjectFailure
> {}

/** The selected Workbench project and its cached, header-first package inventory. */
export const WorkbenchProjectState = Schema.Union([
	Schema.Struct({ status: Schema.Literal("not_configured") }),
	Schema.Struct({ status: Schema.Literal("cancelled") }),
	Schema.Struct({ error: WorkbenchProjectFailure, status: Schema.Literal("failed") }),
	Schema.Struct({ project: WorkbenchProjectSummary, status: Schema.Literal("ready") })
]);
export type WorkbenchProjectState = Schema.Schema.Type<typeof WorkbenchProjectState>;
