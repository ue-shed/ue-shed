import { Context, Effect, Layer, Semaphore } from "effect";
import { GameTextIndexBuildRequest, type GameTextIndexBuildOutcome } from "@ue-shed/protocol";
import { Schema } from "effect";
import { AssetReaderError, type AssetReaderConfiguration } from "./asset-reader.js";
import {
	invokeProtocolSessionSingleWithEvidence,
	makeProtocolRequest,
	UassetProtocolSession
} from "./protocol-transport.js";

/** Validated native outcome plus the stable incremental eligibility reason from diagnostic frames. */
export type NativeGameTextIndexOutcome = GameTextIndexBuildOutcome & {
	readonly incrementalFallback?: string;
};

/** Uses the existing scoped process transport, including framing, cancellation and telemetry. */
export class NativeGameTextIndexClient extends Context.Service<
	NativeGameTextIndexClient,
	{
		readonly execute: (
			request: GameTextIndexBuildRequest
		) => Effect.Effect<NativeGameTextIndexOutcome, AssetReaderError>;
	}
>()("@ue-shed/unreal-assets/NativeGameTextIndexClient") {}

/**
 * Creates a scoped serialized native Game Text index client from the host reader
 * configuration. Negotiated commands use the catalog timeout; failures close the owned
 * session and do not silently invoke the TypeScript builder.
 */
export const nativeGameTextIndexClientLayer = (configuration: AssetReaderConfiguration) =>
	Layer.effect(
		NativeGameTextIndexClient,
		Effect.gen(function* () {
			const mutex = yield* Semaphore.make(1);
			const session = yield* Effect.acquireRelease(
				Effect.sync(
					() =>
						new UassetProtocolSession({
							...configuration,
							timeoutMs: configuration.catalogTimeoutMs
						})
				),
				(session) => Effect.promise(() => session.close())
			);
			return NativeGameTextIndexClient.of({
				execute: Effect.fn("NativeGameTextIndex.execute")(function* (input) {
					const decoded = yield* Schema.decodeUnknownEffect(GameTextIndexBuildRequest)(
						input
					).pipe(
						Effect.mapError(
							(cause) =>
								new AssetReaderError({
									kind: "contract",
									operation: "game_text_index",
									nextStep: "fix_input",
									recovery:
										"Validate the native Game Text index request before submitting it.",
									message:
										"The native Game Text index request does not match its contract.",
									cause,
									retrySafe: false
								})
						)
					);
					const request = decoded;
					const evidence = yield* mutex.withPermits(1)(
						invokeProtocolSessionSingleWithEvidence({
							session,
							configuration: {
								...configuration,
								timeoutMs: configuration.catalogTimeoutMs
							},
							operation: "game_text_index",
							path:
								request.action === "capabilities"
									? "capabilities"
									: request.configuration.projectKey,
							request: makeProtocolRequest(
								{ kind: "game_text_index", request },
								{
									maximumOutputBytes: 64 * 1024 ** 2,
									timeoutMs: configuration.catalogTimeoutMs
								},
								{ contractMinor: 13 }
							),
							expected: "game_text_index",
							select: (result) =>
								result.kind === "game_text_index" ? result.outcome : undefined
						})
					);
					const outcome = evidence.value;
					let incrementalFallback: string | undefined;
					for (const diagnostic of evidence.diagnostics) {
						const prefix = "game_text_index_join_fallback.";
						if (!diagnostic.code.startsWith(prefix)) continue;
						const reason = diagnostic.code.slice(prefix.length);
						incrementalFallback = reason;
						yield* Effect.annotateCurrentSpan({
							"game_text.build.join_fallback": reason
						});
						if (reason !== "no-base" && reason !== "forced")
							yield* Effect.logDebug(
								"Native Game Text join requires a full rebuild",
								{
									code: diagnostic.code,
									reason
								}
							);
					}
					yield* Effect.annotateCurrentSpan({
						"game_text.build.action": request.action,
						...Object.fromEntries(
							Object.entries(outcome.stageSeconds).map(([stage, seconds]) => [
								`game_text.build.seconds.${stage}`,
								seconds
							])
						)
					});
					return incrementalFallback === undefined
						? outcome
						: { ...outcome, incrementalFallback };
				})
			});
		})
	);
