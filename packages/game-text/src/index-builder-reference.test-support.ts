import { Effect, Layer } from "effect";
import { importLocalizationFile, importLocalizationTarget } from "./localization-import.js";
import { refreshPackageTextLayer } from "./package-text-layer.js";
import { refreshJoinedTarget } from "./joined-target-reference.test-support.js";
import { SharedIndex, sharedIndexNodeLayer } from "./shared-index.js";
import { LocalizationImportSession } from "./localization-import-session.js";
import { GameTextIndexBuilder, type GameTextIndexBuildSessionRequest } from "./index-builder.js";
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
