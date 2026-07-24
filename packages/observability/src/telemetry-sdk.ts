import { NodeSdk } from "@effect/opentelemetry";
import { ConsoleLogRecordExporter, SimpleLogRecordProcessor } from "@opentelemetry/sdk-logs";
import { ConsoleMetricExporter, PeriodicExportingMetricReader } from "@opentelemetry/sdk-metrics";
import { ConsoleSpanExporter, SimpleSpanProcessor } from "@opentelemetry/sdk-trace-base";
import type { RuntimeObservabilityOptions, TelemetryMode } from "./index.js";

/**
 * OpenTelemetry SDK wiring for `runtimeObservabilityLayer`, isolated so runtimes with telemetry
 * disabled never pay the SDK module-evaluation cost. `index.ts` imports this module lazily and
 * only when telemetry is enabled or an explicit span processor is provided.
 */
export function telemetrySdkLayer(options: RuntimeObservabilityOptions, mode: TelemetryMode) {
	const spanProcessor =
		options.spanProcessor ?? new SimpleSpanProcessor(new ConsoleSpanExporter());
	return NodeSdk.layer(() => ({
		logRecordProcessor:
			mode === "console"
				? new SimpleLogRecordProcessor(new ConsoleLogRecordExporter())
				: undefined,
		metricReader:
			mode === "console"
				? new PeriodicExportingMetricReader({
						exporter: new ConsoleMetricExporter(),
						exportIntervalMillis: 30_000
					})
				: undefined,
		resource: {
			serviceName: options.serviceName,
			...(options.serviceVersion === undefined
				? {}
				: { serviceVersion: options.serviceVersion })
		},
		spanProcessor
	}));
}
