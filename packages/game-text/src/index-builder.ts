import { Context, type Effect, type Scope } from "effect";
import type { importLocalizationFile, importLocalizationTarget } from "./localization-import.js";
import type { refreshPackageTextLayer } from "./package-text-layer.js";
import type { RefreshJoinedTarget } from "./joined-target.js";
import type { SharedIndex, SharedIndexOptions } from "./shared-index.js";
import type { LocalizationImportSession } from "./localization-import-session.js";
import type { SnapshotFormatError } from "./snapshot-format.js";
import type { SnapshotStoreError } from "./snapshot-store.js";

type IndexFailure = SnapshotFormatError | SnapshotStoreError;

/**
 * Cache identity and optional changed files for one scoped writer lease. An absent changed-file
 * list requests full discovery; hosts must not share a writer outside the enclosing build
 * session.
 */
export interface GameTextIndexBuildSessionRequest {
	readonly configuration: SharedIndexOptions;
	readonly files?: readonly string[];
}

/** Native build capability. The builder supplies one leased index across all input and join operations; queries acquire their own immutable native reader.
 */
export class GameTextIndexBuilder extends Context.Service<
	GameTextIndexBuilder,
	{
		/** The chosen backend owns the lease; a native backend must not reacquire a TS-held lock. */
		readonly withSession: <A, E, R>(
			request: GameTextIndexBuildSessionRequest,
			effect: Effect.Effect<A, E, R>
		) => Effect.Effect<
			A,
			E | IndexFailure,
			Exclude<
				Exclude<Exclude<Exclude<R, SharedIndex>, LocalizationImportSession>, Scope.Scope>,
				SharedIndex
			>
		>;
		readonly importLocalizationFile: typeof importLocalizationFile;
		readonly importLocalizationTarget: typeof importLocalizationTarget;
		readonly refreshPackageTextLayer: typeof refreshPackageTextLayer;
		/** Whether its writer plans a package refresh from a Project Index Catalog generation. */
		readonly plansPackages?: boolean;
		readonly refreshJoinedTarget: RefreshJoinedTarget;
		readonly intern: (
			domain: string,
			values: readonly string[]
		) => Effect.Effect<Uint32Array, IndexFailure, SharedIndex | Scope.Scope>;
		readonly compact: (
			force?: boolean
		) => Effect.Effect<
			{ compacted: boolean; deadBytes: number; totalBytes: number },
			IndexFailure,
			SharedIndex | Scope.Scope
		>;
	}
>()("@ue-shed/game-text/GameTextIndexBuilder") {}
