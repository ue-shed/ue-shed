import { Context, Effect, Fiber, Layer, Ref, Schema, type Scope } from "effect";
import { decodeInvokeArgs, encodeInvokeResult, type InvokeContract } from "../ipc-contracts.js";

export class ElectronIpcError extends Schema.TaggedErrorClass<ElectronIpcError>()(
	"Workbench.ElectronIpcError",
	{
		causeText: Schema.String,
		channel: Schema.String,
		message: Schema.String,
		operation: Schema.Literals(["register", "duplicate", "decodeArgs", "encodeResult"]),
		recovery: Schema.String,
		retrySafe: Schema.Boolean
	}
) {}

export interface ElectronIpcEvent {}

type InvokeHandlerArguments<Contract extends InvokeContract> =
	Contract["args"]["Type"] extends ReadonlyArray<infer _Argument>
		? Contract["args"]["Type"]
		: never;

export interface ElectronIpcHost {
	readonly handle: <Result>(
		channel: string,
		listener: (event: ElectronIpcEvent, ...args: Array<unknown>) => Promise<Result>
	) => void;
	readonly removeHandler: (channel: string) => void;
}

export interface ElectronIpcApi {
	readonly register: <Contract extends InvokeContract, HandlerError, Requirements>(
		contract: Contract,
		handler: (
			...args: InvokeHandlerArguments<Contract>
		) => Effect.Effect<Contract["result"]["Type"], HandlerError, Requirements>
	) => Effect.Effect<void, ElectronIpcError, Scope.Scope>;
}

export class ElectronIpc extends Context.Service<ElectronIpc, ElectronIpcApi>()(
	"@ue-shed/workbench/ElectronIpc"
) {}

export interface RegisteredHandler<Result = unknown> {
	readonly channel: string;
	readonly invoke: (...args: ReadonlyArray<unknown>) => Promise<Result>;
}

export interface ElectronIpcTestApi extends ElectronIpcApi {
	readonly handlers: () => Effect.Effect<ReadonlyArray<RegisteredHandler>>;
	readonly invoke: (
		channel: string,
		...args: ReadonlyArray<unknown>
	) => Effect.Effect<unknown, unknown>;
}

export class ElectronIpcTest extends Context.Service<ElectronIpcTest, ElectronIpcTestApi>()(
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

const adaptHandler = <Contract extends InvokeContract, HandlerError, Requirements>(
	contract: Contract,
	handler: (
		...args: InvokeHandlerArguments<Contract>
	) => Effect.Effect<Contract["result"]["Type"], HandlerError, Requirements>,
	runPromise: <A, E>(effect: Effect.Effect<A, E>) => Promise<A>
): ((...args: ReadonlyArray<unknown>) => Promise<Contract["result"]["Encoded"]>) => {
	return (...args: ReadonlyArray<unknown>) => {
		const program = Effect.gen(function* () {
			const decoded = yield* decodeInvokeArgs(contract)(args).pipe(
				Effect.mapError((cause) =>
					ipcError(
						"decodeArgs",
						contract.channel,
						cause,
						"Pass arguments that match the Workbench IPC contract."
					)
				)
			);
			// SAFETY: every InvokeContract is constructed with a tuple args schema; successful
			// decoding therefore yields the exact argument tuple owned by this contract.
			const decodedArgs = decoded as InvokeHandlerArguments<Contract>;
			const result = yield* handler(...decodedArgs);
			return yield* encodeInvokeResult(contract)(result).pipe(
				Effect.mapError((cause) =>
					ipcError(
						"encodeResult",
						contract.channel,
						cause,
						"Return a schema-owned IPC result from the handler."
					)
				)
			);
		});
		// SAFETY: the Electron layer captures the complete Workbench runtime Context before
		// registration, so all handler requirements are supplied when this program is executed.
		return runPromise(
			program as Effect.Effect<Contract["result"]["Encoded"], ElectronIpcError | HandlerError>
		);
	};
};

export const electronIpcLayer = (ipc: ElectronIpcHost): Layer.Layer<ElectronIpc> =>
	Layer.effect(
		ElectronIpc,
		Effect.gen(function* () {
			const registered = yield* Ref.make<ReadonlySet<string>>(new Set());
			const context = yield* Effect.context();
			const scope = yield* Effect.scope;
			const { runPromiseWith } = Effect;
			const runPromise = <A, E>(effect: Effect.Effect<A, E>) =>
				runPromiseWith(context)(effect, { onFiberStart: Fiber.runIn(scope) });

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
			const scope = yield* Effect.scope;
			const { runPromiseWith } = Effect;
			const runPromise = <A, E>(effect: Effect.Effect<A, E>) =>
				runPromiseWith(context)(effect, { onFiberStart: Fiber.runIn(scope) });

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
