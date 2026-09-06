import type { SpanProcessor } from "@opentelemetry/sdk-trace-base";
import { Config, Effect, Layer, Schema } from "effect";
import { defaultHealthInput, runtimeHealthLayer } from "./health.js";

export * from "./health.js";

export const TelemetryMode = Schema.Literals(["disabled", "console"]);
export type TelemetryMode = typeof TelemetryMode.Type;

export * from "./metrics.js";
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
