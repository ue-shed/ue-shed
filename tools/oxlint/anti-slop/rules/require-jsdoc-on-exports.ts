import { defineRule } from "@oxlint/plugins";

import type { ESTree, SourceCode } from "@oxlint/plugins";

/** A `/** … *\/` block directly before the node: only whitespace may separate them. */
function hasJsdoc(sourceCode: SourceCode, node: ESTree.Node): boolean {
	const comments = sourceCode.getCommentsBefore(node);
	const last = comments.at(-1);
	return (
		last !== undefined &&
		last.type === "Block" &&
		last.value.startsWith("*") &&
		sourceCode.text.slice(last.end, node.start).trim() === ""
	);
}

/** The names a declaration exports, for the message. */
function exportedName(declaration: ESTree.Node): string {
	if ("id" in declaration && declaration.id && "name" in declaration.id)
		return String(declaration.id.name);
	if (declaration.type === "VariableDeclaration")
		return declaration.declarations
			.map((item) => ("name" in item.id ? String(item.id.name) : "binding"))
			.join(", ");
	return "export";
}

/** Names of the module's exported `const` declarations. */
function exportedConstants(program: ESTree.Program): Set<string> {
	const names = new Set<string>();
	for (const statement of program.body)
		if (
			statement.type === "ExportNamedDeclaration" &&
			statement.declaration?.type === "VariableDeclaration"
		)
			for (const item of statement.declaration.declarations)
				if (item.id.type === "Identifier") names.add(item.id.name);
	return names;
}

/**
 * Require a JSDoc block on every exported declaration, so a public package documents what its
 * signatures cannot show. Re-exports (`export { x } from`) are documented where `x` is declared,
 * and a type alias or interface named after an exported constant (a schema's `typeof X.Type`)
 * shares the constant's documentation.
 */
export const requireJsdocOnExportsRule = defineRule({
	meta: {
		type: "suggestion",
		docs: {
			description:
				"Require a JSDoc block on every exported declaration in packages that enable it."
		},
		messages: {
			missingJsdoc:
				"Exported `{{name}}` has no JSDoc. Document what callers need that the signature cannot show: when it fails and how, units, limits, ownership or lifecycle."
		}
	},
	createOnce(context) {
		let constants = new Set<string>();
		return {
			Program(node) {
				constants = exportedConstants(node);
			},
			ExportNamedDeclaration(node) {
				if (!node.declaration || hasJsdoc(context.sourceCode, node)) return;
				if (
					(node.declaration.type === "TSTypeAliasDeclaration" ||
						node.declaration.type === "TSInterfaceDeclaration") &&
					constants.has(node.declaration.id.name)
				)
					return;
				context.report({
					node,
					messageId: "missingJsdoc",
					data: { name: exportedName(node.declaration) }
				});
			},
			ExportDefaultDeclaration(node) {
				if (hasJsdoc(context.sourceCode, node)) return;
				context.report({ node, messageId: "missingJsdoc", data: { name: "default" } });
			}
		};
	}
});
