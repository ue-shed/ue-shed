import { Cause, Effect, Exit, Fiber, type ManagedRuntime, Stream } from "effect";
import { createContext, onCleanup, useContext, type ParentProps } from "solid-js";
import { type JSX } from "@solidjs/web";

export type SolidEffectRuntime = ManagedRuntime.ManagedRuntime<never, never>;

const RuntimeContext = createContext<SolidEffectRuntime>();

export function EffectRuntimeProvider(
	props: ParentProps<{ readonly runtime: SolidEffectRuntime }>
): JSX.Element {
	return <RuntimeContext value={props.runtime}>{props.children}</RuntimeContext>;
}

function useRuntime(): SolidEffectRuntime {
	const runtime = useContext(RuntimeContext);
	if (runtime === undefined) {
		throw new Error("EffectRuntimeProvider is required above Effect-backed Solid components");
	}
	return runtime;
}

export interface EffectActionHandlers<A, E> {
	readonly onFailure?: (cause: Cause.Cause<E>) => void;
	readonly onSuccess: (value: A) => void;
}

export interface EffectAction {
	readonly cancel: () => void;
	readonly run: <A, E>(effect: Effect.Effect<A, E>, handlers: EffectActionHandlers<A, E>) => void;
}

/**
 * Runs owner-scoped UI work with latest-request-wins semantics.
 *
 * The generation check is intentional even though the previous fiber is interrupted: an
 * uninterruptible foreign boundary may still finish after its replacement.
 */
export function createEffectAction(): EffectAction {
	const runtime = useRuntime();
	let active: Fiber.Fiber<unknown, unknown> | undefined;
	let generation = 0;

	const cancel = () => {
		generation += 1;
		if (active !== undefined) {
			runtime.runFork(Fiber.interrupt(active));
			active = undefined;
		}
	};

	const run = <A, E>(effect: Effect.Effect<A, E>, handlers: EffectActionHandlers<A, E>): void => {
		cancel();
		const currentGeneration = generation;
		const observed = effect.pipe(
			Effect.onExit((exit) =>
				Effect.sync(() => {
					if (generation !== currentGeneration) return;
					active = undefined;
					if (Exit.isSuccess(exit)) handlers.onSuccess(exit.value);
					else if (!Cause.hasInterruptsOnly(exit.cause)) handlers.onFailure?.(exit.cause);
				})
			)
		);
		active = runtime.runFork(observed);
	};

	onCleanup(cancel);
	return { cancel, run };
}

export interface EffectSubscriptionHandlers<A, E> {
	readonly onFailure?: (cause: Cause.Cause<E>) => void;
	readonly onValue: (value: A) => void;
}

export interface EffectSubscription {
	readonly cancel: () => void;
	readonly subscribe: <A, E>(
		stream: Stream.Stream<A, E>,
		handlers: EffectSubscriptionHandlers<A, E>
	) => void;
}

export function createEffectSubscription(): EffectSubscription {
	const action = createEffectAction();
	return {
		cancel: action.cancel,
		subscribe: (stream, handlers) => {
			const effect = stream.pipe(
				Stream.runForEach((value) => Effect.sync(() => handlers.onValue(value)))
			);
			if (handlers.onFailure === undefined) {
				action.run(effect, { onSuccess: () => undefined });
			} else {
				action.run(effect, {
					onFailure: handlers.onFailure,
					onSuccess: () => undefined
				});
			}
		}
	};
}
