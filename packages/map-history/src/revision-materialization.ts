import { Effect } from "effect";
import type { HistoricalFileMutation, HistoricalProjectTree } from "./historical-project-tree.js";
import { MapHistoryError } from "./errors.js";
import { PerforceHistorySource, type PerforceDepotFile } from "./perforce.js";
import type { PlannedRevisionFile, ScopedRevisionPlan } from "./revision-plan.js";

function materializationError(message: string, recovery: string): MapHistoryError {
	return new MapHistoryError({
		kind: "materialization",
		message,
		recovery,
		retrySafe: false
	});
}

function materializedKey(file: { readonly depotPath: string; readonly revision: number }): string {
	return `${file.depotPath}\u0000${file.revision}`;
}

function perforceFile(
	change: number,
	file: Exclude<PlannedRevisionFile, { readonly action: "delete" }>
): PerforceDepotFile {
	return {
		action: file.action,
		changelist: change,
		depotPath: file.depotPath,
		revision: file.revision,
		type: file.type
	};
}

/** Materializes exact Perforce revisions and applies their scoped mutations atomically to one tree. */
export function materializePlannedRevision(options: {
	readonly change: number;
	readonly concurrency: number;
	readonly maxFiles: number;
	readonly plan: ScopedRevisionPlan;
	readonly tree: HistoricalProjectTree;
}): Effect.Effect<number, MapHistoryError, PerforceHistorySource> {
	return Effect.fn("MapHistory.materializePlannedRevision")(function* () {
		if (options.plan.kind === "invalid") return yield* Effect.fail(options.plan.error);
		const materializedFiles = options.plan.files.filter(
			(file): file is Exclude<PlannedRevisionFile, { readonly action: "delete" }> =>
				file.action !== "delete"
		);
		if (materializedFiles.length > options.maxFiles) {
			return yield* Effect.fail(
				new MapHistoryError({
					kind: "resource_limit",
					message: `Changelist ${options.change} needs ${materializedFiles.length} materialized files, exceeding the limit of ${options.maxFiles}.`,
					recovery:
						"Narrow the selected map scope or raise maxMaterializedFiles explicitly.",
					retrySafe: false
				})
			);
		}
		const source = yield* PerforceHistorySource;
		const materialized =
			materializedFiles.length === 0
				? []
				: (yield* source.materializeDepotFiles({
						concurrency: options.concurrency,
						directory: options.tree.materializationRoot,
						files: materializedFiles.map((file) => perforceFile(options.change, file)),
						maxFiles: options.maxFiles
					})).files;
		const localPaths = new Map(
			materialized.map((file) => [materializedKey(file.file), file.localPath])
		);
		const mutations: HistoricalFileMutation[] = [];
		for (const file of options.plan.files) {
			if (file.action === "delete") {
				mutations.push({ action: "delete", projectRelativePath: file.projectRelativePath });
				continue;
			}
			const localPath = localPaths.get(materializedKey(file));
			if (localPath === undefined) {
				return yield* Effect.fail(
					materializationError(
						`Perforce did not materialize ${file.depotPath}#${file.revision}.`,
						"Check the exact depot revision and retry the historical reconstruction."
					)
				);
			}
			mutations.push({
				action: file.action,
				materializedPath: localPath,
				projectRelativePath: file.projectRelativePath
			});
		}
		yield* options.tree.applyRevision(mutations);
		return materializedFiles.length;
	})();
}
