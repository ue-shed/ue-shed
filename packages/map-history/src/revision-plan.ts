import type { PerforceChangedFile } from "./perforce.js";
import { MapHistoryError } from "./errors.js";

export interface ScopedPerforceFile {
	readonly depotPath: string;
	readonly packageName: string;
	readonly projectRelativePath: string;
}

export interface PlannedPackageChange {
	readonly action: string;
	readonly afterRevision: number | null;
	readonly beforeRevision: number | null;
	readonly depotPath: string;
	readonly packageName: string;
}

export type PlannedRevisionFile =
	| {
			readonly action: "delete";
			readonly depotPath: string;
			readonly packageName: string;
			readonly projectRelativePath: string;
	  }
	| {
			readonly action: "add" | "edit";
			readonly depotPath: string;
			readonly packageName: string;
			readonly projectRelativePath: string;
			readonly revision: number;
			readonly type: string;
	  };

export type ScopedRevisionPlan =
	| {
			readonly kind: "ready";
			readonly packageChanges: readonly PlannedPackageChange[];
			readonly files: readonly PlannedRevisionFile[];
	  }
	| { readonly kind: "invalid"; readonly error: MapHistoryError };

function planError(message: string, recovery: string): ScopedRevisionPlan {
	return {
		kind: "invalid",
		error: new MapHistoryError({
			kind: "materialization",
			message,
			recovery,
			retrySafe: false
		})
	};
}

function isDeletion(action: string): boolean {
	return action === "delete" || action === "move/delete" || action === "purge";
}

function isAddition(action: string): boolean {
	return action === "add" || action === "branch" || action === "move/add";
}

function beforeRevision(action: string, revision: number | null): number | null {
	if (isAddition(action) || revision === null || revision <= 1) return null;
	return revision - 1;
}

function compareText(left: string, right: string): number {
	return left < right ? -1 : left > right ? 1 : 0;
}

/**
 * Reduces a described changelist to exact, already-resolved map files. Files outside the selected
 * map scope cannot enter the historical project tree.
 */
export function planScopedRevision(options: {
	readonly files: readonly PerforceChangedFile[];
	readonly scope: readonly ScopedPerforceFile[];
}): ScopedRevisionPlan {
	const scopeByDepotPath = new Map(options.scope.map((file) => [file.depotPath, file]));
	const targets = new Set<string>();
	const files: PlannedRevisionFile[] = [];
	const packageChanges: PlannedPackageChange[] = [];

	for (const described of options.files) {
		const scoped = scopeByDepotPath.get(described.depotPath);
		if (scoped === undefined) continue;
		const target = scoped.projectRelativePath.toLocaleLowerCase("en-US");
		if (targets.has(target)) {
			return planError(
				`Changelist contains multiple updates for ${scoped.projectRelativePath}.`,
				"Resolve the changelist file records before reconstructing history."
			);
		}
		targets.add(target);

		const deletion = isDeletion(described.action);
		const revision = described.revision;
		const type = described.type;
		if (!deletion && (revision === null || type === null)) {
			return planError(
				`Changelist file ${described.depotPath} has no exact revision metadata.`,
				"Perforce must report a numeric revision and file type before history can materialize it."
			);
		}
		const priorRevision = beforeRevision(described.action, described.revision);
		packageChanges.push({
			action: described.action,
			afterRevision: deletion ? null : revision,
			beforeRevision: priorRevision,
			depotPath: described.depotPath,
			packageName: scoped.packageName
		});
		if (deletion) {
			files.push({
				action: "delete",
				depotPath: described.depotPath,
				packageName: scoped.packageName,
				projectRelativePath: scoped.projectRelativePath
			});
			continue;
		}
		if (revision === null || type === null) {
			return planError(
				`Changelist file ${described.depotPath} has no exact revision metadata.`,
				"Perforce must report a numeric revision and file type before history can materialize it."
			);
		}
		files.push({
			action: isAddition(described.action) ? "add" : "edit",
			depotPath: described.depotPath,
			packageName: scoped.packageName,
			projectRelativePath: scoped.projectRelativePath,
			revision,
			type
		});
	}

	files.sort((left, right) => compareText(left.projectRelativePath, right.projectRelativePath));
	packageChanges.sort((left, right) => compareText(left.depotPath, right.depotPath));
	return { files, kind: "ready", packageChanges };
}
