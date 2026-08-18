import { defineRule } from "@oxlint/plugins";

import type { ESTree, Scope, SourceCode, Variable } from "@oxlint/plugins";

const moduleMockMethods = new Set(["doMock", "mock", "unstable_mockModule"]);

function resolveVariable(
	sourceCode: SourceCode,
	identifier: ESTree.IdentifierReference
): Variable | null {
	let scope: Scope | null = sourceCode.getScope(identifier);
	while (scope !== null) {
		const variable = scope.set.get(identifier.name);
		if (variable !== undefined) return variable;
		scope = scope.upper;
	}
	return null;
}

function importedName(node: ESTree.Node): string | null {
	if (node.type !== "ImportSpecifier") return null;
	return node.imported.type === "Identifier" ? node.imported.name : node.imported.value;
}

function memberName(expression: ESTree.MemberExpression): string | null {
	const property = expression.property;
	return expression.computed
		? property.type === "Literal" && typeof property.value === "string"
			? property.value
			: null
		: property.type === "Identifier"
			? property.name
			: null;
}

function namespaceImportSource(
	sourceCode: SourceCode,
	identifier: ESTree.IdentifierReference
): string | null {
	const variable = resolveVariable(sourceCode, identifier);
	if (variable === null) return null;
	for (const definition of variable.defs) {
		if (
			definition.type === "ImportBinding" &&
			definition.node.type === "ImportNamespaceSpecifier" &&
			definition.parent?.type === "ImportDeclaration"
		) {
			return definition.parent.source.value;
		}
	}
	return null;
}

function isTestFrameworkObject(sourceCode: SourceCode, expression: ESTree.Expression): boolean {
	if (expression.type === "MemberExpression") {
		if (expression.object.type !== "Identifier") return false;
		const source = namespaceImportSource(sourceCode, expression.object);
		const name = memberName(expression);
		return (
			(source === "vitest" && name === "vi") ||
			(source === "@jest/globals" && name === "jest")
		);
	}
	if (expression.type !== "Identifier") return false;
	if (
		(expression.name === "vi" || expression.name === "jest") &&
		sourceCode.isGlobalReference(expression)
	)
		return true;

	const variable = resolveVariable(sourceCode, expression);
	if (variable === null || variable.defs.length === 0) {
		return expression.name === "vi" || expression.name === "jest";
	}
	return variable.defs.some((definition) => {
		if (
			definition.type !== "ImportBinding" ||
			definition.parent?.type !== "ImportDeclaration"
		) {
			return false;
		}
		const source = definition.parent.source.value;
		const name = importedName(definition.node);
		return (
			(source === "vitest" && name === "vi") ||
			(source === "@jest/globals" && name === "jest")
		);
	});
}

function moduleMockCall(sourceCode: SourceCode, callee: ESTree.Expression): boolean {
	if (callee.type !== "MemberExpression") return false;
	if (!isTestFrameworkObject(sourceCode, callee.object)) return false;
	const method = memberName(callee);
	return method !== null && moduleMockMethods.has(method);
}

/** Ban test framework module mocking in favor of real dependency seams. */
export const noModuleMockingRule = defineRule({
	meta: {
		type: "problem",
		docs: {
			description:
				"Disallow Vitest and Jest module mocking; tests must replace dependencies through real interfaces."
		},
		messages: {
			moduleMock:
				"Replace module mocking with dependency injection through a real interface, service layer, or faithful test implementation."
		}
	},
	createOnce(context) {
		return {
			CallExpression(node) {
				if (node.callee.type === "Super" || node.callee.type === "V8IntrinsicExpression")
					return;
				if (moduleMockCall(context.sourceCode, node.callee)) {
					context.report({ node, messageId: "moduleMock" });
				}
			}
		};
	}
});
