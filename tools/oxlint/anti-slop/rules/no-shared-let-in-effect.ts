import { defineRule } from "@oxlint/plugins";

import type { ESTree } from "@oxlint/plugins";

import { TEST_FILE, effectBodyCall, enclosingFunction } from "../shared/effect-ownership.ts";

/**
 * `Effect.gen` bodies: in a service file these build the service or run its long-lived loops, so
 * their state outlives one call. An `Effect.fn` body's `let` lives for one call; the other two
 * ownership rules cover what goes wrong there.
 */
function isEffectGen(call: ESTree.CallExpression | undefined): boolean {
	const callee = call?.callee;
	return (
		callee?.type === "MemberExpression" &&
		!callee.computed &&
		callee.property.type === "Identifier" &&
		callee.property.name === "gen"
	);
}

/** Files that build a service or layer: their Effect bodies outlive one call. */
const SERVICE_FILE =
	/\bLayer\.(?:effect|scoped|succeed|sync|make)\b|\bContext\.(?:Service|Tag|Reference)\b|\bEffect\.Service\b|\bServiceMap\./;

/** Diagnostic tallies: they only grow, and nothing decides on them. */
const COUNTER =
	/(?:count|counts|bytes|received|drops|dropped|errors|failures|replacements|total|calls|attempts|hits|misses)$/i;

/**
 * Reports a `let` declared in an `Effect.gen` body of a service file and reassigned inside a nested
 * function. Such a variable is state that several fibers share with no owner: a late callback,
 * finalizer or second caller writes it after the moment its writer meant.
 */
export const noSharedLetInEffectRule = defineRule({
	meta: {
		type: "problem",
		docs: {
			description:
				"Disallow a `let` in a service's Effect body that nested functions reassign; hold the state in a Ref, SynchronizedRef, FiberHandle or ScopedRef."
		},
		messages: {
			sharedLet:
				"`{{name}}` is declared in this Effect body and reassigned inside a nested function, so it is state shared between fibers with no owner. " +
				"Is it a slot for a running fiber (latest wins)? Use FiberHandle (or FiberMap per key). " +
				"A resource that is replaced? Use ScopedRef. A value whose transitions decide what happens next? " +
				"Use SynchronizedRef.modify/modifyEffect (or Ref.modify) so the read and the write are one step. " +
				"If it is only a local tally, name it like one (`…Count`, `…Bytes`), or disable the line with the reason."
		}
	},
	create(context) {
		if (TEST_FILE.test(context.filename) || !SERVICE_FILE.test(context.sourceCode.text))
			return {};
		return {
			VariableDeclaration(node) {
				if (node.kind !== "let") return;
				const owner = enclosingFunction(node);
				if (!owner || !isEffectGen(effectBodyCall(owner))) return;
				for (const declarator of node.declarations) {
					for (const variable of context.sourceCode.getDeclaredVariables(declarator)) {
						if (COUNTER.test(variable.name)) continue;
						const capturedWrite = variable.references.some(
							(reference) =>
								reference.isWrite() &&
								!reference.init &&
								enclosingFunction(reference.identifier) !== owner
						);
						if (capturedWrite)
							context.report({
								node: declarator,
								messageId: "sharedLet",
								data: { name: variable.name }
							});
					}
				}
			}
		};
	}
});
