/** Input-size reservations bound concurrent cold work without a serial memory probe.
 * Estimates are deliberately conservative; one oversized task can run alone.
 */
export async function runColdTasks<A>(
	tasks: readonly { readonly row: number; readonly bytes: number }[],
	memoryBudget: number,
	maximumConcurrency: number,
	run: (row: number, slot: number) => Promise<A>
) {
	const pending = [...tasks].sort((a, b) => b.bytes - a.bytes);
	const results: A[] = [];
	const slots = Array.from({ length: Math.max(1, maximumConcurrency) }, (_, slot) => slot);
	let reserved = 0,
		active = 0,
		workerCount = 0,
		stopped = false;
	await new Promise<void>((resolve, reject) => {
		const pump = () => {
			if (stopped) return;
			if (!pending.length && !active) {
				resolve();
				return;
			}
			while (slots.length && pending.length) {
				let position = pending.findIndex((task) => task.bytes <= memoryBudget - reserved);
				if (position < 0) {
					if (active) break;
					position = 0;
				}
				const task = pending.splice(position, 1)[0]!,
					slot = slots.shift()!;
				reserved += task.bytes;
				active++;
				workerCount = Math.max(workerCount, active);
				void Promise.resolve()
					.then(() => run(task.row, slot))
					.then(
						(value) => {
							results[task.row] = value;
							reserved -= task.bytes;
							active--;
							slots.push(slot);
							pump();
						},
						(cause: unknown) => {
							stopped = true;
							reject(cause);
						}
					);
			}
		};
		pump();
	});
	return { results, workerCount };
}

/** Keep half the available process memory for the coordinator, dictionary and OS changes. */
export const coldMemoryBudget = (availableBytes: number) => Math.max(1, availableBytes * 0.5);
/** One pool's share when two cold pools can run at once against one shared budget. */
export const coldHalfBudget = (availableBytes: number) =>
	Math.max(1, Math.floor(coldMemoryBudget(availableBytes) / 2));
export const coldParserReservation = (inputBytes: number) => 128 * 1024 ** 2 + inputBytes * 32;
