import { Context, Effect, Layer, Schema, Semaphore } from "effect";
import { GameTextEngineRequest, type GameTextEngineOutcome } from "@ue-shed/protocol";
import { AssetReaderError, type AssetReaderConfiguration } from "./asset-reader.js";
import {
	invokeProtocolSessionSingleWithEvidence,
	makeProtocolRequest,
	UassetProtocolSession
} from "./protocol-transport.js";

/** Native engine calls share their process scope; reader handles never escape that scope. */
export class NativeGameTextEngineClient extends Context.Service<
	NativeGameTextEngineClient,
	{
		readonly execute: (
			request: GameTextEngineRequest
		) => Effect.Effect<GameTextEngineOutcome, AssetReaderError>;
	}
>()("@ue-shed/unreal-assets/NativeGameTextEngineClient") {}

/**
 * Creates one scoped native query process using the host's reader configuration. Calls are
 * serialized and interruptible; closing the layer releases every pinned native reader. Process
 * failures remain typed failures, so callers reopen the expected snapshot before querying again.
 */
export const nativeGameTextEngineClientLayer = (configuration: AssetReaderConfiguration) =>
	Layer.effect(
		NativeGameTextEngineClient,
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
			return NativeGameTextEngineClient.of({
				execute: Effect.fn("NativeGameTextEngine.execute")(function* (input) {
					const request = yield* Schema.decodeUnknownEffect(GameTextEngineRequest, {
						onExcessProperty: "error"
					})(input).pipe(
						Effect.mapError(
							(cause) =>
								new AssetReaderError({
									kind: "contract",
									operation: "game_text_engine",
									nextStep: "fix_input",
									recovery:
										"Validate the native Game Text engine request before submitting it.",
									message:
										"The native Game Text engine request does not match its contract.",
									cause,
									retrySafe: false
								})
						)
					);
					const evidence = yield* mutex.withPermits(1)(
						invokeProtocolSessionSingleWithEvidence({
							session,
							configuration: {
								...configuration,
								timeoutMs: configuration.catalogTimeoutMs
							},
							operation: "game_text_engine",
							path:
								request.action === "open"
									? request.configuration.projectKey
									: request.action === "capabilities"
										? "capabilities"
										: request.reader,
							request: makeProtocolRequest(
								{ kind: "game_text_engine", request },
								{
									maximumOutputBytes: 64 * 1024 ** 2,
									timeoutMs: configuration.catalogTimeoutMs
								},
								{ contractMinor: 15 }
							),
							expected: "game_text_engine",
							select: (result) =>
								result.kind === "game_text_engine" ? result.outcome : undefined
						})
					);
					if (evidence.value.action !== request.action)
						return yield* Effect.fail(
							new AssetReaderError({
								kind: "contract",
								operation: "game_text_engine",
								nextStep: "reconcile",
								retrySafe: false,
								message:
									"The native Game Text response belongs to a different operation.",
								recovery:
									"Close this snapshot and install matching host and native reader versions before reopening it."
							})
						);
					yield* Effect.annotateCurrentSpan({
						"game_text.engine.action": request.action,
						...Object.fromEntries(
							Object.entries(evidence.value.stageSeconds).map(([stage, seconds]) => [
								`game_text.engine.seconds.${stage}`,
								seconds
							])
						)
					});
					return evidence.value;
				})
			});
		})
	);
