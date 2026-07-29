import {
	ENHANCED_INPUT_CLASS_NAME_SUFFIXES,
	ENHANCED_INPUT_CLASS_PREFIX,
	EnhancedInputRunResult,
	scanEnhancedInputFromProjectIndex,
	type EnhancedInputRunResult as EnhancedInputRunResultValue
} from "@ue-shed/enhanced-input";
import { TEXTURE_CLASS } from "@ue-shed/asset-audits";
import { STRING_TABLE_CLASS, TEXT_PROPERTY_NAME } from "@ue-shed/game-text";
import { SavedWorldMap, type SavedWorldMap as SavedWorldMapValue } from "@ue-shed/protocol";
import {
	AssetReader,
	SAVED_TABLE_SCAN_CLASSES,
	SavedTableCatalog,
	savedTableCatalogFromScan,
	type SavedAssetScan,
	type SavedAssetManifestEntry,
	type SavedTableCatalog as SavedTableCatalogValue
} from "@ue-shed/unreal-assets";
import { Cache, Context, Duration, Effect, Exit, Layer, Option, Ref, Schema } from "effect";
import { createHash } from "node:crypto";
import { join, relative } from "node:path";
import { ElectronApp } from "../adapters/electron-app.js";
import { ProjectInventoryCache } from "../adapters/project-inventory-cache.js";
import {
	WorkbenchProjectSummary,
	type WorkbenchProjectFailure,
	type WorkbenchProjectState
} from "../project-workspace-contract.js";
import { ElectronDialog } from "../adapters/electron-dialog.js";
import { savedMapLabel, WorkbenchConfiguration } from "../workbench-config.js";

interface ProjectInventory {
	/** The current header projection, retained so dependent tools can decode candidates only. */
	readonly index: SavedAssetScan;
	readonly inputAtlas: EnhancedInputRunResultValue;
	readonly manifestHash: string;
	readonly manifest: readonly SavedAssetManifestEntry[];
	readonly maps: readonly SavedWorldMapValue[];
	readonly project: WorkbenchProjectSummary;
	/**
	 * Saved DataTables projected from the global header index. No separate table scan is permitted.
	 */
	readonly tables: SavedTableCatalogValue;
}

const PersistentProjectInventory = Schema.Struct({
	inputAtlas: EnhancedInputRunResult,
	manifest: Schema.Array(
		Schema.Struct({
			kind: Schema.Literals(["package", "sidecar"]),
			modifiedMs: Schema.Number,
			path: Schema.String,
			size: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))
		})
	),
	manifestHash: Schema.String,
	maps: Schema.Array(SavedWorldMap),
	project: WorkbenchProjectSummary,
	tables: SavedTableCatalog,
	version: Schema.Literal(3)
});
interface PersistentProjectInventory extends Schema.Schema.Type<
	typeof PersistentProjectInventory
> {}

export class WorkbenchProjectUnavailable extends Schema.TaggedErrorClass<WorkbenchProjectUnavailable>()(
	"WorkbenchProjectUnavailable",
	{
		message: Schema.String,
		recovery: Schema.String
	}
) {}

export interface WorkbenchProjectShape {
	readonly choose: () => Effect.Effect<WorkbenchProjectState>;
	readonly current: () => Effect.Effect<WorkbenchProjectState>;
	readonly inputAtlas: () => Effect.Effect<EnhancedInputRunResultValue>;
	/** The current global header index. Consumers must not re-enumerate the project. */
	readonly index: () => Effect.Effect<SavedAssetScan, WorkbenchProjectUnavailable>;
	readonly savedProject: () => Effect.Effect<
		{ readonly maps: readonly SavedWorldMapValue[]; readonly projectRoot: string },
		WorkbenchProjectUnavailable
	>;
	/**
	 * Saved DataTables from the project index. Answering from the inventory keeps the authoring
	 * route off a second project-wide enumeration.
	 */
	readonly savedTables: () => Effect.Effect<SavedTableCatalogValue, WorkbenchProjectUnavailable>;
}

export class WorkbenchProject extends Context.Service<WorkbenchProject, WorkbenchProjectShape>()(
	"@ue-shed/workbench/WorkbenchProject"
) {}

function projectName(projectRoot: string): string {
	const trimmed = projectRoot.replace(/[/\\]+$/, "");
	return trimmed.split(/[/\\]/).at(-1) || projectRoot;
}

function projectManifestHash(
	projectRoot: string,
	manifest: readonly SavedAssetManifestEntry[]
): string {
	const hash = createHash("sha256").update(projectRoot).update("\u0000");
	for (const entry of manifest) {
		hash.update(entry.path)
			.update("\u0000")
			.update(String(entry.size))
			.update("\u0000")
			.update(String(entry.modifiedMs))
			.update("\u0000");
	}
	return hash.digest("hex");
}

function mapsFromManifest(
	projectRoot: string,
	manifest: readonly SavedAssetManifestEntry[]
): readonly SavedWorldMapValue[] {
	return manifest
		.filter((entry) => entry.kind === "package" && entry.path.toLowerCase().endsWith(".umap"))
		.map((entry) => relative(projectRoot, entry.path).replaceAll("\\", "/"))
		.sort((left, right) => left.localeCompare(right))
		.map((mapPath) => ({ label: savedMapLabel(mapPath), mapPath }));
}

function headerProjection(index: SavedAssetScan): SavedAssetScan {
	return { assets: index.assets, failures: index.failures, summary: index.summary };
}

function fromPersistentInventory(
	entry: PersistentProjectInventory,
	index: SavedAssetScan
): ProjectInventory {
	return {
		index: headerProjection(index),
		inputAtlas: entry.inputAtlas,
		manifest: entry.manifest,
		manifestHash: entry.manifestHash,
		maps: entry.maps,
		project: entry.project,
		tables: entry.tables
	};
}

function toPersistentInventory(inventory: ProjectInventory): PersistentProjectInventory {
	return {
		inputAtlas: inventory.inputAtlas,
		manifest: [...inventory.manifest],
		manifestHash: inventory.manifestHash,
		maps: [...inventory.maps],
		project: inventory.project,
		tables: inventory.tables,
		version: 3
	};
}

function mapProjectFailure(message: string): WorkbenchProjectFailure {
	return {
		message,
		recovery: "Choose a valid Unreal project directory, then let its package inventory finish."
	};
}

function unavailableFromState(state: WorkbenchProjectState): WorkbenchProjectUnavailable {
	if (state.status === "failed") {
		return new WorkbenchProjectUnavailable({
			message: state.error.message,
			recovery: state.error.recovery
		});
	}
	return new WorkbenchProjectUnavailable({
		message: "No Workbench project is selected.",
		recovery: "Choose a project from the Workbench header, then retry."
	});
}

/**
 * Locates the reader's project-index header cache, one file per project root.
 *
 * The derived inventory is separately persisted. This cache reuses unchanged package headers while
 * one native scan refreshes the complete project signature inventory.
 */
const projectIndexCacheLocator = Effect.gen(function* () {
	const app = yield* Effect.serviceOption(ElectronApp);
	if (Option.isNone(app)) return undefined;
	const userData = yield* app.value
		.getPath("userData")
		.pipe(Effect.catch(() => Effect.succeed(undefined)));
	if (userData === undefined) return undefined;
	const directory = join(userData, "project-indexes-v1");
	return (projectRoot: string) =>
		join(directory, `${createHash("sha256").update(projectRoot).digest("hex")}.json`);
});

export const WorkbenchProjectLive = Layer.effect(
	WorkbenchProject,
	Effect.gen(function* () {
		const configuration = yield* WorkbenchConfiguration;
		const dialog = yield* ElectronDialog;
		const assetReader = yield* AssetReader;
		const projectInventoryCache = yield* Effect.serviceOption(ProjectInventoryCache);
		const projectIndexCachePath = yield* projectIndexCacheLocator;
		const selectedRoot = yield* Ref.make<Option.Option<string>>(
			configuration.project.status === "configured"
				? Option.some(configuration.project.projectRoot)
				: Option.none()
		);
		const selectedInventory = yield* Ref.make<Option.Option<ProjectInventory>>(Option.none());

		const readPersistentInventory = Effect.fn(
			"Workbench.WorkbenchProject.readPersistentInventory"
		)(function* (projectRoot: string) {
			if (Option.isNone(projectInventoryCache)) return undefined;
			const cached = yield* projectInventoryCache.value
				.read(projectRoot)
				.pipe(
					Effect.catch((error) =>
						Effect.logWarning(
							`Could not read the project inventory cache for ${projectRoot}: ${error.message}`
						).pipe(Effect.as(undefined))
					)
				);
			if (cached === undefined) return undefined;
			return yield* Schema.decodeUnknownEffect(PersistentProjectInventory)(cached).pipe(
				Effect.catch(() => Effect.succeed(undefined))
			);
		});

		const writePersistentInventory = Effect.fn(
			"Workbench.WorkbenchProject.writePersistentInventory"
		)(function* (inventory: ProjectInventory) {
			if (Option.isNone(projectInventoryCache)) return;
			yield* projectInventoryCache.value
				.write(inventory.project.projectRoot, toPersistentInventory(inventory))
				.pipe(
					Effect.catch((error) =>
						Effect.logWarning(
							`Could not write the project inventory cache for ${inventory.project.projectRoot}: ${error.message}`
						)
					)
				);
		});

		const buildInventory = Effect.fn("Workbench.WorkbenchProject.buildInventory")(function* (
			projectRoot: string,
			index: SavedAssetScan,
			manifest: readonly SavedAssetManifestEntry[],
			manifestHash: string
		) {
			const inputAtlas = yield* scanEnhancedInputFromProjectIndex(index, {
				projectRoot
			}).pipe(
				Effect.map((report) => ({ projectRoot, report, status: "completed" as const })),
				Effect.catch((error) =>
					Effect.succeed({
						error: {
							code: error.code,
							message: error.message,
							recovery: error.recovery,
							retrySafe: error.retrySafe
						},
						status: "failed" as const
					})
				)
			);
			const tables = savedTableCatalogFromScan(index);
			const maps = mapsFromManifest(projectRoot, manifest);
			return {
				index: headerProjection(index),
				inputAtlas,
				manifest,
				manifestHash,
				maps,
				project: {
					inputAtlas: inputAtlas.status === "completed" ? "ready" : "failed",
					mapCount: maps.length,
					packageCount: manifest.filter((entry) => entry.kind === "package").length,
					projectName: projectName(projectRoot),
					projectRoot
				},
				tables
			} satisfies ProjectInventory;
		});

		const loadRootUncached = Effect.fn("Workbench.WorkbenchProject.loadRootUncached")(
			function* (projectRoot: string) {
				const index = yield* assetReader.scanProject({
					classes: [...SAVED_TABLE_SCAN_CLASSES, STRING_TABLE_CLASS, TEXTURE_CLASS],
					classNameSuffixes: ENHANCED_INPUT_CLASS_NAME_SUFFIXES,
					classPrefixes: [ENHANCED_INPUT_CLASS_PREFIX],
					...(projectIndexCachePath === undefined
						? {}
						: { cachePath: projectIndexCachePath(projectRoot) }),
					depth: "header",
					inventory: true,
					names: [TEXT_PROPERTY_NAME],
					projectRoot
				});
				if (
					index.inventory === undefined ||
					index.summary.inventoryComplete !== true ||
					index.inventory.length !== index.summary.inventoryFiles
				) {
					return yield* new WorkbenchProjectUnavailable({
						message: "Project index did not produce a complete signature inventory.",
						recovery:
							"Retry after checking that every saved package and sidecar is readable."
					});
				}
				const manifest = [...index.inventory].sort((left, right) =>
					left.path.localeCompare(right.path)
				);
				const manifestHash = projectManifestHash(projectRoot, manifest);
				const active = yield* Ref.get(selectedInventory);
				if (
					Option.isSome(active) &&
					active.value.manifestHash === manifestHash &&
					active.value.project.projectRoot === projectRoot
				) {
					return active.value;
				}
				const persisted = yield* readPersistentInventory(projectRoot);
				if (
					persisted?.manifestHash === manifestHash &&
					persisted.project.projectRoot === projectRoot
				) {
					const inventory = fromPersistentInventory(persisted, index);
					yield* Ref.set(selectedInventory, Option.some(inventory));
					return inventory;
				}
				const inventory = yield* buildInventory(projectRoot, index, manifest, manifestHash);
				yield* Ref.set(selectedInventory, Option.some(inventory));
				yield* writePersistentInventory(inventory);
				return inventory;
			}
		);

		// A built inventory is reused for a short window. Routine callers resolve the selected
		// project far more often than a project changes on disk -- every catalog table open does
		// it once -- and revalidating means re-walking and re-stat'ing the whole `Content` tree,
		// which costs seconds on a real project. Failures are never cached, so a retry always
		// rescans, and `choose` invalidates explicitly so re-selecting a project re-indexes it.
		const inventoryLoads = yield* Cache.makeWith(loadRootUncached, {
			capacity: 4,
			timeToLive: (exit) => (Exit.isSuccess(exit) ? Duration.seconds(30) : Duration.zero)
		});

		const loadRoot = Effect.fn("Workbench.WorkbenchProject.loadRoot")(function* (
			projectRoot: string
		) {
			return yield* Cache.get(inventoryLoads, projectRoot);
		});

		const current = Effect.fn("Workbench.WorkbenchProject.current")(function* () {
			const root = yield* Ref.get(selectedRoot);
			if (Option.isNone(root)) return { status: "not_configured" as const };
			return yield* loadRoot(root.value).pipe(
				Effect.map((inventory) => ({
					project: inventory.project,
					status: "ready" as const
				})),
				Effect.catch((error) =>
					Ref.set(selectedInventory, Option.none()).pipe(
						Effect.as({
							error: mapProjectFailure(error.message),
							status: "failed" as const
						})
					)
				)
			);
		});

		const choose: WorkbenchProjectShape["choose"] = () =>
			Effect.gen(function* () {
				const choice = yield* dialog.chooseDirectory({
					title: "Choose an Unreal project for Workbench"
				});
				if (choice.status === "cancelled") return { status: "cancelled" as const };
				// Choosing a project is an explicit operator request to index it, so it always
				// revalidates against disk rather than answering from the reuse window.
				yield* Cache.invalidate(inventoryLoads, choice.path);
				const inventory = yield* loadRoot(choice.path);
				yield* Ref.set(selectedRoot, Option.some(choice.path));
				return { project: inventory.project, status: "ready" as const };
			}).pipe(
				Effect.catch((error) =>
					Effect.succeed({
						error: mapProjectFailure(error.message),
						status: "failed" as const
					})
				)
			);

		const selected = Effect.fn("Workbench.WorkbenchProject.selected")(function* () {
			const cached = yield* Ref.get(selectedInventory);
			if (Option.isSome(cached)) return cached.value;
			const state = yield* current();
			if (state.status !== "ready") return yield* Effect.fail(unavailableFromState(state));
			const inventory = yield* Ref.get(selectedInventory);
			if (Option.isNone(inventory)) return yield* Effect.fail(unavailableFromState(state));
			return inventory.value;
		});

		const inputAtlas = Effect.fn("Workbench.WorkbenchProject.inputAtlas")(function* () {
			return yield* selected().pipe(
				Effect.map((inventory) => inventory.inputAtlas),
				Effect.catch((error) =>
					Effect.succeed({
						error: {
							code: "invalid_project" as const,
							message: error.message,
							recovery: error.recovery,
							retrySafe: true
						},
						status: "failed" as const
					})
				)
			);
		});

		const projectIndex = Effect.fn("Workbench.WorkbenchProject.index")(function* () {
			return (yield* selected()).index;
		});

		const savedProject = Effect.fn("Workbench.WorkbenchProject.savedProject")(function* () {
			const inventory = yield* selected();
			return { maps: inventory.maps, projectRoot: inventory.project.projectRoot };
		});

		const savedTables = Effect.fn("Workbench.WorkbenchProject.savedTables")(function* () {
			return (yield* selected()).tables;
		});

		return WorkbenchProject.of({
			choose,
			current,
			inputAtlas,
			index: projectIndex,
			savedProject,
			savedTables
		});
	})
);

export type WorkbenchProjectTestShape = Omit<WorkbenchProjectShape, "index"> &
	Partial<Pick<WorkbenchProjectShape, "index">>;

export function makeWorkbenchProjectTestLayer(
	service: WorkbenchProjectTestShape
): Layer.Layer<WorkbenchProject> {
	return Layer.succeed(
		WorkbenchProject,
		WorkbenchProject.of({
			...service,
			index: service.index ?? (() => Effect.die("project index is not used by this test"))
		})
	);
}
