import ts from "typescript";

/** Imports visible in a source file, with namespace/dynamic uses covering all names. */
export interface PackageImportUsage {
	readonly subpath: string;
	readonly names: readonly string[] | "all";
}

/** Find literal module references recursively, including import() inside service callbacks. */
export function packageImportUsages(
	source: ts.SourceFile,
	packageName: string
): readonly PackageImportUsage[] {
	const usages: PackageImportUsage[] = [];
	const record = (specifier: string, names: readonly string[] | "all") => {
		if (specifier !== packageName && !specifier.startsWith(packageName + "/")) return;
		usages.push({
			subpath: specifier === packageName ? "." : "." + specifier.slice(packageName.length),
			names
		});
	};
	const visit = (node: ts.Node): void => {
		if (ts.isImportDeclaration(node) && ts.isStringLiteralLike(node.moduleSpecifier)) {
			const bindings = node.importClause?.namedBindings;
			if (bindings && ts.isNamespaceImport(bindings))
				record(node.moduleSpecifier.text, "all");
			else {
				const names = bindings
					? bindings.elements.map((item) => (item.propertyName ?? item.name).text)
					: [];
				if (node.importClause?.name) names.push("default");
				record(node.moduleSpecifier.text, names);
			}
		} else if (
			ts.isExportDeclaration(node) &&
			node.moduleSpecifier &&
			ts.isStringLiteralLike(node.moduleSpecifier)
		) {
			record(
				node.moduleSpecifier.text,
				node.exportClause && ts.isNamedExports(node.exportClause)
					? node.exportClause.elements.map(
							(item) => (item.propertyName ?? item.name).text
						)
					: "all"
			);
		} else if (
			ts.isCallExpression(node) &&
			node.expression.kind === ts.SyntaxKind.ImportKeyword
		) {
			const specifier = node.arguments[0];
			if (specifier && ts.isStringLiteralLike(specifier)) record(specifier.text, "all");
		} else if (
			ts.isImportTypeNode(node) &&
			ts.isLiteralTypeNode(node.argument) &&
			ts.isStringLiteralLike(node.argument.literal)
		) {
			record(node.argument.literal.text, "all");
		}
		ts.forEachChild(node, visit);
	};
	visit(source);
	return usages;
}
