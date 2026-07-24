import type { SpanProcessor } from "@opentelemetry/sdk-trace-base";
import { Config, Effect, Exit, Layer, Metric, Schema } from "effect";
import { defaultHealthInput, runtimeHealthLayer } from "./health.js";

export * from "./health.js";

export const TelemetryMode = Schema.Literals(["disabled", "console"]);
export type TelemetryMode = typeof TelemetryMode.Type;

const operationTraffic = Metric.counter("ue_shed_operation_total", {
	description: "Completed UE Shed runtime operations",
	incremental: true
});
const operationErrors = Metric.counter("ue_shed_operation_error_total", {
	description: "Failed UE Shed runtime operations",
	incremental: true
});
const operationLatency = Metric.histogram("ue_shed_operation_duration_ms", {
	boundaries: [1, 5, 10, 25, 50, 100, 250, 500, 1_000, 5_000, 30_000],
	description: "UE Shed operation duration in milliseconds"
});
export const queueDepth = Metric.gauge("ue_shed_queue_depth", {
	description: "Current bounded queue depth"
});
export const streamDrops = Metric.counter("ue_shed_stream_drop_total", {
	description: "Dropped stream items",
	incremental: true
});
export const streamGaps = Metric.counter("ue_shed_stream_gap_total", {
	description: "Detected stream gaps",
	incremental: true
});
export const cameraReplacements = Metric.counter("ue_shed_camera_replacement_total", {
	description: "Camera frames replaced by bounded delivery",
	incremental: true
});
export const authoringTransitions = Metric.frequency("ue_shed_authoring_transition_total", {
	description: "Apply and Save authority transition outcomes"
});
export const coverage = Metric.gauge("ue_shed_coverage_ratio", {
	description: "Domain coverage ratio from zero to one"
});

const observatoryCatalogDuration = Metric.histogram("ue_shed_observatory_catalog_duration_ms", {
	boundaries: [1, 5, 10, 25, 50, 100, 250, 500, 1_000, 5_000],
	description: "Unreal catalog collection duration in milliseconds"
});
const observatoryBoundsCalculations = Metric.counter(
	"ue_shed_observatory_bounds_calculations_total",
	{
		description: "Actor bounds calculations performed during catalog collection",
		incremental: true
	}
);
const observatoryActorsSampled = Metric.counter("ue_shed_observatory_actors_sampled_total", {
	description: "Actors sampled by the Unreal transform producer",
	incremental: true
});
const observatoryActorsChanged = Metric.counter("ue_shed_observatory_actors_changed_total", {
	description: "Actors included in changed-transform packets",
	incremental: true
});
const observatoryPackets = Metric.counter("ue_shed_observatory_packets_total", {
	description: "Decoded Observatory transform packets",
	incremental: true
});
const observatoryBytes = Metric.counter("ue_shed_observatory_bytes_total", {
	description: "Bytes received on the Observatory actor stream",
	incremental: true
});
const observatorySequenceGaps = Metric.counter("ue_shed_observatory_sequence_gap_total", {
	description: "Detected Observatory transform sequence gaps",
	incremental: true
});
const observatoryProducerReplacements = Metric.counter(
	"ue_shed_observatory_producer_replacement_total",
	{
		description: "Producer-side Observatory packet replacements",
		incremental: true
	}
);
const observatoryReceiverReplacements = Metric.counter(
	"ue_shed_observatory_receiver_replacement_total",
	{
		description: "Host receiver Observatory packet replacements",
		incremental: true
	}
);
const observatoryIpcReplacements = Metric.counter("ue_shed_observatory_ipc_replacement_total", {
	description: "Workbench IPC Observatory event replacements",
	incremental: true
});
const observatoryDecodeApplyDuration = Metric.histogram(
	"ue_shed_observatory_decode_apply_duration_ms",
	{
		boundaries: [0.1, 0.25, 0.5, 1, 2, 4, 8, 16.7, 33, 50, 100],
		description: "Decode plus retained-state apply duration in milliseconds"
	}
);
const observatoryPaintDuration = Metric.histogram("ue_shed_observatory_paint_duration_ms", {
	boundaries: [0.1, 0.25, 0.5, 1, 2, 4, 8, 16.7, 33, 50, 100],
	description: "World Scout Canvas paint duration in milliseconds"
});
const observatorySampleHz = Metric.gauge("ue_shed_observatory_sample_hz", {
	description: "Effective Observatory transform sample cadence"
});
const observatoryPresentationHz = Metric.gauge("ue_shed_observatory_presentation_hz", {
	description: "Effective World Scout presentation cadence"
});

export const observatoryMetrics = {
	actorsChanged: observatoryActorsChanged,
	actorsSampled: observatoryActorsSampled,
	boundsCalculations: observatoryBoundsCalculations,
	bytes: observatoryBytes,
	catalogDuration: observatoryCatalogDuration,
	decodeApplyDuration: observatoryDecodeApplyDuration,
	ipcReplacements: observatoryIpcReplacements,
	packets: observatoryPackets,
	paintDuration: observatoryPaintDuration,
	presentationHz: observatoryPresentationHz,
	producerReplacements: observatoryProducerReplacements,
	receiverReplacements: observatoryReceiverReplacements,
	sampleHz: observatorySampleHz,
	sequenceGaps: observatorySequenceGaps
};

export const operationMetrics = {
	errors: operationErrors,
	latency: operationLatency,
	traffic: operationTraffic
};

export function recordStreamState(state: {
	readonly drops: number;
	readonly gaps: number;
	readonly queueDepth: number;
}): Effect.Effect<void> {
	return Effect.all([
		Metric.update(queueDepth, state.queueDepth),
		Metric.update(streamDrops, state.drops),
		Metric.update(streamGaps, state.gaps)
	]).pipe(Effect.asVoid);
}

export const recordCameraReplacements = (count: number): Effect.Effect<void> =>
	Metric.update(cameraReplacements, count);

export const recordAuthoringTransition = (transition: string): Effect.Effect<void> =>
	Metric.update(authoringTransitions, transition);

export const recordCoverage = (ratio: number): Effect.Effect<void> =>
	Metric.update(coverage, Math.max(0, Math.min(1, ratio)));

export function recordObservatoryCatalog(input: {
	readonly boundsCalculations: number;
	readonly durationMs: number;
}): Effect.Effect<void> {
	return Effect.all([
		Metric.update(observatoryCatalogDuration, Math.max(0, input.durationMs)),
		Metric.update(observatoryBoundsCalculations, Math.max(0, input.boundsCalculations))
	]).pipe(Effect.asVoid);
}

export function recordObservatoryPacket(input: {
	readonly actorsChanged: number;
	readonly actorsSampled: number;
	readonly bytes: number;
	readonly decodeApplyMs: number;
	readonly producerReplacements?: number;
	readonly sequenceGap?: boolean;
}): Effect.Effect<void> {
	return Effect.all([
		Metric.update(observatoryPackets, 1),
		Metric.update(observatoryBytes, Math.max(0, input.bytes)),
		Metric.update(observatoryActorsSampled, Math.max(0, input.actorsSampled)),
		Metric.update(observatoryActorsChanged, Math.max(0, input.actorsChanged)),
		Metric.update(observatoryDecodeApplyDuration, Math.max(0, input.decodeApplyMs)),
		Metric.update(
			observatoryProducerReplacements,
			Math.max(0, input.producerReplacements ?? 0)
		),
		Metric.update(observatorySequenceGaps, input.sequenceGap === true ? 1 : 0)
	]).pipe(Effect.asVoid);
}

export const recordObservatoryReceiverReplacements = (count: number): Effect.Effect<void> =>
	Metric.update(observatoryReceiverReplacements, Math.max(0, count));

export const recordObservatoryIpcReplacements = (count: number): Effect.Effect<void> =>
	Metric.update(observatoryIpcReplacements, Math.max(0, count));

export const recordObservatoryPaintDuration = (durationMs: number): Effect.Effect<void> =>
	Metric.update(observatoryPaintDuration, Math.max(0, durationMs));

export function recordObservatoryCadence(input: {
	readonly presentationHz?: number;
	readonly sampleHz?: number;
}): Effect.Effect<void> {
	const updates: Array<Effect.Effect<void>> = [];
	if (input.sampleHz !== undefined) {
		updates.push(Metric.update(observatorySampleHz, Math.max(0, input.sampleHz)));
	}
	if (input.presentationHz !== undefined) {
		updates.push(Metric.update(observatoryPresentationHz, Math.max(0, input.presentationHz)));
	}
	return updates.length === 0 ? Effect.void : Effect.all(updates).pipe(Effect.asVoid);
}

export function observeOperation<A, E, R>(
	name: string,
	effect: Effect.Effect<A, E, R>
): Effect.Effect<A, E, R> {
	return Effect.gen(function* () {
		const started = yield* Effect.clockWith((clock) => clock.currentTimeMillis);
		const exit = yield* Effect.exit(effect);
		const finished = yield* Effect.clockWith((clock) => clock.currentTimeMillis);
		yield* Metric.update(operationTraffic, 1);
		yield* Metric.update(operationLatency, Math.max(0, finished - started));
		if (Exit.isFailure(exit)) yield* Metric.update(operationErrors, 1);
		return yield* exit;
	}).pipe(Effect.withSpan(name), Effect.annotateSpans("operation", name));
}

const telemetryModeConfig = Config.literals(["disabled", "console"], "UE_SHED_TELEMETRY_MODE").pipe(
	Config.withDefault("disabled")
);

export interface RuntimeObservabilityOptions {
	readonly serviceName: string;
	readonly serviceVersion?: string;
	readonly spanProcessor?: SpanProcessor;
}

export function runtimeObservabilityLayer(options: RuntimeObservabilityOptions) {
	return Layer.unwrap(
		Effect.gen(function* () {
			const mode = yield* telemetryModeConfig;
			const health = runtimeHealthLayer({
				...defaultHealthInput,
				telemetry: mode === "disabled" ? "disabled" : "ready"
			});
			if (mode === "disabled" && options.spanProcessor === undefined) {
				// Telemetry is fully disabled: no OpenTelemetry services are installed and the SDK
				// modules are never loaded. Effect spans and metrics keep their in-memory behavior.
				return Layer.merge(Layer.empty, health);
			}
			const { telemetrySdkLayer } = yield* Effect.promise(() => import("./telemetry-sdk.js"));
			return Layer.merge(telemetrySdkLayer(options, mode), health);
		})
	);
}
