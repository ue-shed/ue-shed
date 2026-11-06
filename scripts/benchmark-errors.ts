import { ErrorGuidanceFields } from "../packages/protocol/dist/errors.js";
import { type Brand, Schema } from "effect";

/** The requested measurement has no trustworthy timing or packet evidence. */
export class BenchmarkMeasurementError extends Schema.TaggedError<
	BenchmarkMeasurementError,
	Brand.Brand<"scripts/benchmark-errors/BenchmarkMeasurementError">
>()("BenchmarkMeasurementError", {
	...ErrorGuidanceFields,
	code: Schema.Literals(["phase_timing_missing", "no_packets", "packet_bounds_missing"])
}) {}
