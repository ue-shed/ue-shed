import { defineRule } from "@oxlint/plugins";

import type { ESTree } from "@oxlint/plugins";

import {
	TEST_FILE,
	calleeName,
	contains,
	enclosingFunction,
	isFunctionNode,
	isInCondition,
	refCall,
	type FunctionNode
} from "../shared/effect-ownership.ts";

/** Calls whose arguments run when something ends: `cleanupArgument` says which ones. */
const CLEANUP_CALLS = new Set([
	"ensuring",
	"onExit",
	"onInterrupt",
	"addFinalizer",
	"finally",
	"acquireRelease",
	"acquireUseRelease"
]);
const DATA_FIRST = new Set(["ensuring", "onExit", "onInterrupt"]);
const LISTENERS = new Set(["on", "once", "addListener", "addEventListener"]);
const END_EVENTS = new Set(["close", "exit", "end", "disconnect"]);
const END_HANDLERS = /^on(?:close|exit|end|disconnect)$/;
const REF_SET = new Set(["set"]);

function cleanupArgument(call: ESTree.CallExpression, argument: ESTree.Node): boolean {
	const name = calleeName(call);
	if (!name) return false;
	const index = call.arguments.indexOf(argument);
	if (name === "acquireRelease") return index === 1;
	if (name === "acquireUseRelease") return index === 2;
	// Data-first `Effect.ensuring(self, finalizer)`: the first argument is the work, not cleanup.
	if (DATA_FIRST.has(name) && call.arguments.length > 1) return index === 1;
	if (CLEANUP_CALLS.has(name)) return index >= 0;
	if (!LISTENERS.has(name) || index < 1) return false;
	const event = call.arguments[0];
	return (
		event?.type === "Literal" && typeof event.value === "string" && END_EVENTS.has(event.value)
	);
}

/** The function that runs as cleanup and contains `node`, if any. */
function cleanupHandler(node: ESTree.Node): FunctionNode | undefined {
	let handler: FunctionNode | undefined;
	let child: ESTree.Node = node;
	let current: ESTree.Node | null = node.parent;
	while (current) {
		if (current.type === "TryStatement" && current.finalizer === child)
			return handler ?? enclosingFunction(current);
		if (isFunctionNode(current)) handler = current;
		if (
			current.type === "CallExpression" &&
			current.callee !== child &&
			cleanupArgument(current, child)
		)
			return handler;
		if (
			current.type === "AssignmentExpression" &&
			current.right === child &&
			current.left.type === "MemberExpression" &&
			!current.left.computed &&
			current.left.property.type === "Identifier" &&
			END_HANDLERS.test(current.left.property.name)
		)
			return handler;
		child = current;
		current = current.parent;
	}
	return undefined;
}

function exits(statement: ESTree.Node): boolean {
	if (statement.type === "ReturnStatement" || statement.type === "ThrowStatement") return true;
	if (statement.type !== "BlockStatement") return false;
	const last = statement.body.at(-1);
	return last?.type === "ReturnStatement" || last?.type === "ThrowStatement";
}

function isEmpty(node: ESTree.Node | null | undefined): boolean {
	if (!node) return true;
	if (node.type === "Identifier") return node.name === "undefined";
	if (node.type === "Literal") return node.value === null;
	if (node.type === "UnaryExpression") return node.operator === "void";
	if (node.type === "CallExpression") {
		const callee = node.callee;
		return (
			callee.type === "MemberExpression" &&
			!callee.computed &&
			callee.object.type === "Identifier" &&
			callee.object.name === "Option" &&
			callee.property.type === "Identifier" &&
			callee.property.name === "none"
		);
	}
	return false;
}

const IDENTITY = new Set(["===", "!==", "==", "!="]);

/**
 * Reports cleanup (a finalizer, `ensuring`, `finally`, a close listener) that clears a captured
 * owner slot without checking the slot still holds what this cleanup owns. A newer owner may have
 * taken the slot while the old one was ending; the late cleanup then clears the new owner.
 */
export const noUnguardedOwnerClearRule = defineRule({
	meta: {
		type: "problem",
		docs: {
			description:
				"Disallow cleanup that clears a captured owner slot without an identity check; clear only your own entry."
		},
		messages: {
			unguardedClear:
				"This cleanup clears `{{slot}}` without checking it still holds what this cleanup owns. " +
				"A newer owner can take the slot before this one finishes ending, and this line then clears the newer one. " +
				"Use FiberHandle/FiberMap or ScopedRef, which only clear their own entry, or compare and clear in one step " +
				"(`if ({{slot}} === mine) {{slot}} = undefined`, or Ref.modify/update). " +
				"If only one owner can ever hold the slot, disable the line with the reason."
		}
	},
	create(context) {
		if (TEST_FILE.test(context.filename)) return {};
		const source = context.sourceCode;

		/** Whether the comparison decides if `clear` runs: it encloses it, or exits before it. */
		function fences(
			comparison: ESTree.Node,
			clear: ESTree.Node,
			handler: FunctionNode
		): boolean {
			let child: ESTree.Node = comparison;
			let current: ESTree.Node | null = comparison.parent;
			// Inside a compound test, the comparison decides a true test only through `&&`
			// (`a && b` is true only when `a` is) and a false test only through `||`.
			let decidesTrue = true;
			let decidesFalse = true;
			while (current && current !== handler && !isFunctionNode(current)) {
				if (
					(current.type === "IfStatement" || current.type === "ConditionalExpression") &&
					current.test === child
				) {
					if (contains(current.consequent, clear)) return decidesTrue;
					if (current.alternate && contains(current.alternate, clear))
						return decidesFalse;
					return (
						decidesFalse &&
						current.type === "IfStatement" &&
						current.end <= clear.start &&
						exits(current.consequent)
					);
				}
				if (current.type === "LogicalExpression") {
					// `left && clear` clears only when `left` is true, `left || clear` when it is false.
					if (current.left === child && contains(current.right, clear))
						return current.operator === "&&"
							? decidesTrue
							: current.operator === "||" && decidesFalse;
					if (current.operator !== "&&") decidesTrue = false;
					if (current.operator !== "||") decidesFalse = false;
				}
				child = current;
				current = current.parent;
			}
			return false;
		}

		/** Whether an identity comparison in `handler` decides if `clear` runs. */
		function guarded(handler: FunctionNode, clear: ESTree.Node): boolean {
			let found = false;
			const visit = (node: ESTree.Node) => {
				if (found) return;
				if (
					node.type === "BinaryExpression" &&
					IDENTITY.has(node.operator) &&
					fences(node, clear, handler)
				) {
					found = true;
					return;
				}
				for (const [key, value] of Object.entries(node)) {
					if (key === "parent") continue;
					const children: ReadonlyArray<unknown> = Array.isArray(value) ? value : [value];
					for (const child of children)
						if (child && typeof child === "object" && "type" in child)
							visit(child as ESTree.Node);
				}
			};
			visit(handler.body);
			return found;
		}

		function capturedOutside(target: ESTree.Identifier, handler: FunctionNode): boolean {
			const reference = source
				.getScope(target)
				.references.find((candidate) => candidate.identifier === target);
			const variable = reference?.resolved;
			if (!variable) return false;
			const declared = variable.identifiers[0];
			if (!declared) return false;
			let current: ESTree.Node | null = declared;
			while (current) {
				if (current === handler) return false;
				current = current.parent;
			}
			return true;
		}

		return {
			AssignmentExpression(node) {
				if (node.operator !== "=" || !isEmpty(node.right)) return;
				const handler = cleanupHandler(node);
				if (!handler) return;
				const left = node.left;
				if (left.type === "Identifier") {
					if (!capturedOutside(left, handler)) return;
				} else if (left.type !== "MemberExpression") return;
				// Detaching an event handler (`worker.onmessage = null`) gives up no owner slot.
				else if (
					!left.computed &&
					left.property.type === "Identifier" &&
					/^on[a-z]/.test(left.property.name)
				)
					return;
				const slot = source.getText(left);
				if (guarded(handler, node)) return;
				context.report({ node, messageId: "unguardedClear", data: { slot } });
			},
			CallExpression(node) {
				const set = refCall(node, REF_SET);
				const target = set?.arguments[0];
				if (!target || !isEmpty(set.arguments[1])) return;
				const handler = cleanupHandler(node);
				if (!handler || enclosingFunction(node) === undefined) return;
				if (guarded(handler, node)) return;
				context.report({
					node,
					messageId: "unguardedClear",
					data: { slot: source.getText(target) }
				});
			}
		};
	}
});
