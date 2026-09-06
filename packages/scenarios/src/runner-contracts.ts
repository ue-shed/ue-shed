import { Schema } from "effect";
import type { ScenarioStatusResponse } from "./live.js";
export const ScenarioRunHandle = Schema.Struct({
	endpoint: Schema.NonEmptyString,
	evidenceLimit: Schema.Int.check(Schema.isGreaterThan(0)),
	objectPath: Schema.NonEmptyString,
	pieSessionId: Schema.NonEmptyString,
	runId: Schema.NonEmptyString,
	scenarioId: Schema.NonEmptyString
});
export type ScenarioRunHandle = typeof ScenarioRunHandle.Type;

export type ScenarioRunnerStatus = Exclude<ScenarioStatusResponse, { readonly _tag: "Rejected" }>;
