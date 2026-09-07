import { Schema } from "effect";
export const NiagaraPreviewProgress = Schema.Struct({
	schemaVersion: Schema.Literal(1),
	runId: Schema.NonEmptyString,
	phase: Schema.Literals([
		"initializing",
		"compiling",
		"camera_fitting",
		"capturing",
		"writing_receipt",
		"completed"
	]),
	completedFrames: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
	totalFrames: Schema.Int.check(Schema.isGreaterThan(0)),
	elapsedMs: Schema.Finite.check(Schema.isGreaterThanOrEqualTo(0))
}).check(Schema.makeFilter((p) => p.completedFrames <= p.totalFrames));
export type NiagaraPreviewProgress = typeof NiagaraPreviewProgress.Type;
