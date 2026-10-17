import { existsSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import ts from "typescript";
import { publicPackageEntries } from "./public-package-entries.ts";

const repositoryRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const reviewedPackages = [
	"protocol",
	"unreal-connection",
	"localization",
	"unreal-assets",
	"engine",
	"cameras",
	"host",
	"game-text"
];
const documentedPackages = new Set(["protocol", "unreal-connection", "game-text"]);

/** Enforce intentional named entry points and documentation on the completed public API tiers. */
export function checkPublicApi(root: string = repositoryRoot): readonly string[] {
	const failures: string[] = [];
	const entries = reviewedPackages.flatMap((folder) => {
		const directory = join(root, "packages", folder);
		if (!existsSync(join(directory, "package.json"))) return [];
		return [...publicPackageEntries(directory).entries].map(([subpath, file]) => ({
			folder,
			subpath,
			file
		}));
	});
	const program = ts.createProgram(
		entries.map(({ file }) => file),
		{
			noEmit: true,
			module: ts.ModuleKind.NodeNext,
			moduleResolution: ts.ModuleResolutionKind.NodeNext,
			target: ts.ScriptTarget.ESNext,
			skipLibCheck: true
		}
	);
	const checker = program.getTypeChecker();
	const checked = new Set<ts.Symbol>();
	for (const { folder, subpath, file } of entries) {
		const source = program.getSourceFile(file);
		if (!source) {
			failures.push(`${relative(root, file)}: public entry source is unavailable`);
			continue;
		}
		for (const node of source.statements)
			if (
				ts.isExportDeclaration(node) &&
				(!node.exportClause || ts.isNamespaceExport(node.exportClause))
			)
				failures.push(
					`${relative(root, file).replaceAll("\\", "/")}: public entry points must list exports by name`
				);
		if (!documentedPackages.has(folder)) continue;
		const module = checker.getSymbolAtLocation(source);
		if (!module) continue;
		for (const symbol of checker.getExportsOfModule(module)) {
			const target =
				symbol.flags & ts.SymbolFlags.Alias ? checker.getAliasedSymbol(symbol) : symbol;
			if (checked.has(target)) continue;
			checked.add(target);
			if (
				target.getDocumentationComment(checker).length ||
				target.getJsDocTags(checker).some(({ name }) => name === "deprecated")
			)
				continue;
			const declaration = target.valueDeclaration ?? target.declarations?.[0];
			if (!declaration) continue;
			const origin = declaration.getSourceFile();
			const line = origin.getLineAndCharacterOfPosition(declaration.getStart()).line + 1;
			failures.push(
				`${relative(root, origin.fileName).replaceAll("\\", "/")}:${line}: ${symbol.name} exported by ${folder}${subpath === "." ? "" : subpath.slice(1)} needs caller-facing JSDoc`
			);
		}
	}
	return failures;
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
	const failures = checkPublicApi();
	if (failures.length) {
		process.stderr.write(
			`Public API check failed:\n${failures.map((failure) => `- ${failure}`).join("\n")}\n`
		);
		process.exitCode = 1;
	} else process.stdout.write("Public API entry points and documentation passed.\n");
}
