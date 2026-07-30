import { Effect } from "effect";
import { MapHistoryError } from "./errors.js";
import type { HistoricalProjectTree } from "./historical-project-tree.js";
import { scopedPerforceFile, type ResolvedPerforceMapScope } from "./perforce-map-scope.js";
import { PerforceHistorySource, type PerforceDepotFile } from "./perforce.js";
import { materializePlannedRevision } from "./revision-materialization.js";
import { planScopedRevision } from "./revision-plan.js";

function baselineError(message: string, recovery: string): MapHistoryError {
	return new MapHistoryError({
		kind: "baseline_unavailable",
		message,
		recovery,
		retrySafe: false
	});
}

function resourceLimitError(change: number, maxFiles: number): MapHistoryError {
	return new MapHistoryError({
		kind: "resource_limit",
		message: `Baseline changelist ${change} exceeds the ${maxFiles} file limit.`,
		recovery: "Narrow the selected map scope or raise maxMaterializedFiles explicitly.",
		retrySafe: false
	});
}

function isSameDepotRevision(left: PerforceDepotFile, right: PerforceDepotFile): boolean {
	return (
		left.action === right.action &&
		left.changelist === right.changelist &&
		left.depotPath === right.depotPath &&
		left.revision === right.revision &&
		left.type === right.type
	);
}

/**
 * Inventories and materializes the exact map state before the selected range. The inventory is
 * bounded per scope and as one combined set, so a partial P4 response can never become a baseline.
 */
export function materializeBaseline(options: {
	readonly change: number;
	readonly concurrency: number;
	readonly maxFiles: number;
	readonly scope: ResolvedPerforceMapScope;
	readonly tree: HistoricalProjectTree;
}): Effect.Effect<number, MapHistoryError, PerforceHistorySource> {
	return Effect.fn("MapHistory.materializeBaseline")(function* () {
		const source = yield* PerforceHistorySource;
		const byDepotPath = new Map<string, PerforceDepotFile>();
		for (const depotPath of options.scope.fileSpecs) {
			const remaining = options.maxFiles - byDepotPath.size;
			if (remaining <= 0)
				return yield* Effect.fail(resourceLimitError(options.change, options.maxFiles));
			const listed = yield* source.listDepotFilesAtChange({
				change: options.change,
				depotPath,
				maxFiles: remaining
			});
			if (listed.hasMore) {
				return yield* Effect.fail(resourceLimitError(options.change, options.maxFiles));
			}
			for (const file of listed.files) {
				const previous = byDepotPath.get(file.depotPath);
				if (previous !== undefined && !isSameDepotRevision(previous, file)) {
					return yield* Effect.fail(
						baselineError(
							`Perforce returned conflicting baseline revisions for ${file.depotPath}.`,
							"Check the Perforce depot mapping and retry the historical reconstruction."
						)
					);
				}
				byDepotPath.set(file.depotPath, file);
				if (byDepotPath.size > options.maxFiles) {
					return yield* Effect.fail(resourceLimitError(options.change, options.maxFiles));
				}
			}
		}

		const files = [...byDepotPath.values()];
		const scoped = files
			.map((file) => scopedPerforceFile(options.scope, file.depotPath))
			.filter((file): file is NonNullable<typeof file> => file !== undefined);
		if (!scoped.some((file) => file.depotPath === options.scope.mapDepotPath)) {
			return yield* Effect.fail(
				baselineError(
					`The selected map does not exist at baseline changelist ${options.change}.`,
					"Choose a range after the map was created or include its creation changelist."
				)
			);
		}
		const plan = planScopedRevision({
			files: files.map((file) => ({
				action: file.action,
				depotPath: file.depotPath,
				revision: file.revision,
				type: file.type
			})),
			scope: scoped
		});
		return yield* materializePlannedRevision({
			change: options.change,
			concurrency: options.concurrency,
			maxFiles: options.maxFiles,
			plan,
			tree: options.tree
		});
	})();
}
