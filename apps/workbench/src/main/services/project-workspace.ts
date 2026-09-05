import {
	ENHANCED_INPUT_CLASS_NAME_SUFFIXES,
	ENHANCED_INPUT_CLASS_PREFIX,
	scanEnhancedInputFromProjectIndex,
	type EnhancedInputRunResult as EnhancedInputRunResultValue
} from "@ue-shed/enhanced-input";
import { TEXTURE_CLASS } from "@ue-shed/asset-audits";
import { STRING_TABLE_CLASS, TEXT_PROPERTY_NAME } from "@ue-shed/game-text";
import { NIAGARA_SYSTEM_CLASS } from "@ue-shed/niagara";
import type { SavedWorldMap as SavedWorldMapValue } from "@ue-shed/protocol";
import {
	AssetReader,
	BLUEPRINT_ASSET_CLASS_NAME_SUFFIXES,
	PROJECT_INDEX_MAX_PAGE_SIZE,
	ProjectIndex,
	ProjectIndexQuery,
	ProjectIndexSummary,
	SAVED_TABLE_SCAN_CLASSES,
	getProjectIndexStatus,
	queryProjectIndex,
	countProjectIndex,
	type ProjectIndexFilter,
	refreshProjectIndex,
	savedTableCatalogFromScan,
	type ProjectIndexCursor,
	type ProjectIndexError,
	type ProjectIndexItem,
	type ProjectIndexMap,
	type SavedAssetScan,
	type SavedTableCatalog as SavedTableCatalogValue
} from "@ue-shed/unreal-assets";
import { Cache, Context, Duration, Effect, Exit, Layer, Option, Ref, Schema, Stream } from "effect";
import { join } from "node:path";
import {
	WorkbenchProjectSummary,
	type WorkbenchRecentProject,
	type WorkbenchProjectFailure,
	type WorkbenchProjectState,
	type WorkbenchTaskProgress
} from "../project-workspace-contract.js";
import { ElectronDialog } from "../adapters/electron-dialog.js";
import { savedMapLabel, WorkbenchConfiguration } from "../workbench-config.js";
import { WorkbenchProjectHistory } from "./project-history.js";

interface ProjectSummaryInventory {
	readonly indexSummary: ProjectIndexSummary | undefined;
	readonly maps: readonly SavedWorldMapValue[];
	readonly project: WorkbenchProjectSummary;
}

export type WorkbenchProjectCandidateKind =
	| "blueprint"
	| "enhanced_input"
	| "game_text"
	| "niagara_system"
	| "saved_tables"
	| "texture";

function candidateFilters(kind: WorkbenchProjectCandidateKind): readonly ProjectIndexFilter[] {
	const byKind = {
		blueprint: [
			{ _tag: "ClassNameSuffixes", values: [...BLUEPRINT_ASSET_CLASS_NAME_SUFFIXES] }
		],
		enhanced_input: [
			{ _tag: "ClassPrefixes", values: [ENHANCED_INPUT_CLASS_PREFIX] },
			{ _tag: "ClassNameSuffixes", values: [...ENHANCED_INPUT_CLASS_NAME_SUFFIXES] }
		],
		game_text: [
			{ _tag: "ExactClasses", values: [STRING_TABLE_CLASS] },
			{ _tag: "SerializedNames", values: [TEXT_PROPERTY_NAME] }
		],
		niagara_system: [{ _tag: "ExactClasses", values: [NIAGARA_SYSTEM_CLASS] }],
		saved_tables: [{ _tag: "ExactClasses", values: [...SAVED_TABLE_SCAN_CLASSES] }],
		texture: [{ _tag: "ExactClasses", values: [TEXTURE_CLASS] }]
	} satisfies Record<WorkbenchProjectCandidateKind, readonly ProjectIndexFilter[]>;
	return byKind[kind];
}

export class WorkbenchProjectUnavailable extends Schema.TaggedErrorClass<WorkbenchProjectUnavailable>()(
	"WorkbenchProjectUnavailable",
	{
		message: Schema.String,
		recovery: Schema.String
	}
) {}

export interface WorkbenchProjectApi {
	readonly candidateCount: (
		kind: WorkbenchProjectCandidateKind
	) => Effect.Effect<number, WorkbenchProjectUnavailable>;
	/** Fold only one domain's bounded Project Index pages into explicit package candidates. */
	readonly candidates: (
		kind: WorkbenchProjectCandidateKind
	) => Effect.Effect<SavedAssetScan, WorkbenchProjectUnavailable>;
	readonly choose: () => Effect.Effect<WorkbenchProjectState>;
	readonly current: () => Effect.Effect<WorkbenchProjectState>;
	readonly inputAtlas: () => Effect.Effect<EnhancedInputRunResultValue>;
	readonly openRecent: (projectRoot: string) => Effect.Effect<WorkbenchProjectState>;
	readonly progress: () => Effect.Effect<WorkbenchTaskProgress>;
	readonly recent: () => Effect.Effect<readonly WorkbenchRecentProject[]>;
	/** Selected identity only; config queries must not require a package-index refresh. */
	readonly selectedProject: () => Effect.Effect<
		{ readonly projectName: string; readonly projectRoot: string },
		WorkbenchProjectUnavailable
	>;
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

export class WorkbenchProject extends Context.Service<WorkbenchProject, WorkbenchProjectApi>()(
	"@ue-shed/workbench/WorkbenchProject"
) {}

function projectName(projectRoot: string): string {
	const trimmed = projectRoot.replace(/[/\\]+$/, "");
	return trimmed.split(/[/\\]/).at(-1) || projectRoot;
}

function mapProjectFailure(
	message: string,
	recovery = "Choose a valid Unreal project directory, then let its package inventory finish."
): WorkbenchProjectFailure {
	return {
		message,
		recovery
	};
}

export const WorkbenchProjectLive = Layer.effect(
	WorkbenchProject,
	Effect.gen(function* () {
		const configuration = yield* WorkbenchConfiguration;
		const dialog = yield* ElectronDialog;
		const history = yield* WorkbenchProjectHistory;
		const assetReader = yield* AssetReader;
		const projectIndexImplementation = yield* ProjectIndex;
		const layerScope = yield* Effect.scope;
		const rememberedProjects =
			configuration.rememberProjects === false ? [] : yield* history.recent();
		const initialRoot =
			configuration.project.status === "configured"
				? configuration.project.projectRoot
				: rememberedProjects[0]?.projectRoot;
		const selectedRoot = yield* Ref.make<Option.Option<string>>(
			initialRoot === undefined ? Option.none() : Option.some(initialRoot)
		);
		const selectedSummary = yield* Ref.make<Option.Option<ProjectSummaryInventory>>(
			Option.none()
		);
		const projectIndexProgress = yield* Ref.make<WorkbenchTaskProgress>({
			completed: 0,
			phase: "idle",
			stage: "project_index",
			total: 0
		});

		const projectIndexItems = Effect.fn("Workbench.WorkbenchProject.projectIndexItems")(
			function* (
				summary: ProjectIndexSummary,
				makeRequest: (cursor: ProjectIndexCursor | undefined) => ProjectIndexQuery
			) {
				const items = yield* Stream.paginate<
					ProjectIndexCursor | undefined,
					ProjectIndexItem,
					WorkbenchProjectUnavailable | ProjectIndexError
				>(undefined, (cursor) =>
					queryProjectIndex(makeRequest(cursor)).pipe(
						Effect.provideService(ProjectIndex, projectIndexImplementation),
						Effect.flatMap((page) => {
							if (
								page.generation !== summary.generation ||
								page.projectId !== summary.projectId
							) {
								return Effect.fail(
									new WorkbenchProjectUnavailable({
										message:
											"Project Index returned a page from a different generation.",
										recovery:
											"Refresh the Project Index, then retry the project summary."
									})
								);
							}
							return Effect.succeed([
								page.items,
								page.nextCursor === undefined
									? Option.none<ProjectIndexCursor | undefined>()
									: Option.some<ProjectIndexCursor | undefined>(page.nextCursor)
							] as const);
						})
					)
				).pipe(
					Stream.runCollect,
					Effect.mapError((error) =>
						error instanceof WorkbenchProjectUnavailable ||
						error._tag === "ProjectIndexStaleGeneration"
							? error
							: new WorkbenchProjectUnavailable({
									message: error.message,
									recovery: error.recovery
								})
					)
				);
				return Array.from(items);
			}
		);

		const mapsFromProjectIndex = Effect.fn("Workbench.WorkbenchProject.mapsFromProjectIndex")(
			function* (summary: ProjectIndexSummary) {
				const maps = yield* projectIndexItems(summary, (cursor) =>
					ProjectIndexQuery.cases.Maps.make({
						expectedGeneration: summary.generation,
						limit: PROJECT_INDEX_MAX_PAGE_SIZE,
						projectId: summary.projectId,
						...(cursor === undefined ? undefined : { cursor })
					})
				);
				const paths = maps
					.filter((item): item is ProjectIndexMap => item.kind === "map")
					.map((map) => map.mapPath)
					.sort((left, right) => left.localeCompare(right));
				if (paths.length !== summary.mapCount) {
					return yield* new WorkbenchProjectUnavailable({
						message: "Project Index returned an incomplete map page set.",
						recovery: "Refresh the Project Index, then retry the project summary."
					});
				}
				return paths.map((mapPath) => ({ label: savedMapLabel(mapPath), mapPath }));
			}
		);

		const headerIndexFromProjectIndex = Effect.fn(
			"Workbench.WorkbenchProject.headerIndexFromProjectIndex"
		)(function* (
			projectRoot: string,
			summary: ProjectIndexSummary,
			kind: WorkbenchProjectCandidateKind
		) {
			const factories = candidateFilters(kind).map(
				(filter) =>
					(cursor: ProjectIndexCursor | undefined): ProjectIndexQuery => ({
						...filter,
						expectedGeneration: summary.generation,
						projectId: summary.projectId,
						limit: PROJECT_INDEX_MAX_PAGE_SIZE,
						...(cursor === undefined ? undefined : { cursor })
					})
			);
			const pages = yield* Effect.forEach(factories, (makeRequest) =>
				projectIndexItems(summary, makeRequest)
			);
			const headers = new Map<
				string,
				{
					readonly classes: Set<string>;
					readonly packageName: string;
					readonly serializedNames: Set<string>;
				}
			>();
			for (const page of pages) {
				for (const item of page) {
					if (item.kind !== "header") continue;
					const current = headers.get(item.packagePath) ?? {
						classes: new Set<string>(),
						packageName: item.packageName,
						serializedNames: new Set<string>()
					};
					for (const classPath of item.classes) current.classes.add(classPath);
					for (const name of item.serializedNames) current.serializedNames.add(name);
					headers.set(item.packagePath, current);
				}
			}
			const assets = [...headers.entries()]
				.sort(([left], [right]) => left.localeCompare(right))
				.map(([packagePath, header]) => ({
					depth: "header" as const,
					fileBytes: 0,
					header: {
						exports: [...header.classes].sort().map((classPath) => ({
							class_name: classPath.slice(classPath.lastIndexOf(".") + 1),
							class_path: classPath,
							object_path: header.packageName
						})),
						matched_names: [...header.serializedNames].sort(),
						package: { name: header.packageName },
						path: packagePath,
						schema_version: 8 as const
					}
				}));
			return {
				assets,
				failures: [],
				summary: {
					cacheHits: 0,
					depth: "header",
					diagnostics: [],
					emittedAssets: assets.length,
					failedAssets: 0,
					partialAssets: 0,
					projectRoot,
					roots: [join(projectRoot, "Content")],
					scannedAssets: summary.packageCount,
					schema_version: 8,
					skippedAssets: Math.max(0, summary.packageCount - assets.length)
				}
			} satisfies SavedAssetScan;
		});

		const refreshSummary = Effect.fn("Workbench.WorkbenchProject.refreshSummary")(function* (
			projectRoot: string
		) {
			const summary = yield* refreshProjectIndex({ projectRoot }).pipe(
				Stream.provideService(ProjectIndex, projectIndexImplementation),
				Stream.tap((event) =>
					Ref.update(projectIndexProgress, (previous): WorkbenchTaskProgress => {
						if (event._tag === "Started") {
							return {
								completed: 0,
								phase: "enumerating",
								stage: "project_index",
								total: 0
							};
						}
						if (event._tag === "Progress") {
							return {
								completed: event.completedPackages,
								phase: event.phase === "enumerating" ? "enumerating" : "scanning",
								stage: "project_index",
								total: event.totalPackages ?? previous.total
							};
						}
						return {
							completed: event.summary.packageCount,
							phase: "ready",
							stage: "project_index",
							total: event.summary.packageCount
						};
					})
				),
				Stream.runFold(
					() => Option.none<ProjectIndexSummary>(),
					(current, event) =>
						event._tag === "Completed" ? Option.some(event.summary) : current
				),
				Effect.onExit((exit) =>
					Ref.update(
						projectIndexProgress,
						(previous): WorkbenchTaskProgress => ({
							...previous,
							phase: Exit.isSuccess(exit) ? "ready" : "failed"
						})
					)
				),
				Effect.mapError(
					(error) =>
						new WorkbenchProjectUnavailable({
							message: error.message,
							recovery: error.recovery
						})
				)
			);
			if (Option.isNone(summary)) {
				return yield* new WorkbenchProjectUnavailable({
					message: "Project Index refresh ended without a summary.",
					recovery: "Retry the refresh. If it keeps failing, rebuild the Project Index."
				});
			}
			if (summary.value.completeness !== "complete") {
				return yield* new WorkbenchProjectUnavailable({
					message: "Project Index refresh completed with incomplete package coverage.",
					recovery:
						"Retry after resolving the Project Index diagnostics, then refresh again."
				});
			}
			return summary.value;
		});

		const inventoryFromSummary = Effect.fn("Workbench.WorkbenchProject.inventoryFromSummary")(
			function* (projectRoot: string, summary: ProjectIndexSummary) {
				const maps = yield* mapsFromProjectIndex(summary);
				const project = {
					inputAtlas: "deferred" as const,
					mapCount: summary.mapCount,
					packageCount: summary.packageCount,
					projectName: projectName(projectRoot),
					projectRoot
				} satisfies WorkbenchProjectSummary;
				const result = {
					indexSummary: summary,
					maps,
					project
				} satisfies ProjectSummaryInventory;
				yield* Ref.set(selectedSummary, Option.some(result));
				return result;
			}
		);

		const recoverInventory = Effect.fn("Workbench.WorkbenchProject.recoverInventory")(
			function* (projectRoot: string, summary: ProjectIndexSummary) {
				return yield* inventoryFromSummary(projectRoot, summary).pipe(
					Effect.catchTag("ProjectIndexStaleGeneration", () =>
						getProjectIndexStatus({ projectRoot }).pipe(
							Effect.provideService(ProjectIndex, projectIndexImplementation),
							Effect.mapError(
								(error) =>
									new WorkbenchProjectUnavailable({
										message: error.message,
										recovery: error.recovery
									})
							),
							Effect.flatMap((status) =>
								status.status === "ready"
									? inventoryFromSummary(projectRoot, status.summary)
									: refreshSummary(projectRoot).pipe(
											Effect.flatMap((latest) =>
												inventoryFromSummary(projectRoot, latest)
											)
										)
							)
						)
					),
					Effect.mapError((error) =>
						error instanceof WorkbenchProjectUnavailable
							? error
							: new WorkbenchProjectUnavailable({
									message: error.message,
									recovery: error.recovery
								})
					)
				);
			}
		);

		const loadSummaryUncached = Effect.fn("Workbench.WorkbenchProject.loadSummaryUncached")(
			function* (projectRoot: string) {
				const status = yield* getProjectIndexStatus({ projectRoot }).pipe(
					Effect.provideService(ProjectIndex, projectIndexImplementation),
					Effect.mapError(
						(error) =>
							new WorkbenchProjectUnavailable({
								message: error.message,
								recovery: error.recovery
							})
					)
				);
				if (status.status === "absent") {
					return yield* recoverInventory(projectRoot, yield* refreshSummary(projectRoot));
				}

				const committed = yield* recoverInventory(projectRoot, status.summary);
				yield* Ref.set(projectIndexProgress, {
					completed: status.summary.packageCount,
					phase: "ready",
					stage: "project_index",
					total: status.summary.packageCount
				});
				yield* refreshSummary(projectRoot).pipe(
					Effect.flatMap((summary) => recoverInventory(projectRoot, summary)),
					Effect.catch(() => Effect.void),
					Effect.forkIn(layerScope)
				);
				return committed;
			}
		);

		const summaryLoads = yield* Cache.makeWith(loadSummaryUncached, {
			capacity: 4,
			timeToLive: (exit) => (Exit.isSuccess(exit) ? Duration.seconds(30) : Duration.zero)
		});

		const loadSummary = Effect.fn("Workbench.WorkbenchProject.loadSummary")(function* (
			projectRoot: string
		) {
			return yield* Cache.get(summaryLoads, projectRoot);
		});

		const currentInventory = Effect.fn("Workbench.WorkbenchProject.currentInventory")(
			function* (projectRoot: string) {
				const cached = yield* Ref.get(selectedSummary);
				if (Option.isSome(cached) && cached.value.project.projectRoot === projectRoot) {
					return cached.value;
				}
				return yield* loadSummary(projectRoot);
			}
		);

		const inputAtlasFromProjectIndex = Effect.fn(
			"Workbench.WorkbenchProject.inputAtlasFromProjectIndex"
		)(function* (projectRoot: string) {
			const summary = yield* currentInventory(projectRoot);
			if (summary.indexSummary === undefined) {
				return yield* new WorkbenchProjectUnavailable({
					message: "Project Index summary is unavailable.",
					recovery: "Refresh the Project Index, then retry Input Atlas."
				});
			}
			const index = yield* headerIndexFromProjectIndex(
				projectRoot,
				summary.indexSummary,
				"enhanced_input"
			);
			const report = yield* scanEnhancedInputFromProjectIndex(index, { projectRoot }).pipe(
				Effect.provideService(AssetReader, assetReader),
				Effect.mapError(
					(error) =>
						new WorkbenchProjectUnavailable({
							message: error.message,
							recovery: error.recovery
						})
				)
			);
			return { projectRoot, report, status: "completed" as const };
		});

		const inputAtlasLoads = yield* Cache.makeWith(inputAtlasFromProjectIndex, {
			capacity: 4,
			timeToLive: (exit) => (Exit.isSuccess(exit) ? Duration.seconds(30) : Duration.zero)
		});
		const remember = Effect.fn("Workbench.WorkbenchProject.remember")(function* (
			projectRoot: string
		) {
			if (configuration.rememberProjects === false) return;
			yield* history.record(projectRoot).pipe(Effect.ignore);
		});

		const current = Effect.fn("Workbench.WorkbenchProject.current")(function* () {
			const root = yield* Ref.get(selectedRoot);
			if (Option.isNone(root)) return { status: "not_configured" as const };
			return yield* currentInventory(root.value).pipe(
				Effect.tap((inventory) => remember(inventory.project.projectRoot)),
				Effect.map((inventory) => ({
					project: inventory.project,
					status: "ready" as const
				})),
				Effect.catch((error) =>
					Ref.set(selectedSummary, Option.none()).pipe(
						Effect.as({
							error: mapProjectFailure(error.message, error.recovery),
							status: "failed" as const
						})
					)
				)
			);
		});
		const progress = Effect.fn("Workbench.WorkbenchProject.progress")(function* () {
			return yield* Ref.get(projectIndexProgress);
		});
		const open = Effect.fn("Workbench.WorkbenchProject.open")(function* (
			projectRoot: string,
			forceRefresh: boolean
		) {
			if (forceRefresh) yield* Cache.invalidate(summaryLoads, projectRoot);
			yield* Ref.set(selectedSummary, Option.none());
			const inventory = yield* loadSummary(projectRoot);
			yield* Ref.set(selectedRoot, Option.some(projectRoot));
			yield* remember(projectRoot);
			return { project: inventory.project, status: "ready" as const };
		});

		const choose: WorkbenchProjectApi["choose"] = () =>
			Effect.gen(function* () {
				const choice = yield* dialog.chooseDirectory({
					title: "Choose an Unreal project for Workbench"
				});
				if (choice.status === "cancelled") return { status: "cancelled" as const };
				// Choosing a project is an explicit operator request to index it, so it always
				// revalidates against disk rather than answering from the reuse window.
				return yield* open(choice.path, true);
			}).pipe(
				Effect.catch((error) =>
					Effect.succeed({
						error: mapProjectFailure(error.message),
						status: "failed" as const
					})
				)
			);
		const recent: WorkbenchProjectApi["recent"] = () =>
			configuration.rememberProjects === false ? Effect.succeed([]) : history.recent();
		const openRecent: WorkbenchProjectApi["openRecent"] = (projectRoot) =>
			Effect.gen(function* () {
				const projects = yield* recent();
				if (!projects.some((project) => project.projectRoot === projectRoot)) {
					return {
						error: mapProjectFailure(
							"That project is no longer in Workbench's recent list.",
							"Choose it from disk to add it again."
						),
						status: "failed" as const
					};
				}
				return yield* open(projectRoot, false).pipe(
					Effect.catch((error) =>
						Effect.succeed({
							error: mapProjectFailure(error.message, error.recovery),
							status: "failed" as const
						})
					)
				);
			});

		const selected = Effect.fn("Workbench.WorkbenchProject.selected")(function* () {
			const root = yield* Ref.get(selectedRoot);
			if (Option.isNone(root))
				return yield* new WorkbenchProjectUnavailable({
					message: "No Workbench project is selected.",
					recovery: "Choose a project from the Workbench header, then retry."
				});
			return yield* currentInventory(root.value);
		});

		const selectedProject = Effect.fn("Workbench.WorkbenchProject.selectedProject")(
			function* () {
				const root = yield* Ref.get(selectedRoot);
				if (Option.isNone(root)) {
					return yield* new WorkbenchProjectUnavailable({
						message: "No Workbench project is selected.",
						recovery: "Choose a project from the Workbench header, then retry."
					});
				}
				return { projectName: projectName(root.value), projectRoot: root.value };
			}
		);

		const inputAtlas = Effect.fn("Workbench.WorkbenchProject.inputAtlas")(function* () {
			const root = yield* Ref.get(selectedRoot);
			if (Option.isNone(root)) {
				return {
					error: {
						code: "invalid_project" as const,
						message: "No Workbench project is selected.",
						recovery: "Choose a project from the Workbench header, then retry.",
						retrySafe: true
					},
					status: "failed" as const
				};
			}
			return yield* Cache.get(inputAtlasLoads, root.value).pipe(
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

		const withSelectedIndex = Effect.fn("Workbench.WorkbenchProject.withSelectedIndex")(
			function* <A>(
				read: (
					projectRoot: string,
					summary: ProjectIndexSummary
				) => Effect.Effect<A, WorkbenchProjectUnavailable | ProjectIndexError>
			) {
				const summary = yield* selected();
				if (summary.indexSummary === undefined) {
					return yield* new WorkbenchProjectUnavailable({
						message: "Project Index summary is unavailable.",
						recovery: "Refresh the Project Index, then retry the feature."
					});
				}
				return yield* read(summary.project.projectRoot, summary.indexSummary).pipe(
					Effect.catchTag("ProjectIndexStaleGeneration", () =>
						getProjectIndexStatus({ projectRoot: summary.project.projectRoot }).pipe(
							Effect.provideService(ProjectIndex, projectIndexImplementation),
							Effect.mapError(
								(error) =>
									new WorkbenchProjectUnavailable({
										message: error.message,
										recovery: error.recovery
									})
							),
							Effect.flatMap((status) =>
								status.status === "ready"
									? recoverInventory(summary.project.projectRoot, status.summary)
									: refreshSummary(summary.project.projectRoot).pipe(
											Effect.flatMap((latest) =>
												recoverInventory(
													summary.project.projectRoot,
													latest
												)
											)
										)
							),
							Effect.flatMap((latest) => {
								if (latest.indexSummary === undefined) {
									return Effect.fail(
										new WorkbenchProjectUnavailable({
											message: "Project Index summary is unavailable.",
											recovery:
												"Refresh the Project Index, then retry the feature."
										})
									);
								}
								return read(latest.project.projectRoot, latest.indexSummary);
							})
						)
					),
					Effect.mapError((error) =>
						error instanceof WorkbenchProjectUnavailable
							? error
							: new WorkbenchProjectUnavailable({
									message: error.message,
									recovery: error.recovery
								})
					)
				);
			}
		);

		const candidates = Effect.fn("Workbench.WorkbenchProject.candidates")(
			(kind: WorkbenchProjectCandidateKind) =>
				withSelectedIndex((root, summary) =>
					headerIndexFromProjectIndex(root, summary, kind)
				)
		);
		const candidateCount = Effect.fn("Workbench.WorkbenchProject.candidateCount")(
			(kind: WorkbenchProjectCandidateKind) =>
				withSelectedIndex((_root, summary) =>
					countProjectIndex({
						projectId: summary.projectId,
						expectedGeneration: summary.generation,
						filters: candidateFilters(kind)
					}).pipe(
						Effect.provideService(ProjectIndex, projectIndexImplementation),
						Effect.map((result) => result.count)
					)
				)
		);

		const savedProject = Effect.fn("Workbench.WorkbenchProject.savedProject")(function* () {
			const cached = yield* Ref.get(selectedSummary);
			if (Option.isSome(cached)) {
				return { maps: cached.value.maps, projectRoot: cached.value.project.projectRoot };
			}
			const root = yield* Ref.get(selectedRoot);
			if (Option.isNone(root)) {
				return yield* new WorkbenchProjectUnavailable({
					message: "No Workbench project is selected.",
					recovery: "Choose a project from the Workbench header, then retry."
				});
			}
			const summary = yield* loadSummary(root.value);
			return { maps: summary.maps, projectRoot: summary.project.projectRoot };
		});

		const savedTables = Effect.fn("Workbench.WorkbenchProject.savedTables")(function* () {
			const summary = yield* selected();
			const index = yield* candidates("saved_tables");
			const paths = index.assets.map((entry) => entry.header.path);
			const headers = yield* assetReader
				.scanProject({
					classes: [...SAVED_TABLE_SCAN_CLASSES],
					depth: "header",
					paths,
					projectRoot: summary.project.projectRoot
				})
				.pipe(
					Effect.mapError(
						(error) =>
							new WorkbenchProjectUnavailable({
								message: error.message,
								recovery:
									"Retry after checking that the saved-asset worker can read the candidate tables."
							})
					)
				);
			return savedTableCatalogFromScan(headers);
		});

		return WorkbenchProject.of({
			candidateCount,
			candidates,
			choose,
			current,
			inputAtlas,
			openRecent,
			progress,
			recent,
			selectedProject,
			savedProject,
			savedTables
		});
	})
);

export type WorkbenchProjectTestApi = Omit<
	WorkbenchProjectApi,
	"candidateCount" | "candidates" | "openRecent" | "progress" | "recent" | "selectedProject"
> &
	Partial<
		Pick<
			WorkbenchProjectApi,
			| "candidateCount"
			| "candidates"
			| "openRecent"
			| "progress"
			| "recent"
			| "selectedProject"
		>
	>;

export function makeWorkbenchProjectTestLayer(
	service: WorkbenchProjectTestApi
): Layer.Layer<WorkbenchProject> {
	return Layer.succeed(
		WorkbenchProject,
		WorkbenchProject.of({
			...service,
			candidateCount:
				service.candidateCount ??
				(() => Effect.die("candidate counts are not used by this test")),
			candidates:
				service.candidates ??
				(() => Effect.die("project candidates are not used by this test")),
			progress:
				service.progress ??
				(() =>
					Effect.succeed({
						completed: 0,
						phase: "idle",
						stage: "project_index",
						total: 0
					})),
			openRecent:
				service.openRecent ??
				(() => Effect.die("recent project selection is not used by this test")),
			recent: service.recent ?? (() => Effect.succeed([])),
			selectedProject:
				service.selectedProject ??
				(() => Effect.die("selected project identity is not used by this test"))
		})
	);
}
