import { relative, resolve } from "node:path";
import { Effect } from "effect";
import type { SavedAssetTextExtractionEvent } from "../packages/unreal-assets/dist/index.js";
import {
	textCorpusFromExtractionEvents,
	textCorpusWithExcludedPackages
} from "../packages/game-text/dist/index.js";
import {
	packageTextSelection,
	textCorpusFromPackageTextLayer,
	type PackageTextInventoryEntry
} from "../packages/game-text/src/package-text-layer.ts";
import { compareTextCandidateCorpora } from "./package-text-oracle.test-support.ts";

/** Phase 5 can reuse this without changing the event-stream or eligibility oracles. */
export const comparePackageTextLayerWithEvents = Effect.fn("PackageText.layerOracle")(
	function* (input: {
		projectRoot: string;
		inventory: readonly PackageTextInventoryEntry[];
		events: readonly SavedAssetTextExtractionEvent[];
	}) {
		const selection = packageTextSelection(input.inventory).flatMap((shard) => shard.entries);
		const selected = new Set(
			selection
				.filter((entry) => entry.selected)
				.map((entry) => resolve(input.projectRoot, entry.entry.path))
		);
		const excluded = selection
			.filter((entry) => !entry.selected)
			.map((entry) =>
				relative(input.projectRoot, resolve(input.projectRoot, entry.entry.path))
			);
		const events = input.events
			.filter((event) => event.event !== "text_summary")
			.map((event) => ({ ...event, path: resolve(input.projectRoot, event.path) }));
		const full = textCorpusFromExtractionEvents({
			projectRoot: input.projectRoot,
			discoveredPackages: input.inventory.length,
			events
		});
		const mapped = textCorpusWithExcludedPackages(
			textCorpusFromExtractionEvents({
				projectRoot: input.projectRoot,
				discoveredPackages: input.inventory.length,
				events: events.filter((event) => selected.has(event.path))
			}),
			excluded
		);
		const actual = yield* textCorpusFromPackageTextLayer(input.projectRoot);
		return compareTextCandidateCorpora(full, mapped, actual, excluded);
	}
);
