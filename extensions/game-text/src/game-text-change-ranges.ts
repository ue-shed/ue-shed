function argumentRange(text: string, start: number, end: number) {
	for (const token of text.matchAll(/\{[^{}\r\n]+\}/gu)) {
		const tokenEnd = token.index + token[0].length;
		const overlaps = token.index < end && tokenEnd > start;
		const insertion = start === end && token.index < start && start < tokenEnd;
		if (overlaps || insertion) {
			start = Math.min(start, token.index);
			end = Math.max(end, tokenEnd);
		}
	}
	return start < end ? [{ start, end }] : [];
}

export function changeRanges(before: string, after: string) {
	if (before === after) return { before: [], after: [] };
	let start = 0,
		tail = 0;
	while (start < before.length && start < after.length && before[start] === after[start]) start++;
	while (
		tail < before.length - start &&
		tail < after.length - start &&
		before[before.length - tail - 1] === after[after.length - tail - 1]
	)
		tail++;
	return {
		before: argumentRange(before, start, before.length - tail),
		after: argumentRange(after, start, after.length - tail)
	};
}
