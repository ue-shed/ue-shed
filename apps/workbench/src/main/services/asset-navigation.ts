import { WorkbenchUnrealConnection } from "./unreal-connection.js";
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

export interface WorkbenchAssetNavigationApi {
	readonly locate: (objectPath: string) => Effect.Effect<EditorAssetLocateResult>;
}

export class WorkbenchAssetNavigation extends Context.Service<
	WorkbenchAssetNavigation,
	WorkbenchAssetNavigationApi
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
		const connection = yield* WorkbenchUnrealConnection;
		const remoteControl = yield* RemoteControlClient;
		const locate = Effect.fn("Workbench.WorkbenchAssetNavigation.locate")(function* (
			objectPath: string
		) {
			const endpoint = yield* connection.endpoint();

			return yield* locateUnrealAsset({
				bringToFront: true,
				endpoint: endpoint,
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
	service?: Partial<WorkbenchAssetNavigationApi>
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
