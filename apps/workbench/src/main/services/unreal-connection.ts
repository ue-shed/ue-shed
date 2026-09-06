import { Context, Effect, Layer } from "effect";
import { makeSelectedUnrealTarget, type SelectedUnrealTargetApi } from "@ue-shed/unreal-connection";
import type { UnrealConnectionSettings } from "../ipc-contracts.js";
import { WorkbenchConfiguration } from "../workbench-config.js";

export interface WorkbenchUnrealConnectionApi {
	readonly withCurrent: SelectedUnrealTargetApi["withCurrent"];
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
			const target = yield* makeSelectedUnrealTarget(initialEndpoint);
			const endpoint = target.endpoint;
			const settings = Effect.fn("Workbench.UnrealConnection.settings")(function* () {
				const current = yield* endpoint();
				return { endpoint: current, port: endpointPort(current) };
			});
			const setPort = Effect.fn("Workbench.UnrealConnection.setPort")(function* (
				port: number
			) {
				const next = endpointWithPort(yield* endpoint(), port);
				yield* target.select(next);
				return { endpoint: next, port: endpointPort(next) };
			});

			return WorkbenchUnrealConnection.of({
				endpoint,
				settings,
				setPort,
				withCurrent: target.withCurrent
			});
		})
	);
}

export const WorkbenchUnrealConnectionLive = Layer.unwrap(
	Effect.map(WorkbenchConfiguration, (configuration) =>
		makeWorkbenchUnrealConnectionLayer(configuration.remoteControlEndpoint)
	)
);
