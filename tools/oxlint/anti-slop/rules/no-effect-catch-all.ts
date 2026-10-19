import { defineRule } from "@oxlint/plugins";

import type { ESTree } from "@oxlint/plugins";

/** Effect combinators that recover from every failure in the error channel alike. */
const catchAllCombinators = new Set([
	"catch",
	"catchAll",
	"catchCause",
	"catchAllCause",
	"orElse",
	"orElseFail",
	"orElseSucceed"
]);

function catchAllName(node: ESTree.CallExpression): string | undefined {
	const callee = node.callee;
	if (
		callee.type !== "MemberExpression" ||
		callee.computed ||
		callee.object.type !== "Identifier" ||
		callee.object.name !== "Effect" ||
		callee.property.type !== "Identifier"
	)
		return undefined;
	return catchAllCombinators.has(callee.property.name) ? callee.property.name : undefined;
}

/**
 * Require known failures to be translated by tag, so a newly added failure is a type error until
 * someone decides how to report it, instead of being silently folded into an existing answer.
 */
export const noEffectCatchAllRule = defineRule({
	meta: {
		type: "problem",
		docs: {
			description:
				"Disallow Effect catch-all recovery (catch, catchCause, orElse, orElseFail, orElseSucceed); translate known failures with Effect.catchTag, catchTags or catchIf."
		},
		messages: {
			catchAll:
				"Effect.{{name}} handles every failure alike, including ones added later. Translate known failures with Effect.catchTag/catchTags (or catchIf on a discriminating field). At a deliberate boundary, disable this rule on the line and say why."
		}
	},
	createOnce(context) {
		return {
			CallExpression(node) {
				if (node.callee.type === "Super" || node.callee.type === "V8IntrinsicExpression")
					return;
				const name = catchAllName(node);
				if (name === undefined) return;
				context.report({ node: node.callee, messageId: "catchAll", data: { name } });
			}
		};
	}
});
