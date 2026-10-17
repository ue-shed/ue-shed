import { Context, Effect, Layer, Option, Ref } from "effect";

/** Captured only for one operation and its children; changing selection affects subsequent work. */
class OperationEndpoint extends Context.Service<
	OperationEndpoint,
	ReadonlyMap<Ref.Ref<string>, string>
>()("@ue-shed/unreal-connection/OperationEndpoint") {}

/**
 * The Remote Control endpoint UE Shed talks to. `withCurrent` pins the endpoint selected when an
 * operation starts for that operation and its children, so changing the selection mid-way only
 * affects later work.
 */
export interface SelectedUnrealTargetApi {
	readonly endpoint: () => Effect.Effect<string>;
	readonly select: (endpoint: string) => Effect.Effect<void>;
	readonly withCurrent: <A, E, R>(operation: Effect.Effect<A, E, R>) => Effect.Effect<A, E, R>;
}

/** The host-owned selection of which Unreal process to talk to. */
export class SelectedUnrealTarget extends Context.Service<
	SelectedUnrealTarget,
	SelectedUnrealTargetApi
>()("@ue-shed/unreal-connection/SelectedUnrealTarget") {}

/** Hosts supply a validated endpoint and own the selection UI or configuration. */
export const makeSelectedUnrealTarget = Effect.fn("SelectedUnrealTarget.make")(function* (
	initialEndpoint: string
) {
	const selected = yield* Ref.make(initialEndpoint);
	const endpoint = Effect.fn("SelectedUnrealTarget.endpoint")(function* () {
		const captured = yield* Effect.serviceOption(OperationEndpoint);
		return (
			(Option.isSome(captured) ? captured.value.get(selected) : undefined) ??
			(yield* Ref.get(selected))
		);
	});
	return SelectedUnrealTarget.of({
		endpoint,
		select: Effect.fn("SelectedUnrealTarget.select")((value) => Ref.set(selected, value)),
		withCurrent: (operation) =>
			Effect.gen(function* () {
				const captured = yield* Effect.serviceOption(OperationEndpoint);
				const endpoints = new Map(Option.isSome(captured) ? captured.value : undefined);
				endpoints.set(selected, yield* endpoint());
				return yield* operation.pipe(Effect.provideService(OperationEndpoint, endpoints));
			})
	});
});

/**
 * Provides `SelectedUnrealTarget` starting at `initialEndpoint`. The host validates endpoints and
 * owns the UI or configuration that changes them; this layer never chooses one itself.
 */
export const selectedUnrealTargetLayer = (initialEndpoint: string) =>
	Layer.effect(SelectedUnrealTarget, makeSelectedUnrealTarget(initialEndpoint));
