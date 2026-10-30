import { Context, Effect, Layer, RcMap, Schema, type Scope } from "effect";
import { GameTextIndexConfiguration, type GameTextContract } from "@ue-shed/protocol";
import { TEXT_AUDIENCE_POLICY } from "./text-audience.js";
import {
	answerJson,
	NativeGameTextEngineClient,
	nativeGameTextEngineClientLayer,
	type AssetReaderConfiguration
} from "@ue-shed/unreal-assets";
import { openNativeTextQuery } from "./native-query.js";
import { nativeIndexConfiguration } from "./native-index-configuration.js";
import type { SharedIndexOptions } from "./shared-index.js";
import { GameTextIndexError } from "./index-contract.js";

/** Native snapshot acquisition used by the headless indexing workflow. */
export class GameTextIndexQuery extends Context.Service<
	GameTextIndexQuery,
	{
		readonly open: (input: {
			readonly configuration: SharedIndexOptions;
			readonly generation: string;
			readonly joinedKey: string;
		}) => Effect.Effect<
			Effect.Success<ReturnType<typeof openNativeTextQuery>>,
			GameTextIndexError,
			Scope.Scope
		>;
		/**
		 * A point against its base, and with the base's localization, the gate's findings
		 * (`compare_points`). It reads only the two points and the localization lookup, so it pins
		 * no snapshot and never waits on a refresh.
		 */
		readonly comparePoints?: (input: {
			readonly configuration: SharedIndexOptions;
			readonly request: GameTextContract.ComparePointsRequest;
		}) => Effect.Effect<GameTextContract.PointComparison, GameTextIndexError>;
		/**
		 * Two revisions of one localization file and a page of what changed between them
		 * (`compare_text_files`). The engine reads both files and keeps the comparison, so a later
		 * page reads neither again.
		 */
		readonly compareTextFiles?: (
			request: GameTextContract.CompareTextFilesRequest
		) => Effect.Effect<GameTextContract.TextFileComparison, GameTextIndexError>;
	}
>()("@ue-shed/game-text/GameTextIndexQuery") {}

const compareFailed = (cause: unknown) =>
	new GameTextIndexError({
		code: "index_failed",
		operation: "compare_points",
		nextStep: "reconcile",
		retrySafe: false,
		message: "The native Game Text point comparison could not complete.",
		recovery: "Read both points again, then compare them.",
		cause
	});

const fileCompareFailed = (cause: unknown) =>
	new GameTextIndexError({
		code: "index_failed",
		operation: "compare_text_files",
		nextStep: "reconcile",
		retrySafe: true,
		message: "The localization files could not be compared.",
		recovery: "Check that both revisions are readable localization files, then compare again.",
		cause
	});

/**
 * The host's engine: one process, started by the first read, holds every open snapshot's reader.
 * Each snapshot's reader lives in its callers' scope.
 */
export const nativeIndexQueryLayer = (configuration: AssetReaderConfiguration) =>
	Layer.effect(
		GameTextIndexQuery,
		Effect.gen(function* () {
			const engine = yield* Layer.build(nativeGameTextEngineClientLayer(configuration));
			const Request = Schema.Struct({
				configuration: GameTextIndexConfiguration,
				generation: Schema.String,
				joinedKey: Schema.String,
				audienceRules: Schema.Array(Schema.String)
			});
			// Only live caller pins retain entries. No idle timeout retains unused snapshots.
			const readers: RcMap.RcMap<
				string,
				Effect.Success<ReturnType<typeof openNativeTextQuery>>,
				GameTextIndexError
			> = yield* RcMap.make({
				lookup: (key: string) =>
					Effect.gen(function* () {
						let invalidated = false;
						const input = yield* Schema.decodeUnknownEffect(
							Schema.fromJsonString(Request)
						)(key).pipe(Effect.orDie);
						return yield* openNativeTextQuery({
							...input,
							onFailure: Effect.suspend(() => {
								if (invalidated) return Effect.void;
								invalidated = true;
								return RcMap.invalidate(readers, key);
							})
						}).pipe(Effect.provide(engine));
					})
			});
			const client = Context.get(engine, NativeGameTextEngineClient);
			return GameTextIndexQuery.of({
				comparePoints: Effect.fn("GameTextIndexQuery.comparePoints")(function* (input) {
					const answer = yield* client
						.execute({
							action: "compare_points",
							configuration: nativeIndexConfiguration(input.configuration),
							request: input.request
						})
						.pipe(Effect.mapError(compareFailed));
					const comparison = answerJson<GameTextContract.PointComparison>(answer);
					if (comparison === undefined)
						return yield* Effect.fail(compareFailed("The engine sent no comparison."));
					return comparison;
				}),
				compareTextFiles: Effect.fn("GameTextIndexQuery.compareTextFiles")(
					function* (request) {
						const answer = yield* client
							.execute({ action: "compare_text_files", request })
							.pipe(Effect.mapError(fileCompareFailed));
						const comparison = answerJson<GameTextContract.TextFileComparison>(answer);
						if (comparison === undefined)
							return yield* Effect.fail(
								fileCompareFailed("The engine sent no comparison.")
							);
						yield* Effect.annotateCurrentSpan({
							"textFiles.total": comparison.total,
							"textFiles.kept": comparison.kept
						});
						return comparison;
					}
				),
				open: Effect.fn("GameTextIndexQuery.open")(function* (input) {
					return yield* RcMap.get(
						readers,
						JSON.stringify({
							configuration: nativeIndexConfiguration(input.configuration),
							generation: input.generation,
							joinedKey: input.joinedKey,
							audienceRules: TEXT_AUDIENCE_POLICY.map((rule) => rule.id)
						})
					);
				})
			});
		})
	);
