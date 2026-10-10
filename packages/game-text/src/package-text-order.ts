/** Rust Path ordering compares components: a directory component ends before any filename
 * suffix. Inputs are the normalized paths from one Project Index generation; slash direction
 * does not affect their component order. Compare UTF-8 bytes, as the native scanner does.
 */
export function comparePackageTextPathBytes(left: Uint8Array, right: Uint8Array): number {
	const length = Math.min(left.length, right.length);
	for (let index = 0; index < length; index++) {
		const a = left[index]!,
			b = right[index]!;
		const componentA = a === 47 || a === 92 ? 0 : a;
		const componentB = b === 47 || b === 92 ? 0 : b;
		if (componentA !== componentB) return componentA - componentB;
	}
	return left.length - right.length;
}
