import { Context, Effect, Layer, Ref } from "effect";
import type { UnrealConnectionSettings } from "../ipc-contracts.js";
import { WorkbenchConfiguration } from "../workbench-config.js";

export interface WorkbenchUnrealConnectionApi {
	readonly endpoint: () => Effect.Effect<string>;
	readonly settings: () => Effect.Effect<UnrealConnectionSettings>;
	readonly setPort: (port: number) => Effect.Effect<UnrealConnectionSettings>;
}

export class WorkbenchUnrealConnection extends Context.Service<
	WorkbenchUnrealConnection,
	WorkbenchUnrealConnectionApi
>()("@ue-shed/workbench/WorkbenchUnrealConnection") {}

function endpointPort(endpoint: string): number {
	const url = new URL(endpoint);
	if (url.port !== "") return Number(url.port);
	return url.protocol === "https:" ? 443 : 80;
}

function endpointWithPort(endpoint: string, port: number): string {
	const url = new URL(endpoint);
	url.port = String(port);
	return url.toString();
}

export function makeWorkbenchUnrealConnectionLayer(
	initialEndpoint: string
): Layer.Layer<WorkbenchUnrealConnection> {
	return Layer.effect(
		WorkbenchUnrealConnection,
		Effect.gen(function* () {
			const currentEndpoint = yield* Ref.make(initialEndpoint);
			const endpoint = Effect.fn("Workbench.UnrealConnection.endpoint")(() =>
				Ref.get(currentEndpoint)
			);
			const settings = Effect.fn("Workbench.UnrealConnection.settings")(function* () {
				const current = yield* Ref.get(currentEndpoint);
				return { port: endpointPort(current) };
			});
			const setPort = Effect.fn("Workbench.UnrealConnection.setPort")(function* (
				port: number
			) {
				yield* Ref.update(currentEndpoint, (current) => endpointWithPort(current, port));
				return yield* settings();
			});

			return WorkbenchUnrealConnection.of({ endpoint, settings, setPort });
		})
	);
}

export const WorkbenchUnrealConnectionLive = Layer.unwrap(
	Effect.map(WorkbenchConfiguration, (configuration) =>
		makeWorkbenchUnrealConnectionLayer(configuration.remoteControlEndpoint)
	)
);
