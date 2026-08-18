import { Context, Effect, Exit, Layer, Ref } from "effect";
import { AssetReader, AssetReaderLive, type AssetReaderError } from "@ue-shed/unreal-assets";
import type { SavedWorld } from "@ue-shed/protocol";
import { materializeBaseline } from "./baseline-materialization.js";
import { diffSavedWorldSnapshots } from "./diff.js";
import { MapHistoryError } from "./errors.js";
import { resolvePerforceFastMapScope } from "./fast-history-target.js";
import { acquireHistoricalProjectTree } from "./historical-project-tree.js";
import { findUnclassifiedPackageChanges } from "./package-correlation.js";
import {
	perforceHistorySourceLayer,
	PerforceProjectContext,
	PerforceHistorySource,
	type PerforceChangedFile
} from "./perforce.js";
import {
	resolvePerforceMapLineage,
	resolvePerforceMapScope,
	scopedPerforceFile,
	type ResolvedPerforceMapLineage,
	type ResolvedPerforceMapScope
} from "./perforce-map-scope.js";
import { materializePlannedRevision } from "./revision-materialization.js";
import { planScopedRevision, type PlannedPackageChange } from "./revision-plan.js";
import {
	type MapHistoryDiagnostic,
	type MapHistoryProgress,
	type MapHistorySnapshot,
	PerforceChangeNumber,
	PerforceDepotPath,
	type PerforceFastMapHistory,
	type PerforceFastMapHistoryQuery,
	type PerforceMapHistory,
	type PerforceMapHistoryQuery,
	type PerforceMapRevision,
	type PerforcePackageRevision,
	type SavedPackageChangeEvidence,
	ProjectRelativeMapPath
} from "./schema.js";
import { selectSubmittedChanges } from "./submitted-change-selection.js";

export interface MapHistoryApi {
	readonly progress: () => Effect.Effect<MapHistoryProgress>;
	readonly readPerforceMapHistory: (
		query: PerforceMapHistoryQuery
	) => Effect.Effect<PerforceMapHistory, MapHistoryError>;
	readonly readPerforceFastMapHistory: (
		query: PerforceFastMapHistoryQuery
	) => Effect.Effect<PerforceFastMapHistory, MapHistoryError>;
}

/** The Perforce-first Map History workflow. It owns no credentials or source-control policy. */
export class MapHistory extends Context.Service<MapHistory, MapHistoryApi>()(
	"@ue-shed/map-history/MapHistory"
) {}

function progress(
	phase: MapHistoryProgress["phase"],
	processedChangelists: number,
	totalChangelists: number
): MapHistoryProgress {
	return { phase, processedChangelists, totalChangelists };
}

function savedWorldError(operation: string, error: AssetReaderError): MapHistoryError {
	return new MapHistoryError({
		kind: error.kind === "resource_limit" ? "resource_limit" : "saved_world_decode",
		message: `${operation}: ${error.message}`,
		recovery:
			error.kind === "resource_limit"
				? "Narrow the map scope or raise maxPackages explicitly."
				: "Confirm the historical map files can be read and retry.",
		retrySafe: error.retrySafe
	});
}

function historicalLayoutError(
	scope: ResolvedPerforceMapScope,
	world: SavedWorld
): MapHistoryError {
	return new MapHistoryError({
		kind: "unsupported_history_layout",
		message: `Historical map storage is ${world.sourceKind}, but the selected map currently uses ${scope.sourceKind}.`,
		recovery:
			"Choose a range that does not cross a conventional-level and World Partition conversion.",
		retrySafe: false
	});
}

function evidenceError(file: PerforceChangedFile): MapHistoryError {
	return new MapHistoryError({
		kind: "perforce_command",
		message: `Perforce reported no exact revision for changed map file ${file.depotPath}.`,
		recovery: "Check the submitted changelist metadata and retry.",
		retrySafe: false
	});
}

function compareText(left: string, right: string): number {
	return left < right ? -1 : left > right ? 1 : 0;
}

function packageChangeEvidence(
	changes: readonly PlannedPackageChange[]
): readonly SavedPackageChangeEvidence[] {
	return changes.map((change) => ({
		action: change.action,
		afterRevision: change.afterRevision,
		beforeRevision: change.beforeRevision,
		depotPath: PerforceDepotPath.make(change.depotPath),
		packageName: change.packageName
	}));
}

function packageRevisionEvidence(
	files: readonly PerforceChangedFile[],
	scopes: readonly ResolvedPerforceMapScope[]
): Effect.Effect<readonly PerforcePackageRevision[], MapHistoryError> {
	const evidence: PerforcePackageRevision[] = [];
	for (const file of files) {
		if (!scopes.some((scope) => scopedPerforceFile(scope, file.depotPath) !== undefined))
			continue;
		if (file.revision === null || file.revision <= 0) return Effect.fail(evidenceError(file));
		evidence.push({
			action: file.action,
			depotPath: PerforceDepotPath.make(file.depotPath),
			revision: file.revision
		});
	}
	evidence.sort((left, right) => compareText(left.depotPath, right.depotPath));
	return Effect.succeed(evidence);
}

function lineageScopeAtChange(
	lineage: ResolvedPerforceMapLineage,
	change: number
): ResolvedPerforceMapScope {
	let index = 0;
	while (true) {
		const move = lineage.moves[index];
		if (move === undefined || move.change > change) break;
		index += 1;
	}
	const scope = lineage.locations[index];
	if (scope === undefined) {
		throw new Error("Resolved map lineage has no location for the requested changelist.");
	}
	return scope;
}

function scopedFilesForRevision(
	files: readonly PerforceChangedFile[],
	scopes: readonly ResolvedPerforceMapScope[]
) {
	const byDepotPath = new Map<string, NonNullable<ReturnType<typeof scopedPerforceFile>>>();
	for (const file of files) {
		for (const scope of scopes) {
			const scoped = scopedPerforceFile(scope, file.depotPath);
			if (scoped !== undefined) byDepotPath.set(scoped.depotPath, scoped);
		}
	}
	return [...byDepotPath.values()];
}

function assertResolvedMove(options: {
	readonly after: ResolvedPerforceMapScope;
	readonly before: ResolvedPerforceMapScope;
	readonly change: number;
	readonly files: readonly PerforceChangedFile[];
}): Effect.Effect<void, MapHistoryError> {
	const deletesCurrentMap = options.files.some(
		(file) => file.depotPath === options.before.mapDepotPath && file.action === "move/delete"
	);
	if (!deletesCurrentMap || options.after.mapDepotPath !== options.before.mapDepotPath) {
		return Effect.void;
	}
	return Effect.fail(
		new MapHistoryError({
			kind: "ambiguous_map_lineage",
			message: `Changelist ${options.change} moves ${options.before.mapDepotPath}, but Perforce did not provide one bounded direct destination.`,
			recovery: "Inspect the map's direct Perforce move records and retry.",
			retrySafe: false
		})
	);
}

function emptyWorldBeforeCreation(world: SavedWorld): SavedWorld {
	return { ...world, actors: [], diagnostics: [] };
}

function deduplicateDiagnostics(
	diagnostics: readonly MapHistoryDiagnostic[]
): readonly MapHistoryDiagnostic[] {
	const unique = new Map<string, MapHistoryDiagnostic>();
	for (const diagnostic of diagnostics) {
		unique.set(
			`${diagnostic.code}\u0000${diagnostic.message}\u0000${diagnostic.retrySafe}`,
			diagnostic
		);
	}
	return [...unique.values()].sort((left, right) =>
		compareText(`${left.code}\u0000${left.message}`, `${right.code}\u0000${right.message}`)
	);
}

function readHistoricalWorld(options: {
	readonly limits: PerforceMapHistoryQuery["limits"];
	readonly scope: ResolvedPerforceMapScope;
	readonly treeProjectRoot: string;
}): Effect.Effect<SavedWorld, MapHistoryError, AssetReader> {
	return Effect.fn("MapHistory.readHistoricalWorld")(function* () {
		const reader = yield* AssetReader;
		const world = yield* reader
			.readSavedWorld({
				concurrency: options.limits.maxConcurrency,
				mapPath: options.scope.mapProjectRelativePath,
				maximumAssets: options.limits.maxPackages,
				projectRoot: options.treeProjectRoot
			})
			.pipe(
				Effect.mapError((error) => savedWorldError("Could not read historical map", error))
			);
		if (world.sourceKind !== options.scope.sourceKind) {
			return yield* Effect.fail(historicalLayoutError(options.scope, world));
		}
		return world;
	})();
}

function snapshotOf(world: SavedWorld, scope: ResolvedPerforceMapScope): MapHistorySnapshot {
	return {
		actors: world.actors,
		completeness: world.completeness,
		diagnostics: world.diagnostics,
		mapPackage: world.authority.mapPackage,
		mapPath: ProjectRelativeMapPath.make(scope.mapProjectRelativePath),
		sourceKind: world.sourceKind,
		summary: world.summary
	};
}

interface ReconstructedMapHistoryBody {
	readonly baseline: PerforceMapHistory["baseline"];
	readonly completeness: PerforceMapHistory["completeness"];
	readonly diagnostics: readonly MapHistoryDiagnostic[];
	readonly externalActorDepotRoot?: PerforceDepotPath;
	readonly mapDepotPath: PerforceDepotPath;
	readonly rangeEndSnapshot?: MapHistorySnapshot;
	readonly rangeStartSnapshot?: MapHistorySnapshot;
	readonly revisions: readonly PerforceMapRevision[];
}

function reconstructScopedMapHistory(options: {
	readonly limits: PerforceMapHistoryQuery["limits"];
	readonly projectRoot: PerforceMapHistoryQuery["projectRoot"];
	readonly range: PerforceMapHistoryQuery["range"];
	readonly reportProgress: (value: MapHistoryProgress) => Effect.Effect<void>;
	readonly scope: ResolvedPerforceMapScope;
}): Effect.Effect<
	ReconstructedMapHistoryBody,
	MapHistoryError,
	AssetReader | PerforceHistorySource | import("effect").Scope.Scope
> {
	return Effect.fn("MapHistory.reconstructScopedMapHistory")(function* () {
		const { limits, range, reportProgress, scope } = options;
		yield* reportProgress(progress("listing_changes", 0, 0));
		const lineage = yield* resolvePerforceMapLineage({
			limits,
			projectRoot: options.projectRoot,
			scope
		});
		const selection = yield* selectSubmittedChanges({
			fileSpecs: lineage.locations.flatMap((location) => location.fileSpecs),
			maxChangelists: limits.maxChangelists,
			range
		});
		const totalChangelists = selection.revisions.length;
		const tree = yield* acquireHistoricalProjectTree();
		const diagnostics: MapHistoryDiagnostic[] = [];
		let complete = true;
		let materializedFiles = 0;
		let previous: SavedWorld | undefined;
		let previousScope: ResolvedPerforceMapScope | undefined;
		let rangeStartSnapshot: MapHistorySnapshot | undefined;

		if (selection.baseline !== undefined) {
			const baselineScope = lineageScopeAtChange(lineage, selection.baseline.change);
			yield* reportProgress(progress("materializing_baseline", 0, totalChangelists));
			materializedFiles += yield* materializeBaseline({
				change: selection.baseline.change,
				concurrency: limits.maxConcurrency,
				maxFiles: limits.maxMaterializedFiles,
				scope: baselineScope,
				tree
			});
			yield* reportProgress(progress("parsing", 0, totalChangelists));
			previous = yield* readHistoricalWorld({
				limits,
				scope: baselineScope,
				treeProjectRoot: tree.projectRoot
			});
			complete &&= previous.completeness === "complete";
			diagnostics.push(...previous.diagnostics);
			previousScope = baselineScope;
			rangeStartSnapshot = snapshotOf(previous, baselineScope);
		}

		const source = yield* PerforceHistorySource;
		const revisions: PerforceMapRevision[] = [];
		for (const [index, selected] of selection.revisions.entries()) {
			yield* reportProgress(progress("applying_revision", index, totalChangelists));
			const described = yield* source.describeChangelist(selected.change);
			if (described.status !== "submitted") {
				return yield* Effect.fail(
					new MapHistoryError({
						kind: "perforce_command",
						message: `Changelist ${selected.change} is not submitted.`,
						recovery: "Select submitted Perforce history and retry.",
						retrySafe: false
					})
				);
			}
			const beforeScope = lineageScopeAtChange(lineage, selected.change - 1);
			const afterScope = lineageScopeAtChange(lineage, selected.change);
			yield* assertResolvedMove({
				after: afterScope,
				before: beforeScope,
				change: selected.change,
				files: described.files
			});
			const revisionScopes =
				beforeScope.mapDepotPath === afterScope.mapDepotPath
					? [afterScope]
					: [beforeScope, afterScope];
			const plan = planScopedRevision({
				files: described.files,
				scope: scopedFilesForRevision(described.files, revisionScopes)
			});
			const remainingMaterializations = limits.maxMaterializedFiles - materializedFiles;
			materializedFiles += yield* materializePlannedRevision({
				change: selected.change,
				concurrency: limits.maxConcurrency,
				maxFiles: Math.max(0, remainingMaterializations),
				plan,
				tree
			});
			yield* reportProgress(progress("parsing", index, totalChangelists));
			const current = yield* readHistoricalWorld({
				limits,
				scope: afterScope,
				treeProjectRoot: tree.projectRoot
			});
			yield* reportProgress(progress("diffing", index, totalChangelists));
			const before = previous ?? emptyWorldBeforeCreation(current);
			const snapshotDiff = diffSavedWorldSnapshots(before, current);
			const evidence = yield* packageRevisionEvidence(described.files, revisionScopes);
			const unclassifiedPackageChanges = findUnclassifiedPackageChanges({
				after: current,
				before,
				diff: snapshotDiff,
				packageChanges:
					plan.kind === "ready" ? packageChangeEvidence(plan.packageChanges) : []
			});
			const revisionDiagnostics = [...current.diagnostics, ...snapshotDiff.diagnostics];
			revisions.push({
				...(selected.description === undefined
					? undefined
					: { description: selected.description }),
				...(selected.user === undefined ? undefined : { user: selected.user }),
				change: PerforceChangeNumber.make(selected.change),
				changes: snapshotDiff.changes,
				completeness: current.completeness,
				diagnostics: revisionDiagnostics,
				files: evidence,
				submittedAt: selected.submittedAt,
				unclassifiedPackageChanges
			});
			complete &&= current.completeness === "complete";
			diagnostics.push(...revisionDiagnostics);
			previous = current;
			previousScope = afterScope;
			yield* reportProgress(progress("applying_revision", index + 1, totalChangelists));
		}

		const completeness: PerforceMapHistory["completeness"] = complete ? "complete" : "partial";
		return {
			baseline:
				selection.baseline === undefined
					? { status: "map_not_yet_created" as const }
					: {
							change: PerforceChangeNumber.make(selection.baseline.change),
							status: "available" as const
						},
			completeness,
			diagnostics: deduplicateDiagnostics(diagnostics),
			...(scope.externalActorDepotRoot === undefined
				? undefined
				: { externalActorDepotRoot: PerforceDepotPath.make(scope.externalActorDepotRoot) }),
			mapDepotPath: PerforceDepotPath.make((lineage.locations.at(-1) ?? scope).mapDepotPath),
			...(rangeStartSnapshot === undefined ? undefined : { rangeStartSnapshot }),
			...(previous === undefined || previousScope === undefined
				? undefined
				: { rangeEndSnapshot: snapshotOf(previous, previousScope) }),
			revisions
		};
	})();
}

function readPerforceMapHistoryWorkflow(
	query: PerforceMapHistoryQuery,
	reportProgress: (value: MapHistoryProgress) => Effect.Effect<void>
): Effect.Effect<
	PerforceMapHistory,
	MapHistoryError,
	AssetReader | PerforceHistorySource | import("effect").Scope.Scope
> {
	return Effect.fn("MapHistory.readPerforceMapHistory")(function* () {
		yield* reportProgress(progress("resolving_scope", 0, 0));
		const scope = yield* resolvePerforceMapScope(query);
		const body = yield* reconstructScopedMapHistory({
			limits: query.limits,
			projectRoot: query.projectRoot,
			range: query.range,
			reportProgress,
			scope
		});
		return {
			...body,
			query,
			schemaVersion: 1 as const
		};
	})();
}

function readPerforceFastMapHistoryWorkflow(
	query: PerforceFastMapHistoryQuery,
	reportProgress: (value: MapHistoryProgress) => Effect.Effect<void>
): Effect.Effect<
	PerforceFastMapHistory,
	MapHistoryError,
	AssetReader | PerforceHistorySource | import("effect").Scope.Scope
> {
	return Effect.fn("MapHistory.readPerforceFastMapHistory")(function* () {
		yield* reportProgress(progress("resolving_scope", 0, 0));
		const resolved = yield* resolvePerforceFastMapScope(query);
		const body = yield* reconstructScopedMapHistory({
			limits: query.limits,
			projectRoot: query.projectRoot,
			range: query.range,
			reportProgress,
			scope: resolved.scope
		});
		return {
			...body,
			coverage: resolved.coverage,
			mode: "fast" as const,
			query,
			schemaVersion: 1 as const
		};
	})();
}

function durationError(maxDurationMs: number): MapHistoryError {
	return new MapHistoryError({
		kind: "resource_limit",
		message: `Map history exceeded its ${maxDurationMs}ms duration limit.`,
		recovery: "Narrow the history range or raise maxDurationMs explicitly.",
		retrySafe: true
	});
}

/** Builds Map History from injected snapshot and Perforce boundaries. */
export const mapHistoryLayer: Layer.Layer<MapHistory, never, AssetReader | PerforceHistorySource> =
	Layer.effect(
		MapHistory,
		Effect.gen(function* () {
			const reader = yield* AssetReader;
			const perforce = yield* PerforceHistorySource;
			const latestProgress = yield* Ref.make(progress("idle", 0, 0));
			const reportProgress = (value: MapHistoryProgress) => Ref.set(latestProgress, value);
			return MapHistory.of({
				progress: () => Ref.get(latestProgress),
				readPerforceFastMapHistory: (query) =>
					Effect.scoped(readPerforceFastMapHistoryWorkflow(query, reportProgress)).pipe(
						Effect.provideService(AssetReader, reader),
						Effect.provideService(PerforceHistorySource, perforce),
						Effect.provideService(PerforceProjectContext, query.projectRoot),
						Effect.timeoutOrElse({
							duration: query.limits.maxDurationMs,
							orElse: () => Effect.fail(durationError(query.limits.maxDurationMs))
						}),
						Effect.onExit((exit) =>
							reportProgress(
								progress(Exit.isSuccess(exit) ? "ready" : "failed", 0, 0)
							)
						),
						Effect.withSpan("map_history.read_perforce_fast")
					),
				readPerforceMapHistory: (query) =>
					Effect.scoped(readPerforceMapHistoryWorkflow(query, reportProgress)).pipe(
						Effect.provideService(AssetReader, reader),
						Effect.provideService(PerforceHistorySource, perforce),
						Effect.provideService(PerforceProjectContext, query.projectRoot),
						Effect.timeoutOrElse({
							duration: query.limits.maxDurationMs,
							orElse: () => Effect.fail(durationError(query.limits.maxDurationMs))
						}),
						Effect.onExit((exit) =>
							reportProgress(
								progress(Exit.isSuccess(exit) ? "ready" : "failed", 0, 0)
							)
						),
						Effect.withSpan("map_history.read_perforce")
					)
			});
		})
	);

/** The optional default layer uses the configured asset reader and local Perforce configuration. */
export const mapHistoryLiveLayer = Layer.provide(
	mapHistoryLayer,
	Layer.merge(AssetReaderLive, perforceHistorySourceLayer())
);

export function makeMapHistoryTestLayer(service: MapHistoryApi): Layer.Layer<MapHistory> {
	return Layer.succeed(MapHistory, MapHistory.of(service));
}

export function readPerforceMapHistory(
	query: PerforceMapHistoryQuery
): Effect.Effect<PerforceMapHistory, MapHistoryError, MapHistory> {
	return Effect.flatMap(MapHistory, (history) => history.readPerforceMapHistory(query));
}

export function readPerforceFastMapHistory(
	query: PerforceFastMapHistoryQuery
): Effect.Effect<PerforceFastMapHistory, MapHistoryError, MapHistory> {
	return Effect.flatMap(MapHistory, (history) => history.readPerforceFastMapHistory(query));
}

export function mapHistoryProgress(): Effect.Effect<MapHistoryProgress, never, MapHistory> {
	return Effect.flatMap(MapHistory, (history) => history.progress());
}
