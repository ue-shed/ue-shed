import { defineRule } from "@oxlint/plugins";

import type { ESTree } from "@oxlint/plugins";

const causeNames = new Set(["cause", "error", "err", "e", "failure", "reason", "defect"]);

function isCauseReference(node: ESTree.Node): boolean {
	if (node.type === "Identifier") return causeNames.has(node.name);
	if (node.type !== "MemberExpression") return false;
	return (
		isCauseReference(node.object) ||
		(!node.computed &&
			node.property.type === "Identifier" &&
			causeNames.has(node.property.name)) ||
		(node.computed &&
			node.property.type === "Literal" &&
			typeof node.property.value === "string" &&
			causeNames.has(node.property.value))
	);
}

function isStringifiedCause(node: ESTree.Node): boolean {
	if (node.type !== "CallExpression") return false;
	const callee = node.callee;
	// String(cause)
	if (callee.type === "Identifier" && callee.name === "String") {
		const [argument] = node.arguments;
		return (
			argument !== undefined &&
			argument.type !== "SpreadElement" &&
			isCauseReference(argument)
		);
	}
	// Cause.pretty(cause)
	return (
		callee.type === "MemberExpression" &&
		!callee.computed &&
		callee.object.type === "Identifier" &&
		callee.object.name === "Cause" &&
		callee.property.type === "Identifier" &&
		callee.property.name === "pretty"
	);
}

function containsStringifiedCause(node: ESTree.Node): boolean {
	if (isStringifiedCause(node)) return true;
	if (node.type === "TemplateLiteral") return node.expressions.some(containsStringifiedCause);
	if (node.type === "BinaryExpression")
		return containsStringifiedCause(node.left) || containsStringifiedCause(node.right);
	if (node.type === "ConditionalExpression")
		return (
			containsStringifiedCause(node.consequent) || containsStringifiedCause(node.alternate)
		);
	return false;
}

function isErrorConstruction(node: ESTree.Node): boolean {
	if (node.type !== "NewExpression" && node.type !== "CallExpression") return false;
	const callee = node.callee;
	const name =
		callee.type === "Identifier"
			? callee.name
			: callee.type === "MemberExpression" &&
				  !callee.computed &&
				  callee.property.type === "Identifier"
				? callee.property.name
				: undefined;
	// UI signal setters present diagnostics; they do not construct domain failures.
	if (node.type === "CallExpression" && name !== undefined && /^set[A-Z]/u.test(name))
		return false;
	return (
		name !== undefined &&
		(/(?:Error|Failure|Rejected|Unavailable|error|failure)$/u.test(name) || name === "invalid")
	);
}

/** Require error messages to classify a failure instead of embedding its stringified cause. */
export const noStringifiedCauseInErrorRule = defineRule({
	meta: {
		type: "problem",
		docs: {
			description:
				"Disallow `String(cause)` and `Cause.pretty` in the `message` of a constructed error; classify the failure and keep the cause in a `cause` field."
		},
		messages: {
			stringifiedCause:
				"Do not build an error message from a stringified cause. Write a classified message (what failed, which ids) and keep the original in the error's `cause` field."
		}
	},
	createOnce(context) {
		return {
			NewExpression(node) {
				if (!isErrorConstruction(node)) return;
				for (const argument of node.arguments) {
					if (argument.type !== "SpreadElement" && containsStringifiedCause(argument))
						context.report({ node: argument, messageId: "stringifiedCause" });
				}
			},
			CallExpression(node) {
				if (!isErrorConstruction(node)) return;
				for (const argument of node.arguments) {
					if (argument.type !== "SpreadElement" && containsStringifiedCause(argument))
						context.report({ node: argument, messageId: "stringifiedCause" });
				}
			},
			Property(node) {
				if (node.key.type !== "Identifier" || node.key.name !== "message") return;
				const object = node.parent;
				if (object?.type !== "ObjectExpression") return;
				const construction = object.parent;
				if (construction === undefined || !isErrorConstruction(construction)) return;
				if (containsStringifiedCause(node.value)) {
					context.report({ node: node.value, messageId: "stringifiedCause" });
				}
			}
		};
	}
});
