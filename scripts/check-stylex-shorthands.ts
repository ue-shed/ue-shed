import { readdir, readFile } from "node:fs/promises";
import { join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * StyleX resolves styles with `property-specificity`, and that resolver refuses these shorthands.
 *
 * The refusal is silent: the build succeeds, `stylex.props` still returns a class name, and the
 * declaration is simply never written to the stylesheet. A dropped `border` on a `<button>` is
 * worse than nothing, because the user agent's own button border shows through instead — a bright
 * `ButtonBorder` box under `color-scheme: dark`. Write the longhands instead.
 */
export const droppedShorthands = [
	"all",
	"animation",
	"background",
	"border",
	"borderBlock",
	"borderBottom",
	"borderInline",
	"borderInlineEnd",
	"borderInlineStart",
	"borderLeft",
	"borderRight",
	"borderTop"
] as const;

export interface ShorthandFinding {
	readonly file: string;
	readonly line: number;
	readonly property: string;
	readonly text: string;
}

const declaration = new RegExp(`^[\\t ]*(${droppedShorthands.join("|")})\\s*:`);

/**
 * Spans covering the argument list of every `callee(...)` in `source`.
 *
 * The same shorthand in a plain `style={{ ... }}` prop is ordinary CSS and works, so only the text
 * inside a StyleX call is a finding.
 */
function calleeSpans(source: string, callee: string): readonly (readonly [number, number])[] {
	const spans: (readonly [number, number])[] = [];
	const needle = `${callee}(`;
	let index = source.indexOf(needle);
	while (index !== -1) {
		let cursor = index + needle.length;
		let depth = 1;
		while (cursor < source.length && depth > 0) {
			const character = source[cursor];
			if (character === "(" || character === "[" || character === "{") depth += 1;
			else if (character === ")" || character === "]" || character === "}") depth -= 1;
			cursor += 1;
		}
		spans.push([index, cursor] as const);
		index = source.indexOf(needle, cursor);
	}
	return spans;
}

export function findDroppedShorthands(file: string, source: string): readonly ShorthandFinding[] {
	const spans = [
		...calleeSpans(source, "stylex.create"),
		...calleeSpans(source, "stylex.keyframes")
	];
	if (spans.length === 0) return [];
	const findings: ShorthandFinding[] = [];
	let offset = 0;
	const lines = source.split("\n");
	for (const [index, line] of lines.entries()) {
		const match = declaration.exec(line);
		if (match && spans.some(([start, end]) => offset >= start && offset < end)) {
			findings.push({
				file,
				line: index + 1,
				property: match[1] ?? "",
				text: line.trim()
			});
		}
		offset += line.length + 1;
	}
	return findings;
}

const skippedDirectories = new Set(["node_modules", "dist", "build", "target", ".git"]);

async function* sourceFiles(directory: string): AsyncGenerator<string> {
	for (const entry of await readdir(directory, { withFileTypes: true })) {
		if (entry.isDirectory()) {
			if (skippedDirectories.has(entry.name)) continue;
			yield* sourceFiles(join(directory, entry.name));
		} else if (entry.name.endsWith(".ts") || entry.name.endsWith(".tsx")) {
			yield join(directory, entry.name);
		}
	}
}

async function main(): Promise<void> {
	const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
	const findings: ShorthandFinding[] = [];
	let scanned = 0;
	for (const area of ["apps", "examples", "extensions", "packages"]) {
		for await (const path of sourceFiles(join(root, area))) {
			const source = await readFile(path, "utf8");
			if (!source.includes("stylex.create") && !source.includes("stylex.keyframes")) continue;
			scanned += 1;
			findings.push(
				...findDroppedShorthands(relative(root, path).replaceAll("\\", "/"), source)
			);
		}
	}
	if (findings.length > 0) {
		for (const finding of findings) {
			console.error(
				`${finding.file}:${finding.line} uses the "${finding.property}" shorthand, which ` +
					`StyleX drops without emitting CSS. Write the longhands instead.\n    ${finding.text}`
			);
		}
		process.exitCode = 1;
		return;
	}
	console.log(
		`StyleX shorthand check ok: ${scanned} styled files, no silently dropped declarations.`
	);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
	await main();
}
