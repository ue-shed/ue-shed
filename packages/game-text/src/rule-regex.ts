/** A parsed JavaScript (Unicode mode) pattern, reduced to what decides a lookbehind's width. */
type Node =
	| { readonly kind: "alternation"; readonly branches: readonly Node[] }
	| { readonly kind: "sequence"; readonly items: readonly Node[] }
	| { readonly kind: "group"; readonly capturing: boolean; readonly body: Node }
	| { readonly kind: "lookaround"; readonly behind: boolean; readonly body: Node }
	| { readonly kind: "repeat"; readonly body: Node; readonly exact: number | undefined }
	| { readonly kind: "character" }
	| { readonly kind: "assertion" }
	| { readonly kind: "backreference" };

/**
 * Whether a pattern that `new RegExp(pattern, "u")` accepted is in the rule language's regex
 * dialect: JavaScript, with every lookbehind fixed-width in characters. A lookbehind's body is
 * fixed-width, or an alternation whose branches each are; empty non-capturing groups are ignored
 * and non-capturing groups around the whole body are transparent. Inside a lookbehind, repeats
 * are exact (`{n}` or `{n,n}`, lazy or not) of something at least one character wide, nested
 * alternations have branches of equal width, and there are no backreferences; anchors and
 * lookarounds take no width. The native engine runs every pattern in the dialect with
 * JavaScript semantics; its tests check that on listed and on generated patterns.
 */
export function engineRunsPattern(pattern: string): boolean {
	return supported(new Parser(pattern).parse());
}

function supported(node: Node): boolean {
	switch (node.kind) {
		case "alternation":
			return node.branches.every(supported);
		case "sequence":
			return node.items.every(supported);
		case "group":
		case "repeat":
			return supported(node.body);
		case "lookaround":
			return supported(node.body) && (!node.behind || lookbehind(node.body));
		default:
			return true;
	}
}

function lookbehind(body: Node): boolean {
	let top = withoutEmptyGroups(body);
	for (;;) {
		const only = top.kind === "sequence" && top.items.length === 1 ? top.items[0]! : top;
		if (only.kind !== "group" || only.capturing) break;
		top = withoutEmptyGroups(only.body);
	}
	return top.kind === "alternation"
		? top.branches.every((branch) => width(branch) !== undefined)
		: width(top) !== undefined;
}

/** The node's fixed width in characters, or `undefined` when the dialect gives it none. */
function width(node: Node): number | undefined {
	switch (node.kind) {
		case "alternation": {
			const widths = node.branches.map(width);
			const first = widths[0];
			return widths.every((value) => value !== undefined && value === first)
				? first
				: undefined;
		}
		case "sequence": {
			let total = 0;
			for (const item of node.items) {
				const value = width(item);
				if (value === undefined) return undefined;
				total += value;
			}
			return total;
		}
		case "group":
			return width(node.body);
		case "repeat": {
			const value = width(node.body);
			return value === undefined || value === 0 || node.exact === undefined
				? undefined
				: value * node.exact;
		}
		case "character":
			return 1;
		case "lookaround":
		case "assertion":
			return 0;
		case "backreference":
			return undefined;
	}
}

/** Empty non-capturing groups match nothing and take no part in the body's shape. */
function withoutEmptyGroups(node: Node): Node {
	if (node.kind !== "sequence") return node;
	const items = node.items.filter(
		(item) =>
			!(
				item.kind === "group" &&
				!item.capturing &&
				item.body.kind === "sequence" &&
				item.body.items.length === 0
			)
	);
	return items.length === node.items.length ? node : { kind: "sequence", items };
}

class Parser {
	private index = 0;
	private readonly pattern: string;
	constructor(pattern: string) {
		this.pattern = pattern;
	}

	parse(): Node {
		return this.alternation();
	}

	private alternation(): Node {
		const branches = [this.sequence()];
		while (this.pattern[this.index] === "|") {
			this.index += 1;
			branches.push(this.sequence());
		}
		return branches.length === 1 ? branches[0]! : { kind: "alternation", branches };
	}

	private sequence(): Node {
		const items: Node[] = [];
		while (this.index < this.pattern.length) {
			const character = this.pattern[this.index]!;
			if (character === "|" || character === ")") break;
			items.push(this.quantified(this.atom()));
		}
		return { kind: "sequence", items };
	}

	private atom(): Node {
		const pattern = this.pattern;
		const character = pattern[this.index]!;
		if (character === "(") {
			const lookaround = ["(?<=", "(?<!", "(?=", "(?!"].find((prefix) =>
				pattern.startsWith(prefix, this.index)
			);
			const capturing = !lookaround && !pattern.startsWith("(?:", this.index);
			if (lookaround) this.index += lookaround.length;
			else if (!capturing) this.index += 3;
			else if (pattern.startsWith("(?<", this.index))
				this.index = pattern.indexOf(">", this.index) + 1;
			else this.index += 1;
			const body = this.alternation();
			this.index += 1;
			return lookaround
				? { kind: "lookaround", behind: lookaround.startsWith("(?<"), body }
				: { kind: "group", capturing, body };
		}
		if (character === "[") {
			// Unicode mode has no nested classes: the class ends at the first unescaped `]`.
			this.index += pattern[this.index + 1] === "^" ? 2 : 1;
			while (this.index < pattern.length && pattern[this.index] !== "]")
				this.index += pattern[this.index] === "\\" ? 2 : 1;
			this.index += 1;
			return { kind: "character" };
		}
		if (character === "^" || character === "$") {
			this.index += 1;
			return { kind: "assertion" };
		}
		if (character === "\\") {
			const next = pattern[this.index + 1] ?? "";
			if (/[1-9]/u.test(next)) {
				this.index += 1;
				while (/\d/u.test(pattern[this.index] ?? "")) this.index += 1;
				return { kind: "backreference" };
			}
			if (next === "k") {
				this.index = pattern.indexOf(">", this.index) + 1;
				return { kind: "backreference" };
			}
			if (next === "b" || next === "B") {
				this.index += 2;
				return { kind: "assertion" };
			}
			const braced =
				(next === "u" || next === "p" || next === "P") && pattern[this.index + 2] === "{";
			if (braced) this.index = pattern.indexOf("}", this.index) + 1;
			else if (next === "u") this.index += this.surrogatePair() ? 12 : 6;
			else if (next === "x") this.index += 4;
			else if (next === "c") this.index += 3;
			else this.index += 2;
			return { kind: "character" };
		}
		// One code point, which is one character to the engine.
		this.index += pattern.codePointAt(this.index)! > 0xffff ? 2 : 1;
		return { kind: "character" };
	}

	/** An escaped surrogate pair, `😀`, is one character. */
	private surrogatePair(): boolean {
		const high = Number.parseInt(this.pattern.slice(this.index + 2, this.index + 6), 16);
		const low = this.pattern.startsWith("\\u", this.index + 6)
			? Number.parseInt(this.pattern.slice(this.index + 8, this.index + 12), 16)
			: Number.NaN;
		return high >= 0xd800 && high <= 0xdbff && low >= 0xdc00 && low <= 0xdfff;
	}

	private quantified(atom: Node): Node {
		const pattern = this.pattern;
		const character = pattern[this.index];
		let exact: number | undefined;
		if (character === "*" || character === "+" || character === "?") {
			this.index += 1;
		} else {
			const bounds =
				character === "{" ? /^\{(\d+)(,(\d*))?\}/u.exec(pattern.slice(this.index)) : null;
			if (!bounds) return atom;
			this.index += bounds[0].length;
			// Bounds are numbers: `{02,2}` is exact.
			const least = Number(bounds[1]);
			if (bounds[2] === undefined || (bounds[3] !== "" && Number(bounds[3]) === least))
				exact = least;
		}
		// A lazy marker changes the order matches are tried, not the width.
		if (pattern[this.index] === "?") this.index += 1;
		return { kind: "repeat", body: atom, exact };
	}
}
