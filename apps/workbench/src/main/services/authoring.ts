import { WorkbenchUnrealConnection } from "./unreal-connection.js";
import {
	AuthoringFilePicker,
	AuthoringFilePickerError,
	AuthoringClientLive,
	ShedAuthoring,
	ShedAuthoringLive,
	SavedTableIndex,
	ShedHostConfiguration,
	makeShedAuthoringTestLayer,
	type ShedAuthoringApi
} from "@ue-shed/host";
import { AuthoringClient } from "@ue-shed/authoring-sdk";
import { AssetReader } from "@ue-shed/unreal-assets";
import { Effect, Layer, Option } from "effect";
import { ElectronDialog } from "../adapters/electron-dialog.js";
import { WorkbenchConfiguration } from "../workbench-config.js";
import { WorkbenchProject } from "./project-workspace.js";

export { sessionView } from "@ue-shed/host";
export { ShedAuthoring as WorkbenchAuthoring } from "@ue-shed/host";
export type WorkbenchAuthoringApi = ShedAuthoringApi;

const WorkbenchShedHostConfigurationLive = Layer.effect(
	ShedHostConfiguration,
	Effect.gen(function* () {
		const configuration = yield* WorkbenchConfiguration;
		const connection = yield* WorkbenchUnrealConnection;
		const workspace = yield* Effect.serviceOption(WorkbenchProject);
		// The table catalog is served by `WorkbenchSavedTableIndexLive` from the workspace
		// inventory, which owns the reader cache, so no catalog cache path is threaded here.
		const project = () =>
			Option.match(workspace, {
				onNone: () => Effect.succeed(configuration.project),
				onSome: (service) =>
					service.selectedProject().pipe(
						Effect.map((selected) => {
							if (
								configuration.project.status === "configured" &&
								configuration.project.projectRoot === selected.projectRoot
							)
								return configuration.project;
							return {
								projectRoot: selected.projectRoot,
								status: "configured" as const
							};
						}),
						Effect.catch(() => Effect.succeed({ status: "not_configured" as const }))
					)
			});
		return ShedHostConfiguration.of({
			authoringAsset: () =>
				Option.isNone(workspace)
					? Effect.succeed(configuration.authoringAsset)
					: project().pipe(
							Effect.map((selected) =>
								selected.status === "configured" &&
								configuration.project.status === "configured" &&
								selected.projectRoot === configuration.project.projectRoot
									? configuration.authoringAsset
									: { status: "not_configured" as const }
							)
						),
			project,
			remoteControlEndpoint: connection.endpoint
		});
	})
);

const WorkbenchAuthoringFilePickerLive = Layer.effect(
	AuthoringFilePicker,
	Effect.map(ElectronDialog, (dialog) =>
		AuthoringFilePicker.of({
			chooseFile: Effect.fn("Workbench.AuthoringFilePicker.chooseFile")((options) =>
				dialog
					.chooseFile({
						filters: [{ extensions: options.extensions, name: "Unreal saved assets" }],
						title: options.title
					})
					.pipe(
						Effect.mapError(
							(cause) =>
								new AuthoringFilePickerError({
									cause,
									message: cause.message,
									recovery: cause.recovery
								})
						)
					)
			)
		})
	)
);

/**
 * Serves the authoring catalog from the workspace inventory that `WorkbenchProject` already built.
 * Without this the route would run its own project-wide enumeration on top of the inventory, so a
 * large project paid to walk every package twice.
 */
const WorkbenchSavedTableIndexLive = Layer.effect(
	SavedTableIndex,
	Effect.gen(function* () {
		const workspace = yield* Effect.serviceOption(WorkbenchProject);
		const configuration = yield* WorkbenchConfiguration;
		const assetReader = yield* AssetReader;
		// A host without the workspace service -- the headless and test compositions -- has no
		// inventory to read, so it falls back to indexing through the reader on demand.
		if (Option.isNone(workspace)) {
			return SavedTableIndex.of({
				savedTables: Effect.fn("Workbench.SavedTableIndex.savedTables")(function* () {
					if (configuration.project.status !== "configured") {
						return { diagnostics: [], projectRoot: "", scannedAssets: 0, tables: [] };
					}
					return yield* assetReader.discoverTables({
						projectRoot: configuration.project.projectRoot
					});
				})
			});
		}
		return SavedTableIndex.of({
			savedTables: Effect.fn("Workbench.SavedTableIndex.savedTables")(() =>
				workspace.value.savedTables().pipe(
					Effect.catch((error) =>
						Effect.succeed({
							diagnostics: [
								{
									code: "project_unavailable",
									message: `${error.message} ${error.recovery}`,
									path: "",
									retrySafe: true
								}
							],
							projectRoot: "",
							scannedAssets: 0,
							tables: []
						})
					)
				)
			)
		});
	})
);

export const WorkbenchAuthoringLive = ShedAuthoringLive.pipe(
	Layer.provide(WorkbenchShedHostConfigurationLive),
	Layer.provide(WorkbenchSavedTableIndexLive),
	Layer.provide(WorkbenchAuthoringFilePickerLive)
);

export function makeWorkbenchAuthoringTestLayer(
	service: WorkbenchAuthoringApi
): Layer.Layer<ShedAuthoring | AuthoringClient> {
	const shedAuthoring = makeShedAuthoringTestLayer(service);
	return Layer.merge(shedAuthoring, AuthoringClientLive.pipe(Layer.provide(shedAuthoring)));
}
