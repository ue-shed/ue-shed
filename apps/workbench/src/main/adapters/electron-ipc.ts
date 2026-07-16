import { Context, Effect, Layer, Ref, Schema, type Scope } from "effect";
import { decodeInvokeArgs, decodeInvokeResult, type InvokeContract } from "../ipc-contracts.js";

export class ElectronIpcError extends Schema.TaggedErrorClass<ElectronIpcError>()(
	"Workbench.ElectronIpcError",
	{
		causeText: Schema.String,
		channel: Schema.String,
		message: Schema.String,
		operation: Schema.Literals(["register", "duplicate", "decodeArgs", "decodeResult"]),
		recovery: Schema.String,
		retrySafe: Schema.Boolean
	}
) {}

export interface ElectronIpcHost {
	readonly handle: (
		channel: string,
		listener: (event: unknown, ...args: Array<unknown>) => Promise<unknown>
	) => void;
	readonly removeHandler: (channel: string) => void;
}

export interface ElectronIpcShape {
	readonly register: (
		contract: InvokeContract,
		handler: (...args: ReadonlyArray<unknown>) => Effect.Effect<unknown>
	) => Effect.Effect<void, ElectronIpcError, Scope.Scope>;
}

export class ElectronIpc extends Context.Service<ElectronIpc, ElectronIpcShape>()(
	"@ue-shed/workbench/ElectronIpc"
) {}

export interface RegisteredHandler {
	readonly channel: string;
	readonly invoke: (...args: ReadonlyArray<unknown>) => Promise<unknown>;
}

export interface ElectronIpcTestShape extends ElectronIpcShape {
	readonly handlers: () => Effect.Effect<ReadonlyArray<RegisteredHandler>>;
	readonly invoke: (
		channel: string,
		...args: ReadonlyArray<unknown>
	) => Effect.Effect<unknown, unknown>;
}

export class ElectronIpcTest extends Context.Service<ElectronIpcTest, ElectronIpcTestShape>()(
	"@ue-shed/workbench/ElectronIpc/Test"
) {}

function ipcError(
	operation: ElectronIpcError["operation"],
	channel: string,
	cause: unknown,
	recovery: string
): ElectronIpcError {
	return new ElectronIpcError({
		causeText: cause instanceof Error ? cause.message : String(cause),
		channel,
		message: `Electron IPC ${operation} failed for ${channel}.`,
		operation,
		recovery,
		retrySafe: false
	});
}

const adaptHandler = (
	contract: InvokeContract,
	handler: (...args: ReadonlyArray<unknown>) => Effect.Effect<unknown>,
	runPromise: <A, E>(effect: Effect.Effect<A, E>) => Promise<A>
): ((...args: ReadonlyArray<unknown>) => Promise<unknown>) => {
	return (...args: ReadonlyArray<unknown>) => {
		const program = Effect.gen(function* () {
			const decodedArgs = (yield* decodeInvokeArgs(contract)(args).pipe(
				Effect.mapError((cause) =>
					ipcError(
						"decodeArgs",
						contract.channel,
						cause,
						"Pass arguments that match the Workbench IPC contract."
					)
				)
			)) as ReadonlyArray<unknown>;
			const result = yield* handler(...decodedArgs);
			return yield* decodeInvokeResult(contract)(result).pipe(
				Effect.mapError((cause) =>
					ipcError(
						"decodeResult",
						contract.channel,
						cause,
						"Return a schema-owned IPC result from the handler."
					)
				)
			);
		});
		return runPromise(program as Effect.Effect<unknown, ElectronIpcError>);
	};
};

export const electronIpcLayer = (ipc: ElectronIpcHost): Layer.Layer<ElectronIpc> =>
	Layer.effect(
		ElectronIpc,
		Effect.gen(function* () {
			const registered = yield* Ref.make<ReadonlySet<string>>(new Set());
			const context = yield* Effect.context();
			const { runPromiseWith } = Effect;
			const runPromise = runPromiseWith(context);

			yield* Effect.addFinalizer(() =>
				Ref.get(registered).pipe(
					Effect.flatMap((channels) =>
						Effect.sync(() => {
							for (const channel of channels) {
								ipc.removeHandler(channel);
							}
						})
					)
				)
			);

			return ElectronIpc.of({
				register: Effect.fn("Workbench.ElectronIpc.register")(
					function* (contract, handler) {
						const channels = yield* Ref.get(registered);
						if (channels.has(contract.channel)) {
							return yield* Effect.fail(
								ipcError(
									"duplicate",
									contract.channel,
									"Channel already registered",
									"Register each IPC channel exactly once per runtime."
								)
							);
						}

						const adapted = adaptHandler(contract, handler, runPromise);
						yield* Effect.try({
							try: () => {
								ipc.handle(contract.channel, (_event, ...args) => adapted(...args));
							},
							catch: (cause) =>
								ipcError(
									"register",
									contract.channel,
									cause,
									"Restart Workbench and verify Electron IPC is available."
								)
						});
						yield* Ref.update(
							registered,
							(current) => new Set([...current, contract.channel])
						);
						yield* Effect.addFinalizer(() =>
							Effect.sync(() => {
								ipc.removeHandler(contract.channel);
							})
						);
					}
				)
			});
		})
	);

export const makeElectronIpcTestLayer = (): Layer.Layer<ElectronIpc | ElectronIpcTest> =>
	Layer.effectContext(
		Effect.gen(function* () {
			const handlers = yield* Ref.make<ReadonlyArray<RegisteredHandler>>([]);
			const context = yield* Effect.context();
			const { runPromiseWith } = Effect;
			const runPromise = runPromiseWith(context);

			const register = Effect.fn("Workbench.ElectronIpc.Test.register")(
				function* (contract, handler) {
					const current = yield* Ref.get(handlers);
					if (current.some((entry) => entry.channel === contract.channel)) {
						return yield* Effect.fail(
							ipcError(
								"duplicate",
								contract.channel,
								"Channel already registered",
								"Register each IPC channel exactly once per runtime."
							)
						);
					}
					const adapted = adaptHandler(contract, handler, runPromise);
					yield* Ref.update(handlers, (entries) => [
						...entries,
						{ channel: contract.channel, invoke: adapted }
					]);
					yield* Effect.addFinalizer(() =>
						Ref.update(handlers, (entries) =>
							entries.filter((entry) => entry.channel !== contract.channel)
						)
					);
				}
			);

			const service = ElectronIpcTest.of({
				register,
				handlers: () => Ref.get(handlers),
				invoke: Effect.fn("Workbench.ElectronIpc.Test.invoke")(function* (
					channel,
					...args
				) {
					const entry = (yield* Ref.get(handlers)).find(
						(candidate) => candidate.channel === channel
					);
					if (!entry) {
						return yield* Effect.fail(
							new Error(`Channel ${channel} is not registered`)
						);
					}
					return yield* Effect.tryPromise({
						try: () => entry.invoke(...args),
						catch: (cause) => cause
					});
				})
			});

			return Context.empty().pipe(
				Context.add(ElectronIpc, service),
				Context.add(ElectronIpcTest, service)
			);
		})
	);
