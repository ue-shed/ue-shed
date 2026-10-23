import { Effect, Schema, Tracer } from "effect";
import { expect, it } from "vitest";
import { annotateFindingsProfile, FindingsEvaluationProfile } from "./native-findings.js";
import { ruleOperationNames } from "./rules/schema.js";

it("exports stage child spans with measured times and at most 24 kernels", async () => {
	const spans: Tracer.Span[] = [];
	const tracer = Tracer.make({
		span: (options) => {
			const span = new Tracer.NativeSpan(options);
			spans.push(span);
			return span;
		}
	});
	const sample = { wallMs: 2, busyMs: 8, rows: 100, inputs: 10, memoHits: 90 };
	const kernels = Object.fromEntries(
		ruleOperationNames.map((name, index) => [name, { ...sample, busyMs: index }])
	);
	const profile = Schema.decodeUnknownSync(FindingsEvaluationProfile)({
		cached: false,
		wallMs: 10,
		rules: 1,
		findings: 1,
		diagnostics: 0,
		kernels,
		stages: {
			"line.execute": {
				...sample,
				startOffsetMs: 2,
				endOffsetMs: 4,
				memory: {
					peakWorkingSetBytes: 100,
					arenaBytes: 20,
					sideDictionaryBytes: 10,
					liveNodeColumnsBytes: 30,
					memosBytes: 10,
					occurrenceRelationBytes: 10
				},
				kernels
			}
		}
	});
	await Effect.runPromise(
		annotateFindingsProfile(profile, 1_000n).pipe(
			Effect.withSpan("GameText.native.findingsEvaluate"),
			Effect.withTracer(tracer)
		)
	);
	const child = spans.find((span) => span.name.endsWith(".line.execute"))!;
	expect(child.parent).toMatchObject({ value: { spanId: spans[0]!.spanId } });
	expect(child.status).toMatchObject({
		_tag: "Ended",
		startTime: 2_001_000n,
		endTime: 4_001_000n
	});
	expect(child.attributes.size).toBeLessThan(128);
	expect([...child.attributes.keys()].filter((key) => key.includes(".kernel."))).toHaveLength(96);
	expect(child.attributes.get("game_text.findings.memory.peakWorkingSetBytes")).toBe(100);
});
