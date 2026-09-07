import { aggregateHealth, defaultHealthInput, RuntimeHealthService } from "@ue-shed/observability";
import { CURRENT_PROTOCOL_VERSION } from "@ue-shed/protocol";
import { Effect } from "effect";
import { CliRuntime, printJson } from "./cli-runtime.js";
import { observeCliOperation } from "./cli-operation.js";

export const runVersion = Effect.fn("Cli.workflow.version")(() =>
	observeCliOperation(
		"Version",
		Effect.flatMap(CliRuntime, (runtime) =>
			runtime.print(
				`ue-shed 0.0.0 (protocol ${CURRENT_PROTOCOL_VERSION.major}.${CURRENT_PROTOCOL_VERSION.minor})\n`
			)
		)
	)
);

export const runDoctor = Effect.fn("Cli.workflow.doctor")(() =>
	observeCliOperation(
		"Doctor",
		Effect.gen(function* () {
			const health = yield* Effect.serviceOption(RuntimeHealthService);
			return yield* printJson(
				health._tag === "Some"
					? yield* health.value.snapshot()
					: aggregateHealth(defaultHealthInput)
			);
		})
	)
);

export const runProducerDoctor = Effect.fn("Cli.workflow.producerDoctor")((endpoint: string) =>
	observeCliOperation(
		"ProducerDoctor",
		Effect.gen(function* () {
			const { inspectUnrealProducer, RemoteControlClientLive } = yield* Effect.promise(
				() => import("@ue-shed/unreal-connection")
			);
			const manifest = yield* inspectUnrealProducer(endpoint).pipe(
				Effect.provide(RemoteControlClientLive)
			);
			yield* printJson({ endpoint, ...manifest });
		})
	)
);
