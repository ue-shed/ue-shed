import { Context, Effect, Exit, Layer, Ref } from "effect";
import { assetReaderLayer, AssetReader, type AssetReaderError } from "@ue-shed/unreal-assets";
import type { SavedWorld } from "@ue-shed/protocol";
import { materializeBaseline } from "./baseline-materialization.js";
import { diffSavedWorldSnapshots } from "./diff.js";
import { MapHistoryError } from "./errors.js";
import { acquireHistoricalProjectTree } from "./historical-project-tree.js";
import { findUnclassifiedPackageChanges } from "./package-correlation.js";
import {
	perforceHistorySourceLayer,
	PerforceHistorySource,
	type PerforceChangedFile
} from "./perforce.js";
import {
	resolvePerforceMapScope,
	scopedPerforceFile,
	type ResolvedPerforceMapScope
} from "./perforce-map-scope.js";
import { materializePlannedRevision } from "./revision-materialization.js";
import { planScopedRevision, type PlannedPackageChange } from "./revision-plan.js";
import {
	type MapHistoryDiagnostic,
	type MapHistoryProgress,
	type MapHistoryRangeEndSnapshot,
	type PerforceChangeNumber,
	type PerforceDepotPath,
	type PerforceMapHistory,
	type PerforceMapHistoryQuery,
	type PerforceMapRevision,
	type PerforcePackageRevision,
	type SavedPackageChangeEvidence
} from "./schema.js";
import { selectSubmittedChanges } from "./submitted-change-selection.js";

export interface MapHistoryShape {
	readonly progress: () => Effect.Effect<MapHistoryProgress>;
	readonly readPerforceMapHistory: (
		query: PerforceMapHistoryQuery
	) => Effect.Effect<PerforceMapHistory, MapHistoryError>;
}

/** The Perforce-first Map History workflow. It owns no credentials or source-control policy. */
export class MapHistory extends Context.Service<MapHistory, MapHistoryShape>()(
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
		depotPath: change.depotPath as PerforceDepotPath,
		packageName: change.packageName
	}));
}

function packageRevisionEvidence(
	files: readonly PerforceChangedFile[],
	scope: ResolvedPerforceMapScope
): Effect.Effect<readonly PerforcePackageRevision[], MapHistoryError> {
	const evidence: PerforcePackageRevision[] = [];
	for (const file of files) {
		if (scopedPerforceFile(scope, file.depotPath) === undefined) continue;
		if (file.revision === null || file.revision <= 0) return Effect.fail(evidenceError(file));
		evidence.push({
			action: file.action,
			depotPath: file.depotPath as PerforceDepotPath,
			revision: file.revision
		});
	}
	evidence.sort((left, right) => compareText(left.depotPath, right.depotPath));
	return Effect.succeed(evidence);
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
	readonly query: PerforceMapHistoryQuery;
	readonly scope: ResolvedPerforceMapScope;
	readonly treeProjectRoot: string;
}): Effect.Effect<SavedWorld, MapHistoryError, AssetReader> {
	return Effect.fn("MapHistory.readHistoricalWorld")(function* () {
		const reader = yield* AssetReader;
		const world = yield* reader
			.readSavedWorld({
				concurrency: options.query.limits.maxConcurrency,
				mapPath: options.scope.mapProjectRelativePath,
				maximumAssets: options.query.limits.maxPackages,
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

function rangeEndSnapshotOf(world: SavedWorld): MapHistoryRangeEndSnapshot {
	return {
		actors: world.actors,
		completeness: world.completeness,
		diagnostics: world.diagnostics,
		mapPackage: world.authority.mapPackage,
		mapPath: world.mapPath as MapHistoryRangeEndSnapshot["mapPath"],
		sourceKind: world.sourceKind,
		summary: world.summary
	};
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
		yield* reportProgress(progress("listing_changes", 0, 0));
		const selection = yield* selectSubmittedChanges({
			fileSpecs: scope.fileSpecs,
			maxChangelists: query.limits.maxChangelists,
			range: query.range
		});
		const totalChangelists = selection.revisions.length;
		const tree = yield* acquireHistoricalProjectTree();
		const diagnostics: MapHistoryDiagnostic[] = [];
		let complete = true;
		let materializedFiles = 0;
		let previous: SavedWorld | undefined;

		if (selection.baseline !== undefined) {
			yield* reportProgress(progress("materializing_baseline", 0, totalChangelists));
			materializedFiles += yield* materializeBaseline({
				change: selection.baseline.change,
				concurrency: query.limits.maxConcurrency,
				maxFiles: query.limits.maxMaterializedFiles,
				scope,
				tree
			});
			yield* reportProgress(progress("parsing", 0, totalChangelists));
			previous = yield* readHistoricalWorld({
				query,
				scope,
				treeProjectRoot: tree.projectRoot
			});
			complete &&= previous.completeness === "complete";
			diagnostics.push(...previous.diagnostics);
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
			const plan = planScopedRevision({
				files: described.files,
				scope: described.files
					.map((file) => scopedPerforceFile(scope, file.depotPath))
					.filter((file): file is NonNullable<typeof file> => file !== undefined)
			});
			const remainingMaterializations = query.limits.maxMaterializedFiles - materializedFiles;
			materializedFiles += yield* materializePlannedRevision({
				change: selected.change,
				concurrency: query.limits.maxConcurrency,
				maxFiles: Math.max(0, remainingMaterializations),
				plan,
				tree
			});
			yield* reportProgress(progress("parsing", index, totalChangelists));
			const current = yield* readHistoricalWorld({
				query,
				scope,
				treeProjectRoot: tree.projectRoot
			});
			yield* reportProgress(progress("diffing", index, totalChangelists));
			const before = previous ?? emptyWorldBeforeCreation(current);
			const snapshotDiff = diffSavedWorldSnapshots(before, current);
			const evidence = yield* packageRevisionEvidence(described.files, scope);
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
					? {}
					: { description: selected.description }),
				...(selected.user === undefined ? {} : { user: selected.user }),
				change: selected.change as PerforceChangeNumber,
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
			yield* reportProgress(progress("applying_revision", index + 1, totalChangelists));
		}

		const completeness: PerforceMapHistory["completeness"] = complete ? "complete" : "partial";
		return {
			baseline:
				selection.baseline === undefined
					? { status: "map_not_yet_created" as const }
					: {
							change: selection.baseline.change as PerforceChangeNumber,
							status: "available" as const
						},
			completeness,
			diagnostics: deduplicateDiagnostics(diagnostics),
			...(scope.externalActorDepotRoot === undefined
				? {}
				: { externalActorDepotRoot: scope.externalActorDepotRoot as PerforceDepotPath }),
			mapDepotPath: scope.mapDepotPath as PerforceDepotPath,
			query,
			...(previous === undefined ? {} : { rangeEndSnapshot: rangeEndSnapshotOf(previous) }),
			revisions,
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
				readPerforceMapHistory: (query) =>
					Effect.scoped(readPerforceMapHistoryWorkflow(query, reportProgress)).pipe(
						Effect.provideService(AssetReader, reader),
						Effect.provideService(PerforceHistorySource, perforce),
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
	Layer.merge(assetReaderLayer(), perforceHistorySourceLayer())
);

export function makeMapHistoryTestLayer(service: MapHistoryShape): Layer.Layer<MapHistory> {
	return Layer.succeed(MapHistory, MapHistory.of(service));
}

export function readPerforceMapHistory(
	query: PerforceMapHistoryQuery
): Effect.Effect<PerforceMapHistory, MapHistoryError, MapHistory> {
	return Effect.flatMap(MapHistory, (history) => history.readPerforceMapHistory(query));
}

export function mapHistoryProgress(): Effect.Effect<MapHistoryProgress, never, MapHistory> {
	return Effect.flatMap(MapHistory, (history) => history.progress());
}
