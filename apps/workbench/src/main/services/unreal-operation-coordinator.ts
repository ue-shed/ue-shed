import { Effect, Option, Ref, Semaphore } from "effect";

export interface UnrealOperationCoordinator {
	/** User-requested operations queue and take precedence over subsequent polling. */
	readonly exclusive: <A, E, R>(effect: Effect.Effect<A, E, R>) => Effect.Effect<A, E, R>;
	/** Polling never queues: callers receive None while another operation owns or awaits the gate. */
	readonly poll: <A, E, R>(
		effect: Effect.Effect<A, E, R>
	) => Effect.Effect<Option.Option<A>, E, R>;
}

export const makeUnrealOperationCoordinator: Effect.Effect<UnrealOperationCoordinator> = Effect.gen(
	function* () {
		const gate = yield* Semaphore.make(1);
		const pendingExclusive = yield* Ref.make(0);

		return {
			exclusive: <A, E, R>(effect: Effect.Effect<A, E, R>) =>
				Ref.update(pendingExclusive, (count) => count + 1).pipe(
					Effect.andThen(gate.withPermit(effect)),
					Effect.ensuring(Ref.update(pendingExclusive, (count) => count - 1))
				),
			poll: <A, E, R>(effect: Effect.Effect<A, E, R>) =>
				Ref.get(pendingExclusive).pipe(
					Effect.flatMap((pending) =>
						pending > 0
							? Effect.succeed(Option.none<A>())
							: gate.withPermitsIfAvailable(1)(effect)
					)
				)
		};
	}
);
