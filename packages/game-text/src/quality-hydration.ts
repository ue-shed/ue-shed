/** Presentation selects positions; its caller supplies the findings at them. */
export type QualityRead<A, Item> = Generator<readonly number[], A, readonly Item[]>;

export function materializeQualityRead<A, Item>(
	read: QualityRead<A, Item>,
	items: (positions: readonly number[]) => readonly Item[]
): A {
	let next = read.next();
	while (!next.done) next = read.next(items(next.value));
	return next.value;
}
