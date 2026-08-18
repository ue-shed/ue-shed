import { defineRule } from "@oxlint/plugins";
import type { ESTree, SourceCode } from "@oxlint/plugins";

const FORBIDDEN_SYMBOL_NAME = "shape";

function containsForbiddenSymbolName(name: string): boolean {
	return name.toLowerCase().includes(FORBIDDEN_SYMBOL_NAME);
}

function compatibilityAliasTargetName(annotation: ESTree.TSType): string | null {
	if (
		annotation.type === "TSTypeReference" &&
		annotation.typeArguments === null &&
		annotation.typeName.type === "Identifier"
	)
		return annotation.typeName.name;
	if (
		annotation.type === "TSImportType" &&
		annotation.typeArguments === null &&
		annotation.qualifier?.type === "Identifier"
	)
		return annotation.qualifier.name;
	return null;
}

function isDeprecatedCompatibilityAlias(
	sourceCode: SourceCode,
	node: ESTree.Node & { name: string }
): boolean {
	if (
		!node.name.endsWith("Shape") ||
		node.parent.type !== "TSTypeAliasDeclaration" ||
		node.parent.id !== node
	)
		return false;
	const declaration = node.parent;
	if (declaration.parent.type !== "ExportNamedDeclaration") return false;
	const targetName = compatibilityAliasTargetName(declaration.typeAnnotation);
	if (targetName !== `${node.name.slice(0, -"Shape".length)}Api`) return false;
	return sourceCode
		.getCommentsBefore(declaration.parent)
		.some((comment) => /@deprecated\b/u.test(comment.value));
}

/** Ban the case-insensitive substring "shape" in every JavaScript and TypeScript symbol name. */
export const noForbiddenTermInSymbolNamesRule = defineRule({
	meta: {
		type: "problem",
		docs: {
			description:
				'Disallow the case-insensitive substring "shape" in JavaScript, TypeScript, private, and JSX symbol names.'
		},
		messages: {
			forbiddenSymbolName:
				'Rename symbol "{{name}}" for its domain role; "shape" describes structure rather than ownership.'
		}
	},
	createOnce(context) {
		const reportForbiddenSymbolName = (node: ESTree.Node & { name: string }) => {
			if (
				!containsForbiddenSymbolName(node.name) ||
				isDeprecatedCompatibilityAlias(context.sourceCode, node)
			)
				return;
			context.report({
				node,
				messageId: "forbiddenSymbolName",
				data: { name: node.name }
			});
		};

		return {
			Identifier: reportForbiddenSymbolName,
			PrivateIdentifier: reportForbiddenSymbolName,
			JSXIdentifier: reportForbiddenSymbolName
		};
	}
});
