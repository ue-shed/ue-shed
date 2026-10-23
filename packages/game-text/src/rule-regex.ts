/**
 * Whether the native engine runs a JavaScript (Unicode mode) pattern that `new RegExp` accepted.
 * The engine runs JavaScript semantics except inside a lookbehind, which must not contain a
 * variable quantifier (`?`, `*`, `+`, `{n,}`, `{n,m}` with n < m) or a backreference outside a
 * nested lookahead. The engine's
 * regex tests pin this predicate against the engine's own compiler.
 */
export function engineRunsPattern(pattern: string): boolean {
	// Each open group records whether it is, or sits inside, a lookbehind.
	const groups: boolean[] = [];
	const behind = () => groups.at(-1) === true;
	let index = 0;
	while (index < pattern.length) {
		const character = pattern[index]!;
		if (character === "\\") {
			const next = pattern[index + 1] ?? "";
			if (behind() && (/[1-9]/u.test(next) || pattern.startsWith("k<", index + 1)))
				return false;
			const braced =
				(next === "u" || next === "p" || next === "P") && pattern[index + 2] === "{";
			index = braced ? pattern.indexOf("}", index) + 1 : index + 2;
			continue;
		}
		if (character === "[") {
			// Unicode mode has no nested classes: the class ends at the first unescaped `]`.
			index += pattern[index + 1] === "^" ? 2 : 1;
			while (index < pattern.length && pattern[index] !== "]")
				index += pattern[index] === "\\" ? 2 : 1;
			index += 1;
			continue;
		}
		if (character === "(") {
			const lookbehind =
				pattern.startsWith("(?<=", index) || pattern.startsWith("(?<!", index);
			// A lookahead takes no width, so its body is free even inside a lookbehind.
			const lookahead = pattern.startsWith("(?=", index) || pattern.startsWith("(?!", index);
			groups.push(lookbehind || (!lookahead && behind()));
			// Skip the opener, so its `?` is not read as a quantifier.
			if (lookbehind) index += 4;
			else if (pattern.startsWith("(?<", index)) index = pattern.indexOf(">", index) + 1;
			else index += pattern[index + 1] === "?" ? 3 : 1;
			continue;
		}
		if (character === ")") {
			groups.pop();
			index += 1;
			continue;
		}
		if (behind()) {
			if (character === "*" || character === "+" || character === "?") return false;
			const bounds = /^\{(\d+)(,(\d*))?\}/u.exec(pattern.slice(index));
			if (bounds?.[2] !== undefined && bounds[3] !== bounds[1]) return false;
		}
		index += 1;
	}
	return true;
}
