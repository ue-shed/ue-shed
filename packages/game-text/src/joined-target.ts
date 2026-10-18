import type { LocalizationTarget, LocalizationReviewFile } from "@ue-shed/localization";
import type { Effect, Schema, Scope } from "effect";
import type { SharedIndex } from "./shared-index.js";
import type { SnapshotFormatError } from "./snapshot-format.js";
import type { SnapshotStoreError } from "./snapshot-store.js";

export interface JoinedTargetInput {
	readonly projectRoot: string;
	readonly target: LocalizationTarget;
	readonly review?: LocalizationReviewFile;
	readonly keyChangePairs?: readonly import("./localization-key-changes.js").LocalizationKeyChangePair[];
	/** Failed file paths and their typed localization error codes, supplied by the importer. */
	readonly fileErrors?: Readonly<Record<string, string>>;
	readonly fileProvenances?: Readonly<
		Record<string, import("@ue-shed/localization").FileProvenance>
	>;
	readonly fileDiagnostics?: Readonly<
		Record<string, import("@ue-shed/localization").LocalizationError>
	>;
	readonly force?: boolean;
}

/** Immutable native publication metadata; an unchanged view has no newly computed counts. */
export interface JoinedTargetOutcome {
	readonly rebuilt: boolean;
	readonly strategy?: "full" | "incremental";
	readonly incrementalFallback?: string | undefined;
	readonly affectedLines?: number;
	readonly key: string;
	readonly bytes: number;
	readonly count: number | null;
	readonly keyChanges: number | null;
}
export type RefreshJoinedTarget = (
	input: JoinedTargetInput
) => Effect.Effect<
	JoinedTargetOutcome,
	Schema.SchemaError | SnapshotFormatError | SnapshotStoreError,
	SharedIndex | Scope.Scope
>;
