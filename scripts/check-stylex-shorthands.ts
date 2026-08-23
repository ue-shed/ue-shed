import { readdir, readFile } from "node:fs/promises";
import { join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

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

const droppedShorthandSet = new Set<string>(droppedShorthands);

function propertyName(name: ts.PropertyName): string | undefined {
	return ts.isIdentifier(name) || ts.isStringLiteralLike(name) ? name.text : undefined;
}

function isStylexDeclaration(node: ts.Node): node is ts.CallExpression {
	return (
		ts.isCallExpression(node) &&
		ts.isPropertyAccessExpression(node.expression) &&
		ts.isIdentifier(node.expression.expression) &&
		node.expression.expression.text === "stylex" &&
		(node.expression.name.text === "create" || node.expression.name.text === "keyframes")
	);
}

export function findDroppedShorthands(file: string, source: string): readonly ShorthandFinding[] {
	const sourceFile = ts.createSourceFile(
		file,
		source,
		ts.ScriptTarget.Latest,
		true,
		file.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS
	);
	const findings: ShorthandFinding[] = [];
	const lines = source.split("\n");
	const inspectDeclaration = (node: ts.Node): void => {
		if (ts.isPropertyAssignment(node)) {
			const property = propertyName(node.name);
			if (property && droppedShorthandSet.has(property)) {
				const position = sourceFile.getLineAndCharacterOfPosition(
					node.name.getStart(sourceFile)
				);
				findings.push({
					file,
					line: position.line + 1,
					property,
					text: lines[position.line]?.trim() ?? property
				});
			}
		}
		ts.forEachChild(node, inspectDeclaration);
	};
	const visit = (node: ts.Node): void => {
		if (isStylexDeclaration(node)) {
			for (const argument of node.arguments) inspectDeclaration(argument);
			return;
		}
		ts.forEachChild(node, visit);
	};
	visit(sourceFile);
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
