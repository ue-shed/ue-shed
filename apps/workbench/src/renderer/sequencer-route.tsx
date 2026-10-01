import {
	SEQUENCE_ASSET_SEARCH_LIMIT,
	type SequenceAssetSearchRequest,
	type SequenceAssetSearchResult
} from "@ue-shed/extension-sequencer/contract";
import type { SavedReviewAsset } from "@ue-shed/unreal-assets/saved-review";
import { Effect } from "effect";
import { SavedReviewPanel } from "./saved-review-panel.js";
import { savedReviewClient, type SavedReviewClient } from "./saved-review-client.js";
import { workbenchRendererClient, type WorkbenchRendererClient } from "./workbench-client.js";

export interface SequencerRouteProps {
	readonly initialAssetPath?: string | undefined;
	readonly onOpenReference?: (asset: SavedReviewAsset) => void;
}

export function createSequencerRoute(
	extension: Pick<
		typeof import("@ue-shed/extension-sequencer"),
		"SequenceViewer" | "ProjectSequenceSearch"
	>,
	clients: {
		readonly client: Pick<WorkbenchRendererClient, "readBlueprint">;
		readonly reviewClient: SavedReviewClient;
	} = { client: workbenchRendererClient, reviewClient: savedReviewClient }
) {
	// This is the same saved_review candidate index used for references, not a filesystem scan.
	const searchSequences = Effect.fn("Workbench.Sequencer.searchIndex")(
		(request: SequenceAssetSearchRequest) =>
			clients.reviewClient.inventory().pipe(
				Effect.map((inventory): SequenceAssetSearchResult => {
					if (inventory.status === "not_configured") return { status: "not_configured" };
					if (inventory.status === "failed") return inventory;
					const terms = request.query.toLocaleLowerCase().split(/\s+/).filter(Boolean);
					const assets = inventory.assets
						.filter((asset) => asset.kind === "level_sequence")
						.filter((asset) =>
							terms.every((term) =>
								`LevelSequence ${asset.packageName}`
									.toLocaleLowerCase()
									.includes(term)
							)
						)
						.toSorted((left, right) =>
							left.packageName.localeCompare(right.packageName)
						);
					return {
						status: "ready",
						projectName: inventory.projectName ?? "selected project",
						matchCount: assets.length,
						assets: assets.slice(0, SEQUENCE_ASSET_SEARCH_LIMIT).map((asset) => ({
							assetName: asset.packageName.split("/").at(-1) ?? asset.packageName,
							assetPath: asset.assetPath,
							packageName: asset.packageName,
							className: "LevelSequence",
							relativePath: asset.packageName
						}))
					};
				})
			)
	);
	return function SequencerRoute(props: SequencerRouteProps) {
		return (
			<extension.SequenceViewer
				initialRead={
					props.initialAssetPath
						? clients.reviewClient.readSequence(props.initialAssetPath)
						: undefined
				}
				transportFailureCopy={{
					title: "The local reader request failed",
					message: "Workbench could not complete the local sequence request.",
					recovery:
						"Verify the configured uasset executable, then retry. Unreal is not required."
				}}
				opener={(controls) => (
					<extension.ProjectSequenceSearch
						controls={controls}
						searchSequences={searchSequences}
						readSequence={clients.reviewClient.readSequence}
						noProjectHint="Choose a project in the sidebar to search its Level Sequences."
					/>
				)}
				footer={(read, controls) => (
					<SavedReviewPanel
						review={{ kind: "level_sequence", read }}
						client={clients.reviewClient}
						blueprintClient={clients.client}
						onOpen={(asset) => {
							if (asset.kind === "level_sequence")
								controls.open(clients.reviewClient.readSequence(asset.assetPath));
							else props.onOpenReference?.(asset);
						}}
						onInternal={controls.reveal}
					/>
				)}
			/>
		);
	};
}
