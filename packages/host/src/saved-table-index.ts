import { AssetReader, type AssetReaderError, type SavedTableCatalog } from "@ue-shed/unreal-assets";
import { Context, Effect, Layer } from "effect";
import { ShedHostConfiguration } from "./configuration.js";

/**
 * Supplies the host's saved DataTable index.
 *
 * This exists so a host that already indexes its project can answer from that index instead of
 * paying for a second project-wide enumeration. Workbench builds one inventory per project and
 * serves tables from it; a headless host has no such inventory and reads through the asset reader.
 */
export interface SavedTableIndexShape {
	readonly savedTables: () => Effect.Effect<SavedTableCatalog, AssetReaderError>;
}

export class SavedTableIndex extends Context.Service<SavedTableIndex, SavedTableIndexShape>()(
	"@ue-shed/host/SavedTableIndex"
) {}

/**
 * The default index: one header-depth reader scan per request, cached by the reader when the
 * configured project supplies a `catalogCachePath`.
 */
export const SavedTableIndexLive = Layer.effect(
	SavedTableIndex,
	Effect.gen(function* () {
		const configuration = yield* ShedHostConfiguration;
		const assetReader = yield* AssetReader;
		return SavedTableIndex.of({
			savedTables: Effect.fn("SavedTableIndex.savedTables")(function* () {
				const project = yield* configuration.project();
				if (project.status !== "configured") {
					return { diagnostics: [], projectRoot: "", scannedAssets: 0, tables: [] };
				}
				return yield* assetReader.discoverTables({
					...(project.catalogCachePath === undefined
						? {}
						: { cachePath: project.catalogCachePath }),
					projectRoot: project.projectRoot
				});
			})
		});
	})
);

export function makeSavedTableIndexTestLayer(
	service: SavedTableIndexShape
): Layer.Layer<SavedTableIndex> {
	return Layer.succeed(SavedTableIndex, SavedTableIndex.of(service));
}
