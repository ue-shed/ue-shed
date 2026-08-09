import type {
	EditorAssetLocateResult,
	EditorAssetLocateUnavailableReason
} from "@ue-shed/protocol";
import {
	locateUnrealAsset,
	RemoteControlClient,
	UnrealCapabilityError
} from "@ue-shed/unreal-connection";
import { Context, Effect, Layer } from "effect";
import { WorkbenchConfiguration } from "../workbench-config.js";

export interface WorkbenchAssetNavigationShape {
	readonly locate: (objectPath: string) => Effect.Effect<EditorAssetLocateResult>;
}

export class WorkbenchAssetNavigation extends Context.Service<
	WorkbenchAssetNavigation,
	WorkbenchAssetNavigationShape
>()("@ue-shed/workbench/WorkbenchAssetNavigation") {}

function unavailableAssetLocation(options: {
	readonly message: string;
	readonly objectPath: string;
	readonly reason: EditorAssetLocateUnavailableReason;
	readonly recovery: string;
	readonly retrySafe?: boolean;
}): EditorAssetLocateResult {
	return {
		contract: { name: "unreal-editor-asset-navigation", version: { major: 1, minor: 0 } },
		message: options.message,
		objectPath: options.objectPath,
		reason: options.reason,
		recovery: options.recovery,
		retrySafe: options.retrySafe ?? true,
		status: "unavailable"
	};
}

export const WorkbenchAssetNavigationLive = Layer.effect(
	WorkbenchAssetNavigation,
	Effect.gen(function* () {
		const configuration = yield* WorkbenchConfiguration;
		const remoteControl = yield* RemoteControlClient;
		const locate = Effect.fn("Workbench.WorkbenchAssetNavigation.locate")(function* (
			objectPath: string
		) {
			return yield* locateUnrealAsset({
				bringToFront: true,
				endpoint: configuration.remoteControlEndpoint,
				objectPath
			}).pipe(
				Effect.provideService(RemoteControlClient, remoteControl),
				Effect.catch((error) =>
					Effect.succeed(
						unavailableAssetLocation({
							message: error.message,
							objectPath,
							reason:
								error instanceof UnrealCapabilityError
									? "capability_missing"
									: "not_connected",
							recovery:
								error instanceof UnrealCapabilityError
									? "Launch this project with UE Shed plugins enabled, then retry."
									: "Start or attach the selected Unreal project, then retry."
						})
					)
				)
			);
		});
		return WorkbenchAssetNavigation.of({ locate });
	})
);

export function makeWorkbenchAssetNavigationTestLayer(
	service?: Partial<WorkbenchAssetNavigationShape>
): Layer.Layer<WorkbenchAssetNavigation> {
	return Layer.succeed(
		WorkbenchAssetNavigation,
		WorkbenchAssetNavigation.of({
			locate: (objectPath) =>
				Effect.succeed(
					unavailableAssetLocation({
						message: "Asset navigation is not configured in this test layer.",
						objectPath,
						reason: "editor_unavailable",
						recovery: "Provide a locate test implementation."
					})
				),
			...service
		})
	);
}
