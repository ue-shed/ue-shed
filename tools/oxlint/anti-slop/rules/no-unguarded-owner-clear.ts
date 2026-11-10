import { defineRule } from "@oxlint/plugins";

import type { ESTree } from "@oxlint/plugins";

import {
	TEST_FILE,
	calleeName,
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

		function guarded(handler: FunctionNode, slot: string | undefined): boolean {
			let found = false;
			const visit = (node: ESTree.Node) => {
				if (found) return;
				if (node.type === "BinaryExpression" && IDENTITY.has(node.operator)) {
					// A ref clear, or a fence such as `generation !== mine` that decides whether to go on.
					if (slot === undefined || isInCondition(node, handler)) {
						found = true;
						return;
					}
					for (const side of [node.left, node.right]) {
						const sideText = source.getText(side);
						if (
							sideText === slot ||
							sideText.startsWith(`${slot}.`) ||
							sideText.startsWith(`${slot}?.`)
						)
							found = true;
					}
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
				if (guarded(handler, slot)) return;
				context.report({ node, messageId: "unguardedClear", data: { slot } });
			},
			CallExpression(node) {
				const set = refCall(node, REF_SET);
				const target = set?.arguments[0];
				if (!target || !isEmpty(set.arguments[1])) return;
				const handler = cleanupHandler(node);
				if (!handler || enclosingFunction(node) === undefined) return;
				if (guarded(handler, undefined)) return;
				context.report({
					node,
					messageId: "unguardedClear",
					data: { slot: source.getText(target) }
				});
			}
		};
	}
});
