/**
 * Measures the public surface of host-facing packages: every name each entry point exports,
 * against the names other packages, apps and extensions import (Plan 058 D13).
 *
 *   node scripts/measure-package-exports.ts [--json] [package ...]
 *
 * A name is "used" when a file outside the package imports it by name from any of the package's
 * entry points, or re-exports it. A namespace import (`import * as x`) or `export *` from the
 * package counts every name of that entry point as used. Literal dynamic and type imports also
 * count the whole entry point, since member attribution is conservative. Uses inside the package itself, and
 * uses in other repositories (downstream hosts), are not visible here.
 */
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { publicPackageEntries } from "./public-package-entries.ts";
import { packageImportUsages } from "./package-import-usages.ts";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const defaults = [
	"protocol",
	"unreal-connection",
	"localization",
	"unreal-assets",
	"engine",
	"cameras",
	"host"
];
const args = process.argv.slice(2);
const json = args.includes("--json");
const selected = args.filter((argument) => !argument.startsWith("--"));
const packages = selected.length ? selected : defaults;

function sourceFiles(directory: string, found: string[] = []): string[] {
	for (const entry of readdirSync(directory, { withFileTypes: true })) {
		if (entry.name === "node_modules" || entry.name === "dist" || entry.name.startsWith("."))
			continue;
		const path = join(directory, entry.name);
		if (entry.isDirectory()) sourceFiles(path, found);
		else if (/\.(?:ts|tsx|mts)$/u.test(entry.name) && !entry.name.endsWith(".d.ts"))
			found.push(path);
	}
	return found;
}

const measured = packages.map((folder) => ({
	folder,
	...publicPackageEntries(join(root, "packages", folder))
}));
const program = ts.createProgram(
	measured.flatMap(({ entries }) => [...entries.values()]),
	{
		allowImportingTsExtensions: true,
		module: ts.ModuleKind.NodeNext,
		moduleResolution: ts.ModuleResolutionKind.NodeNext,
		noEmit: true,
		target: ts.ScriptTarget.ESNext
	}
);
const checker = program.getTypeChecker();

function exportedNames(file: string): string[] {
	const source = program.getSourceFile(file);
	const symbol = source && checker.getSymbolAtLocation(source);
	return symbol ? checker.getExportsOfModule(symbol).map((item) => item.name) : [];
}

const consumers = ["apps", "packages", "extensions", "scripts"].flatMap((folder) =>
	sourceFiles(join(root, folder))
);

const rows = measured.map(({ folder, name, entries }) => {
	const ownDirectory = join(root, "packages", folder);
	/** Names used from each subpath, by consumer folder. */
	const used = new Map<string, Set<string>>([...entries.keys()].map((key) => [key, new Set()]));
	const all = new Set<string>();
	for (const file of consumers) {
		if (file.startsWith(ownDirectory + sep)) continue;
		const text = readFileSync(file, "utf8");
		if (!text.includes(name)) continue;
		const source = ts.createSourceFile(file, text, ts.ScriptTarget.ESNext, false);
		for (const usage of packageImportUsages(source, name)) {
			const names = used.get(usage.subpath);
			if (!names) continue;
			if (usage.names === "all") {
				all.add(usage.subpath);
				continue;
			}
			for (const exported of usage.names) names.add(exported);
		}
	}
	const subpaths = [...entries].map(([subpath, file]) => {
		const names = exportedNames(file);
		const usedNames = all.has(subpath)
			? names
			: names.filter((exported) => used.get(subpath)?.has(exported));
		return {
			subpath,
			exports: names.length,
			used: usedNames.length,
			unused: names.filter((exported) => !usedNames.includes(exported)).sort(),
			wholeEntryPointImported: all.has(subpath)
		};
	});
	return { package: name, subpaths };
});

if (json) console.log(JSON.stringify(rows, null, "\t"));
else
	for (const row of rows) {
		const exports = row.subpaths.reduce((sum, item) => sum + item.exports, 0);
		const used = row.subpaths.reduce((sum, item) => sum + item.used, 0);
		console.log(
			`${row.package}: ${used} of ${exports} exported names used outside the package`
		);
		for (const item of row.subpaths)
			console.log(
				`  ${item.subpath}: ${item.used}/${item.exports}${item.wholeEntryPointImported ? " (namespace/dynamic/type import)" : ""}`
			);
	}
