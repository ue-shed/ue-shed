import { Effect } from "effect";

/** Presentation selects positions; its caller supplies synchronous or asynchronous hydration. */
export type QualityRead<A, Item> = Generator<readonly number[], A, readonly Item[]>;

export function materializeQualityRead<A, Item>(
	read: QualityRead<A, Item>,
	items: (positions: readonly number[]) => readonly Item[]
): A {
	let next = read.next();
	while (!next.done) next = read.next(items(next.value));
	return next.value;
}

export function hydrateQualityRead<A, Item, E>(
	read: QualityRead<A, Item>,
	items: (positions: readonly number[]) => Effect.Effect<readonly Item[], E>
): Effect.Effect<A, E> {
	return Effect.gen(function* () {
		let next = read.next();
		while (!next.done) next = read.next(yield* items(next.value));
		return next.value;
	});
}
