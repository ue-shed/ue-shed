import { channel } from "node:diagnostics_channel";
import { Context, Effect, Layer, Ref, Semaphore } from "effect";
import {
	type GameTextEngineRequest,
	gameTextEngineContract,
	type GameTextEngineOutcome
} from "@ue-shed/protocol";
import { AssetReaderError, type AssetReaderConfiguration } from "./asset-reader.js";
import {
	invokeProtocolSessionSingleWithEvidence,
	makeProtocolRequest,
	type ProtocolSessionProcessFactory,
	UassetProtocolSession
} from "./protocol-transport.js";

const benchmark = channel("ue-shed.game-text-benchmark");

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
export const nativeGameTextEngineClientLayer = (
	configuration: AssetReaderConfiguration,
	/** Starts each worker process; tests supply scripted workers. */
	processFactory?: ProtocolSessionProcessFactory
) =>
	Layer.effect(
		NativeGameTextEngineClient,
		Effect.gen(function* () {
			const mutex = yield* Semaphore.make(1);
			const session = yield* Effect.acquireRelease(
				Effect.sync(
					() =>
						new UassetProtocolSession(
							{ ...configuration, timeoutMs: configuration.catalogTimeoutMs },
							processFactory
						)
				),
				(session) => Effect.promise(() => session.close())
			);
			const call = Effect.fn("NativeGameTextEngine.call")(function* (
				input: GameTextEngineRequest
			) {
				// Requests are built by typed host code and trusted after the handshake; the engine
				// still bounds what it allocates for each one.
				const request = input;
				const encodeStarted = benchmark.hasSubscribers ? performance.now() : undefined;
				const protocolRequest = makeProtocolRequest(
					{ kind: "game_text_engine", request },
					{
						maximumOutputBytes: 64 * 1024 ** 2,
						timeoutMs: configuration.catalogTimeoutMs
					},
					{ contractMinor: request.action.startsWith("findings_") ? 20 : 15 }
				);
				// The benchmark's client stage; requests are no longer Schema-decoded here.
				if (encodeStarted !== undefined)
					benchmark.publish({
						stage: "tsClientSchema",
						action: request.action,
						ms: performance.now() - encodeStarted
					});
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
						request: protocolRequest,
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
			});
			// The one runtime check between host and engine: each worker process proves it was
			// built against this host's contract before it serves a request. A failed check is not
			// remembered, so a later call retries with a fresh worker.
			const verified = yield* Ref.make<number | undefined>(undefined);
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
			const handshake = Effect.gen(function* () {
				const { contract } = yield* call({ action: "capabilities" });
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
				yield* Ref.set(verified, session.worker);
			});
			return NativeGameTextEngineClient.of({
				execute: Effect.fn("NativeGameTextEngine.execute")(function* (input) {
					const worker = session.worker;
					if (worker === undefined || worker !== (yield* Ref.get(verified)))
						yield* handshake;
					const checked = yield* Ref.get(verified);
					const outcome = yield* call(input);
					// Only a call starts a worker. A different one means the checked worker exited and
					// this call ran on its unchecked replacement; one that exited after replying is fine.
					const now = session.worker;
					if (now !== undefined && now !== checked)
						return yield* Effect.fail(
							contractError(
								"The native Game Text engine restarted before its contract was checked."
							)
						);
					return outcome;
				})
			});
		})
	);
