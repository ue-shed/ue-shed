import { Context, Effect, Layer, Ref } from "effect";
import { type GameTextContract, gameTextEngineContract } from "@ue-shed/protocol";
import { AssetReaderError, type AssetReaderConfiguration } from "./asset-reader.js";
import {
	answerJson,
	type EngineAnswer,
	GameTextEngineSession,
	type GameTextEngineProcessFactory
} from "./game-text-engine-session.js";

export { answerJson, type EngineAnswer } from "./game-text-engine-session.js";

/** Native engine calls share their process scope; reader handles never escape that scope. */
export class NativeGameTextEngineClient extends Context.Service<
	NativeGameTextEngineClient,
	{
		readonly execute: (
			request: GameTextContract.EngineRequest
		) => Effect.Effect<EngineAnswer, AssetReaderError>;
	}
>()("@ue-shed/unreal-assets/NativeGameTextEngineClient") {}

const contractError = (message: string) =>
	new AssetReaderError({
		kind: "contract",
		operation: "game_text_engine",
		nextStep: "reconcile",
		retrySafe: false,
		message,
		recovery:
			"Install the native reader from the same UE Shed build as this host, then reopen the snapshot."
	});

/**
 * Creates one scoped engine session using the host's reader configuration. Calls are
 * interruptible; closing the layer ends the engine and releases every pinned reader. Process
 * failures remain typed failures, so callers reopen the expected snapshot before querying again.
 */
export const nativeGameTextEngineClientLayer = (
	configuration: Pick<AssetReaderConfiguration, "executable" | "protocolObserver">,
	/** Starts each engine process; tests supply scripted ones. */
	processFactory?: GameTextEngineProcessFactory
) =>
	Layer.effect(
		NativeGameTextEngineClient,
		Effect.gen(function* () {
			const session = yield* Effect.acquireRelease(
				Effect.sync(
					() =>
						new GameTextEngineSession(
							configuration.executable,
							processFactory,
							configuration.protocolObserver
						)
				),
				(session) => Effect.promise(() => session.close())
			);
			const call = Effect.fn("NativeGameTextEngine.call")(function* (
				request: GameTextContract.EngineRequest
			) {
				const answer = yield* session.call(request);
				yield* Effect.annotateCurrentSpan({
					"game_text.engine.action": request.action,
					...Object.fromEntries(
						Object.entries(answer.profile.stageSeconds).map(([stage, seconds]) => [
							`game_text.engine.seconds.${stage}`,
							seconds
						])
					)
				});
				return answer;
			});
			// The one runtime check between host and engine: each process proves it was built against
			// this host's contract before it serves a request. A failed check is not remembered, so a
			// later call checks a fresh process.
			const verified = yield* Ref.make<number | undefined>(undefined);
			const handshake = Effect.gen(function* () {
				const contract = answerJson<GameTextContract.ContractIdentity>(
					yield* call({ action: "capabilities" })
				);
				if (contract?.contractHash !== gameTextEngineContract.contractHash)
					return yield* Effect.fail(
						contractError(
							"The native Game Text engine was built against a different contract than this host."
						)
					);
				// A development override may be a separate build of the same contract.
				if (contract.buildId !== gameTextEngineContract.buildId)
					yield* Effect.logWarning(
						"The native Game Text engine is a different build of the same contract",
						{ engine: contract.buildId, host: gameTextEngineContract.buildId }
					);
				yield* Ref.set(verified, session.generation);
			});
			return NativeGameTextEngineClient.of({
				execute: Effect.fn("NativeGameTextEngine.execute")(function* (request) {
					const generation = session.generation;
					if (generation === undefined || generation !== (yield* Ref.get(verified)))
						yield* handshake;
					const checked = yield* Ref.get(verified);
					const answer = yield* call(request);
					// Only a call starts a process. A different one means the checked process exited and
					// this call ran on its unchecked replacement; one that exited after replying is fine.
					const now = session.generation;
					if (now !== undefined && now !== checked)
						return yield* Effect.fail(
							contractError(
								"The native Game Text engine restarted before its contract was checked."
							)
						);
					return answer;
				})
			});
		})
	);
