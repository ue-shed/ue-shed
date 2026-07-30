// @vitest-environment jsdom

import { cleanup, render } from "@solidjs/testing-library";
import { Deferred, Effect, Layer, ManagedRuntime, Ref, Stream } from "effect";
import { afterEach, describe, expect, it } from "vitest";
import { createSignal, onMount } from "solid-js";
import {
	EffectRuntimeProvider,
	createEffectAction,
	createEffectSubscription
} from "./effect-solid.js";

afterEach(cleanup);

function TestAction(props: {
	readonly first: Effect.Effect<string>;
	readonly second?: Effect.Effect<string>;
	readonly onValue: (value: string) => void;
}) {
	const action = createEffectAction();
	onMount(() => {
		action.run(props.first, { onSuccess: props.onValue });
		if (props.second !== undefined) {
			action.run(props.second, { onSuccess: props.onValue });
		}
	});
	return <span>runner</span>;
}

function TestSubscription(props: { readonly stream: Stream.Stream<string> }) {
	const subscription = createEffectSubscription();
	onMount(() => subscription.subscribe(props.stream, { onValue: () => undefined }));
	return <span>subscriber</span>;
}

function TestIndependentActions(props: {
	readonly first: Effect.Effect<string>;
	readonly second: Effect.Effect<string>;
	readonly onValue: (value: string) => void;
}) {
	const firstAction = createEffectAction();
	const secondAction = createEffectAction();
	onMount(() => {
		firstAction.run(props.first, { onSuccess: props.onValue });
		secondAction.run(props.second, { onSuccess: props.onValue });
	});
	return <span>independent runners</span>;
}

describe("Effect-to-Solid lifetime adapter", () => {
	it("interrupts owner work on cleanup", async () => {
		const runtime = ManagedRuntime.make(Layer.empty);
		const interrupted = await Effect.runPromise(Deferred.make<void>());
		const view = render(() => (
			<EffectRuntimeProvider runtime={runtime}>
				<TestAction
					first={Effect.never.pipe(
						Effect.onInterrupt(() => Deferred.succeed(interrupted, undefined))
					)}
					onValue={() => undefined}
				/>
			</EffectRuntimeProvider>
		));
		view.unmount();
		await runtime.runPromise(Deferred.await(interrupted));
		await runtime.dispose();
	});

	it("prevents a superseded completion from overwriting the latest value", async () => {
		const runtime = ManagedRuntime.make(Layer.empty);
		const releaseFirst = await Effect.runPromise(Deferred.make<void>());
		const observed = await Effect.runPromise(Ref.make<ReadonlyArray<string>>([]));
		const [latest, setLatest] = createSignal<string>();
		const first = Deferred.await(releaseFirst).pipe(Effect.as("first"), Effect.uninterruptible);
		const view = render(() => (
			<EffectRuntimeProvider runtime={runtime}>
				<TestAction
					first={first}
					second={Effect.succeed("second")}
					onValue={(value) => {
						setLatest(value);
						Effect.runSync(Ref.update(observed, (values) => [...values, value]));
					}}
				/>
			</EffectRuntimeProvider>
		));
		await runtime.runPromise(Deferred.succeed(releaseFirst, undefined));
		await runtime.runPromise(Effect.yieldNow);
		expect(latest()).toBe("second");
		expect(await Effect.runPromise(Ref.get(observed))).toEqual(["second"]);
		view.unmount();
		await runtime.dispose();
	});

	it("keeps independent actions alive when another action starts", async () => {
		const runtime = ManagedRuntime.make(Layer.empty);
		const releaseFirst = await Effect.runPromise(Deferred.make<void>());
		const observed = await Effect.runPromise(Ref.make<ReadonlyArray<string>>([]));
		const first = Deferred.await(releaseFirst).pipe(
			Effect.as("choice"),
			Effect.uninterruptible
		);
		const view = render(() => (
			<EffectRuntimeProvider runtime={runtime}>
				<TestIndependentActions
					first={first}
					second={Effect.succeed("refresh")}
					onValue={(value) => {
						Effect.runSync(Ref.update(observed, (values) => [...values, value]));
					}}
				/>
			</EffectRuntimeProvider>
		));
		await runtime.runPromise(Deferred.succeed(releaseFirst, undefined));
		await runtime.runPromise(Effect.yieldNow);
		expect(await Effect.runPromise(Ref.get(observed))).toEqual(["refresh", "choice"]);
		view.unmount();
		await runtime.dispose();
	});

	it("owns exactly one subscription and finalizes it on cleanup", async () => {
		const runtime = ManagedRuntime.make(Layer.empty);
		const starts = await Effect.runPromise(Ref.make(0));
		const started = await Effect.runPromise(Deferred.make<void>());
		const released = await Effect.runPromise(Deferred.make<void>());
		const stream = Stream.never.pipe(
			Stream.onStart(
				Ref.update(starts, (count) => count + 1).pipe(
					Effect.andThen(Deferred.succeed(started, undefined))
				)
			),
			Stream.ensuring(Deferred.succeed(released, undefined))
		);
		const view = render(() => (
			<EffectRuntimeProvider runtime={runtime}>
				<TestSubscription stream={stream} />
			</EffectRuntimeProvider>
		));
		await runtime.runPromise(Deferred.await(started));
		expect(await Effect.runPromise(Ref.get(starts))).toBe(1);
		view.unmount();
		await runtime.runPromise(Deferred.await(released));
		await runtime.dispose();
	});
});
