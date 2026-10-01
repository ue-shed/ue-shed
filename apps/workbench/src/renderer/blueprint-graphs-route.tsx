import type { SavedReviewAsset } from "@ue-shed/unreal-assets/saved-review";
import { SavedReviewPanel } from "./saved-review-panel.js";
import { savedReviewClient, type SavedReviewClient } from "./saved-review-client.js";
import { workbenchRendererClient, type WorkbenchRendererClient } from "./workbench-client.js";

export interface BlueprintGraphsRouteProps {
	readonly initialAssetPath?: string | undefined;
	readonly onOpenReference?: (asset: SavedReviewAsset) => void;
}

export function createBlueprintGraphsRoute(
	extension: Pick<
		typeof import("@ue-shed/extension-blueprint-graphs"),
		"BlueprintGraphViewer" | "ProjectBlueprintSearch"
	>,
	clients: {
		readonly client: Pick<WorkbenchRendererClient, "readBlueprint" | "searchBlueprints">;
		readonly reviewClient: SavedReviewClient;
	} = { client: workbenchRendererClient, reviewClient: savedReviewClient }
) {
	return function BlueprintGraphsRoute(props: BlueprintGraphsRouteProps) {
		return (
			<extension.BlueprintGraphViewer
				initialRead={
					props.initialAssetPath
						? clients.client.readBlueprint(props.initialAssetPath)
						: undefined
				}
				transportFailureCopy={{
					message: "Workbench could not complete the local reader request.",
					recovery:
						"Verify the configured uasset executable, then retry. Unreal is not required.",
					title: "The local reader request failed"
				}}
				opener={(controls) => (
					<extension.ProjectBlueprintSearch
						controls={controls}
						searchBlueprints={clients.client.searchBlueprints}
						readBlueprint={clients.client.readBlueprint}
						noProjectHint="Choose a project in the sidebar to search its Blueprints."
					/>
				)}
				footer={(read, controls) => (
					<SavedReviewPanel
						review={{ kind: "blueprint", read }}
						client={clients.reviewClient}
						blueprintClient={clients.client}
						onOpen={(asset) => {
							if (asset.kind === "blueprint")
								controls.open(clients.client.readBlueprint(asset.assetPath));
							else props.onOpenReference?.(asset);
						}}
						onInternal={controls.reveal}
					/>
				)}
			/>
		);
	};
}
