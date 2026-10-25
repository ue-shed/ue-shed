import { Schema, Tracer } from "effect";

/** One ended span, as the stage summary needs it. */
interface EndedSpan {
	readonly name: string;
	readonly startNs: bigint;
	readonly endNs: bigint;
	/** The span's numeric `*.stage_ms.*` attributes. */
	readonly stages: ReadonlyMap<string, number>;
	/** Bounded import measures the summary keeps beside the stage times. */
	readonly measures: ReadonlyMap<string, number>;
}

const keptMeasure = (attribute: string) =>
	attribute.startsWith("localization.import.files.") ||
	attribute.startsWith("localization.import.bytes.") ||
	attribute.startsWith("localization.import.slowest") ||
	attribute === "localization.import.workerCount" ||
	attribute === "localization.import.memoryBudgetBytes";

const isMilliseconds = Schema.is(Schema.Finite);

/** Wall time covered by intervals: overlapping spans of one name count once. */
export function coveredMs(intervals: readonly (readonly [bigint, bigint])[]) {
	const sorted = [...intervals].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
	let total = 0n,
		start: bigint | undefined,
		end = 0n;
	for (const [from, to] of sorted) {
		if (start === undefined || from > end) {
			if (start !== undefined) total += end - start;
			start = from;
			end = to;
		} else if (to > end) end = to;
	}
	if (start !== undefined) total += end - start;
	return Number(total) / 1e6;
}

/**
 * Records the spans an effect ends, in this process only, for a stage breakdown of a measured
 * run. Spans of one name report how many ended, the wall time they cover (overlapping spans,
 * such as concurrent reads, count once, never as summed worker time) and the longest one.
 * Numeric `*.stage_ms.*` attributes, the in-step stages of `StageClock`, are summed per name.
 * Workers run their own runtimes: their spans are not recorded, only the coordinator's wait.
 */
export function makeStageRecorder() {
	const ended: EndedSpan[] = [];
	class RecordingSpan extends Tracer.NativeSpan {
		override end(endTime: bigint, exit: Parameters<Tracer.NativeSpan["end"]>[1]) {
			super.end(endTime, exit);
			const stages = new Map<string, number>();
			const measures = new Map<string, number>();
			for (const [attribute, value] of this.attributes) {
				if (attribute.includes(".stage_ms.") && isMilliseconds(value))
					stages.set(attribute, value);
				else if (keptMeasure(attribute) && isMilliseconds(value))
					measures.set(attribute, value);
			}
			ended.push({ name: this.name, startNs: this.startTime, endNs: endTime, stages, measures });
		}
	}
	const tracer = Tracer.make({ span: (options) => new RecordingSpan(options) });
	return {
		tracer,
		/** Flat numeric counts `<prefix>.<span>.<measure>`, ready for a benchmark result. */
		counts(prefix = "stage") {
			const byName = new Map<string, EndedSpan[]>();
			for (const span of ended) {
				const spans = byName.get(span.name) ?? [];
				spans.push(span);
				byName.set(span.name, spans);
			}
			const counts = new Map<string, number>();
			for (const [name, spans] of [...byName].sort(([a], [b]) => (a < b ? -1 : 1))) {
				const key = `${prefix}.${name}`;
				counts.set(`${key}.count`, spans.length);
				counts.set(
					`${key}.wallMs`,
					coveredMs(spans.map((span) => [span.startNs, span.endNs]))
				);
				counts.set(
					`${key}.maxMs`,
					Math.max(...spans.map((span) => Number(span.endNs - span.startNs) / 1e6))
				);
				for (const span of spans)
					for (const [attribute, ms] of span.stages)
						counts.set(
							`${key}.${attribute}`,
							(counts.get(`${key}.${attribute}`) ?? 0) + ms
						);
				for (const span of spans)
					for (const [attribute, ms] of span.measures)
						counts.set(
							`${key}.${attribute}`,
							(counts.get(`${key}.${attribute}`) ?? 0) + ms
						);
			}
			return Object.fromEntries(counts);
		}
	};
}
