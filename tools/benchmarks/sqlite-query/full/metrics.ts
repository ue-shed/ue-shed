import { Schema } from "effect";
export const BenchmarkRun = Schema.Struct({
	lane: Schema.Literals(["rust", "bun"]),
	round: Schema.Number,
	setupMs: Schema.Number,
	version: Schema.Json,
	runtime: Schema.Record(Schema.String, Schema.String),
	warmups: Schema.Array(
		Schema.Struct({ name: Schema.String, ms: Schema.Number, sha256: Schema.String })
	),
	samples: Schema.Array(
		Schema.Struct({
			name: Schema.String,
			repetition: Schema.Number,
			ms: Schema.Number,
			sha256: Schema.String,
			phases: Schema.Array(Schema.Json),
			callbackGap: Schema.Struct({ maximumDelayMs: Schema.Number, p99DelayMs: Schema.Number })
		})
	),
	memory: Schema.Record(Schema.String, Schema.Number)
});
export type BenchmarkRun = typeof BenchmarkRun.Type;
