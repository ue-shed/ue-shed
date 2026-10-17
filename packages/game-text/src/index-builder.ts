import { Context, Effect, Layer, type Scope } from "effect";
import { importLocalizationFile, importLocalizationTarget } from "./localization-import.js";
import { refreshPackageTextLayer } from "./package-text-layer.js";
import { refreshJoinedTarget } from "./joined-target.js";
import { SharedIndex, sharedIndexNodeLayer, type SharedIndexOptions } from "./shared-index.js";
import { LocalizationImportSession } from "./localization-import-session.js";
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

const typeScriptIndexBuildSession = <A, E, R>(
	request: GameTextIndexBuildSessionRequest,
	effect: Effect.Effect<A, E, R>
) =>
	Effect.scoped(
		Effect.gen(function* () {
			const index = yield* SharedIndex;
			const writer = yield* index.writer();
			const leasedIndex = SharedIndex.of({
				...index,
				inspect: () => Effect.succeed(writer.manifest()),
				writer: () => Effect.succeed(writer)
			});
			const session = LocalizationImportSession.of({
				configuration: request.configuration,
				index: leasedIndex,
				...(request.files === undefined || !writer.manifest().active.joined
					? undefined
					: { files: request.files })
			});
			return yield* effect.pipe(
				Effect.provideService(SharedIndex, leasedIndex),
				Effect.provideService(LocalizationImportSession, session)
			);
		})
	).pipe(Effect.provide(sharedIndexNodeLayer(request.configuration)));

/** Build capability selected by the host. Queries consume the published format independently.
 * Methods retain the TypeScript builder's inputs, results, failures and scoped index requirements.
 * The selected backend supplies one leased SharedIndex across all methods in a refresh.
 */
export class GameTextIndexBuilder extends Context.Service<
	GameTextIndexBuilder,
	{
		/** The chosen backend owns the lease; a native backend must not reacquire a TS-held lock. */
		readonly withSession: typeof typeScriptIndexBuildSession;
		readonly importLocalizationFile: typeof importLocalizationFile;
		readonly importLocalizationTarget: typeof importLocalizationTarget;
		readonly refreshPackageTextLayer: typeof refreshPackageTextLayer;
		readonly refreshJoinedTarget: typeof refreshJoinedTarget;
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

/** Explicit TypeScript reference implementation for hosts and parity checks; never selected silently after a native failure. */
export const typeScriptIndexBuilderLayer = Layer.effect(
	GameTextIndexBuilder,
	Effect.sync(() =>
		GameTextIndexBuilder.of({
			withSession: typeScriptIndexBuildSession,
			importLocalizationFile,
			importLocalizationTarget,
			refreshPackageTextLayer,
			refreshJoinedTarget,
			intern: Effect.fn("GameTextIndexBuilder.intern")(function* (domain, values) {
				const index = yield* SharedIndex;
				return yield* (yield* index.writer()).intern(domain, values);
			}),
			compact: Effect.fn("GameTextIndexBuilder.compact")(function* (force) {
				const index = yield* SharedIndex;
				return yield* (yield* index.writer()).compact(force);
			})
		})
	)
);
