import { InMemorySpanExporter, SimpleSpanProcessor } from "@opentelemetry/sdk-trace-base";
import { it } from "@effect/vitest";
import { ConfigProvider, Effect, Metric } from "effect";
import { expect } from "vitest";
import {
	aggregateHealth,
	defaultHealthInput,
	observeOperation,
	observatoryMetrics,
	operationMetrics,
	recordReviewAssessment,
	recordObservatoryCadence,
	recordObservatoryPacket,
	recordObservatoryPaintDuration,
	RuntimeHealthService,
	reviewAssessmentMetrics,
	runtimeObservabilityLayer
} from "./index.js";

it.effect("captures a named domain operation through the real runtime telemetry layer", () => {
	const exporter = new InMemorySpanExporter();
	return Effect.gen(function* () {
		expect(yield* observeOperation("Authoring.testOperation", Effect.succeed("done"))).toBe(
			"done"
		);
		yield* Effect.tryPromise(() => exporter.forceFlush());
		const span = exporter
			.getFinishedSpans()
			.find(({ name }) => name === "Authoring.testOperation");
		expect(span?.attributes.operation).toBe("Authoring.testOperation");
	}).pipe(
		Effect.provide(
			runtimeObservabilityLayer({
				serviceName: "ue-shed-test",
				spanProcessor: new SimpleSpanProcessor(exporter)
			})
		),
		Effect.provide(
			ConfigProvider.layer(ConfigProvider.fromUnknown({ UE_SHED_TELEMETRY_MODE: "disabled" }))
		)
	);
});

it.effect("updates operation traffic, error, and latency metrics", () =>
	Effect.gen(function* () {
		const beforeTraffic = yield* Metric.value(operationMetrics.traffic);
		const beforeErrors = yield* Metric.value(operationMetrics.errors);
		yield* observeOperation("Observability.success", Effect.void);
		yield* observeOperation("Observability.failure", Effect.fail("expected")).pipe(
			Effect.ignore
		);
		const afterTraffic = yield* Metric.value(operationMetrics.traffic);
		const afterErrors = yield* Metric.value(operationMetrics.errors);
		const latency = yield* Metric.value(operationMetrics.latency);
		expect(afterTraffic.count - beforeTraffic.count).toBe(2);
		expect(afterErrors.count - beforeErrors.count).toBe(1);
		expect(latency.count).toBeGreaterThanOrEqual(2);
	})
);

it.effect("provides disabled and console telemetry modes through Effect Config", () =>
	Effect.gen(function* () {
		const health = yield* RuntimeHealthService;
		expect((yield* health.snapshot()).telemetry).toBe("ready");
	}).pipe(
		Effect.provide(runtimeObservabilityLayer({ serviceName: "ue-shed-test" })),
		Effect.provide(
			ConfigProvider.layer(ConfigProvider.fromUnknown({ UE_SHED_TELEMETRY_MODE: "console" }))
		)
	)
);

it.effect("updates Observatory packet and paint metrics", () =>
	Effect.gen(function* () {
		const beforePackets = yield* Metric.value(observatoryMetrics.packets);
		const beforePaint = yield* Metric.value(observatoryMetrics.paintDuration);
		yield* recordObservatoryPacket({
			actorsChanged: 4,
			actorsSampled: 8,
			bytes: 288,
			decodeApplyMs: 1.5,
			producerReplacements: 1,
			sequenceGap: true
		});
		yield* recordObservatoryPaintDuration(2.25);
		yield* recordObservatoryCadence({ presentationHz: 60, sampleHz: 60 });
		const afterPackets = yield* Metric.value(observatoryMetrics.packets);
		const afterPaint = yield* Metric.value(observatoryMetrics.paintDuration);
		const sampleHz = yield* Metric.value(observatoryMetrics.sampleHz);
		expect(afterPackets.count - beforePackets.count).toBe(1);
		expect(afterPaint.count - beforePaint.count).toBe(1);
		expect(sampleHz.value).toBe(60);
	})
);

it.effect("records bounded Map Review assessment telemetry without identity labels", () =>
	Effect.gen(function* () {
		const beforeAttempts = yield* Metric.value(reviewAssessmentMetrics.attempts);
		const beforeFailures = yield* Metric.value(reviewAssessmentMetrics.failures);
		const beforeDuration = yield* Metric.value(reviewAssessmentMetrics.duration);
		const beforeSamples = yield* Metric.value(reviewAssessmentMetrics.samples);
		yield* recordReviewAssessment({
			assessmentDurationMs: 2.5,
			sampleCount: 576,
			status: "assessed"
		});
		yield* recordReviewAssessment({ status: "assessment_failed" });
		const afterAttempts = yield* Metric.value(reviewAssessmentMetrics.attempts);
		const afterFailures = yield* Metric.value(reviewAssessmentMetrics.failures);
		const afterDuration = yield* Metric.value(reviewAssessmentMetrics.duration);
		const afterSamples = yield* Metric.value(reviewAssessmentMetrics.samples);
		expect(afterAttempts.count - beforeAttempts.count).toBe(2);
		expect(afterFailures.count - beforeFailures.count).toBe(1);
		expect(afterDuration.count - beforeDuration.count).toBe(1);
		expect(afterSamples.count - beforeSamples.count).toBe(1);
	})
);

it("aggregates optional absence, reconnection, required failures, and telemetry gaps", () => {
	expect(
		aggregateHealth({
			...defaultHealthInput,
			capabilities: [{ available: false, name: "review", required: false }]
		}).status
	).toBe("healthy");
	expect(aggregateHealth({ ...defaultHealthInput, connection: "reconnecting" }).status).toBe(
		"degraded"
	);
	expect(
		aggregateHealth({
			...defaultHealthInput,
			capabilities: [{ available: false, name: "authoring", required: true }]
		}).status
	).toBe("unhealthy");
	expect(aggregateHealth({ ...defaultHealthInput, telemetry: "degraded" }).status).toBe(
		"degraded"
	);
});
