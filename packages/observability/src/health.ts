import { Context, Effect, Layer, Ref, Schema } from "effect";

export const CapabilityHealth = Schema.Struct({
	available: Schema.Boolean,
	name: Schema.String,
	required: Schema.Boolean
});
export interface CapabilityHealth extends Schema.Schema.Type<typeof CapabilityHealth> {}

export const RuntimeHealthInput = Schema.Struct({
	capabilities: Schema.Array(CapabilityHealth),
	connection: Schema.Literals(["not_configured", "connected", "reconnecting", "failed"]),
	reader: Schema.Literals(["not_configured", "ready", "failed"]),
	stream: Schema.Struct({
		drops: Schema.Number,
		gaps: Schema.Number,
		queueDepth: Schema.Number
	}),
	telemetry: Schema.Literals(["disabled", "ready", "degraded"])
});
export interface RuntimeHealthInput extends Schema.Schema.Type<typeof RuntimeHealthInput> {}

export const RuntimeHealth = Schema.Struct({
	...RuntimeHealthInput.fields,
	reasons: Schema.Array(Schema.String),
	status: Schema.Literals(["healthy", "degraded", "unhealthy"])
});
export interface RuntimeHealth extends Schema.Schema.Type<typeof RuntimeHealth> {}

export const defaultHealthInput: RuntimeHealthInput = {
	capabilities: [],
	connection: "not_configured",
	reader: "not_configured",
	stream: { drops: 0, gaps: 0, queueDepth: 0 },
	telemetry: "disabled"
};

export function aggregateHealth(input: RuntimeHealthInput): RuntimeHealth {
	const missingRequired = input.capabilities.filter(
		(capability) => capability.required && !capability.available
	);
	const reasons = [
		...missingRequired.map(
			(capability) => `Required capability unavailable: ${capability.name}`
		),
		...(input.connection === "failed" ? ["Connection failed"] : []),
		...(input.connection === "reconnecting" ? ["Connection is reconnecting"] : []),
		...(input.reader === "failed" ? ["Saved-asset reader failed"] : []),
		...(input.telemetry === "degraded" ? ["Telemetry export is degraded"] : []),
		...(input.stream.gaps > 0 ? [`Stream reported ${input.stream.gaps} gap(s)`] : []),
		...(input.stream.drops > 0 ? [`Stream reported ${input.stream.drops} drop(s)`] : [])
	];
	const unhealthy =
		missingRequired.length > 0 || input.connection === "failed" || input.reader === "failed";
	return {
		...input,
		reasons,
		status: unhealthy ? "unhealthy" : reasons.length > 0 ? "degraded" : "healthy"
	};
}

export interface RuntimeHealthServiceApi {
	readonly report: (input: RuntimeHealthInput) => Effect.Effect<RuntimeHealth>;
	readonly snapshot: () => Effect.Effect<RuntimeHealth>;
}

/** @deprecated Use `RuntimeHealthServiceApi`. */
export type RuntimeHealthServiceShape = RuntimeHealthServiceApi;

export class RuntimeHealthService extends Context.Service<
	RuntimeHealthService,
	RuntimeHealthServiceApi
>()("@ue-shed/observability/RuntimeHealthService") {}

export function runtimeHealthLayer(
	initial: RuntimeHealthInput = defaultHealthInput
): Layer.Layer<RuntimeHealthService> {
	return Layer.effect(
		RuntimeHealthService,
		Effect.gen(function* () {
			const state = yield* Ref.make(aggregateHealth(initial));
			const report = Effect.fn("Observability.RuntimeHealth.report")(
				(input: RuntimeHealthInput) =>
					Ref.set(state, aggregateHealth(input)).pipe(Effect.as(aggregateHealth(input)))
			);
			const snapshot = Effect.fn("Observability.RuntimeHealth.snapshot")(() =>
				Ref.get(state)
			);
			return RuntimeHealthService.of({ report, snapshot });
		})
	);
}
