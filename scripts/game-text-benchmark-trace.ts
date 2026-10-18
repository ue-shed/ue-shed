import { Exit, Option, Schema, Tracer } from "effect";
import { GameTextIndexBuildOutcome } from "../packages/protocol/dist/index.js";

const NativeOperation = Schema.Struct({
	action: Schema.String,
	io: GameTextIndexBuildOutcome.fields.io,
	stageSeconds: GameTextIndexBuildOutcome.fields.stageSeconds
});
const TraceRecord = Schema.Struct({
	name: Schema.String,
	spanId: Schema.String,
	parentSpanId: Schema.optionalKey(Schema.String),
	startTimeNs: Schema.String,
	endTimeNs: Schema.String,
	elapsedMs: Schema.Number,
	failed: Schema.Boolean,
	attributes: Schema.Record(Schema.String, Schema.Json),
	native: Schema.optionalKey(NativeOperation)
});
interface TraceRecord extends Schema.Schema.Type<typeof TraceRecord> {}
const isAttribute = Schema.is(
	Schema.NullOr(
		Schema.Union([Schema.String, Schema.Boolean, Schema.Number.check(Schema.isFinite())])
	)
);

/** Inclusive span timings for diagnosis. Records retain neither span exits nor model values. */
export function makeGameTextBenchmarkTrace() {
	let records: TraceRecord[] = [];
	const tracer = Tracer.make({
		span(options) {
			const span = new Tracer.NativeSpan(options);
			if (
				!/^(?:GameTextIndex\.|PackageText\.|NativeIndexBuilder\.|NativeGameText|LocalizationSnapshot\.|LocalizationImport\.|JoinedTarget\.open)/u.test(
					options.name
				)
			)
				return span;
			const end = span.end.bind(span);
			span.end = (endTime, exit) => {
				end(endTime, exit);
				const attributes: Record<string, TraceRecord["attributes"][string]> = {};
				for (const [key, value] of span.attributes)
					if (isAttribute(value)) attributes[key] = value;
				const native =
					Exit.isSuccess(exit) && Schema.is(NativeOperation)(exit.value)
						? {
								action: exit.value.action,
								io: exit.value.io,
								stageSeconds: exit.value.stageSeconds
							}
						: undefined;
				const parent = Option.getOrUndefined(span.parent);
				records.push({
					name: span.name,
					spanId: span.spanId,
					...(parent ? { parentSpanId: parent.spanId } : undefined),
					startTimeNs: options.startTime.toString(),
					endTimeNs: endTime.toString(),
					elapsedMs: Number(endTime - options.startTime) / 1_000_000,
					failed: Exit.isFailure(exit),
					attributes,
					...(native ? { native } : undefined)
				});
			};
			return span;
		}
	});
	return {
		tracer,
		clear: () => {
			records = [];
		},
		drain: () => {
			const captured = records;
			records = [];
			return captured;
		}
	};
}
