import { defineRule } from "@oxlint/plugins";

import type { ESTree, Scope } from "@oxlint/plugins";

import {
	TEST_FILE,
	effectBodyCall,
	enclosingFunction,
	isFunctionNode,
	isInCondition,
	refCall,
	type FunctionNode
} from "../shared/effect-ownership.ts";

const REF_GET = new Set(["get"]);
const REF_SET = new Set(["set", "getAndSet"]);

type Mark = { readonly key: string; readonly pos: number };
type Write = Mark & { readonly node: ESTree.Node };
type Body = {
	readonly yields: Array<{ readonly start: number; readonly end: number }>;
	readonly tests: Array<Mark>;
	readonly writes: Array<Write>;
	/** `const s = yield* Ref.get(ref)`: snapshot name → ref key. */
	readonly snapshots: Map<string, string>;
};

/** A yield inside `return …` or `throw …` leaves the body; it never reaches a later write. */
function leavesBody(node: ESTree.Node): boolean {
	let current: ESTree.Node | null = node.parent;
	while (current && !isFunctionNode(current)) {
		if (current.type === "ReturnStatement" || current.type === "ThrowStatement") return true;
		current = current.parent;
	}
	return false;
}

/**
 * Reports an Effect body that tests shared state, yields, then writes that state: another fiber
 * can change it during the yield, so the write acts on a stale check. Shared state is a `let` from
 * an enclosing function or a Ref read with `Ref.get`. A body run under a Semaphore permit is exempt.
 */
export const noCheckYieldWriteRule = defineRule({
	meta: {
		type: "problem",
		docs: {
			description:
				"Disallow testing shared state, yielding, then writing it in an Effect body; make the decision and the write one atomic step."
		},
		messages: {
			checkYieldWrite:
				"This Effect body tests `{{state}}`, yields, then writes it. Another fiber can change it during the yield, so the write acts on a stale check. " +
				"Make the decision and the write one step: Ref.modify (or SynchronizedRef.modifyEffect) returning the decision, " +
				"a FiberHandle when a newer run should replace an older one, or run the body under a Semaphore permit. " +
				"If no other fiber can reach this state, disable the line with the reason."
		}
	},
	create(context) {
		if (TEST_FILE.test(context.filename)) return {};
		const source = context.sourceCode;
		const bodies = new Map<FunctionNode, Body>();
		const text = (node: ESTree.Node) => source.getText(node);

		function serialized(call: ESTree.CallExpression, body: FunctionNode): boolean {
			if (
				call.arguments.some(
					(argument) => argument !== body && text(argument).includes("withPermit")
				)
			)
				return true;
			const parent = call.parent;
			if (parent?.type === "MemberExpression" && parent.object === call) {
				const pipe = parent.parent;
				return (
					pipe?.type === "CallExpression" &&
					pipe.callee === parent &&
					pipe.arguments.some((argument) => text(argument).includes("withPermit"))
				);
			}
			return (
				parent?.type === "CallExpression" &&
				parent.arguments.includes(call) &&
				text(parent.callee).includes("withPermit")
			);
		}

		function bodyOf(node: ESTree.Node): { fn: FunctionNode; body: Body } | undefined {
			const fn = enclosingFunction(node);
			const body = fn ? bodies.get(fn) : undefined;
			return fn && body ? { fn, body } : undefined;
		}

		/** References made directly in `fn`, including its block scopes but not nested functions. */
		function referencesOf(scope: Scope, into: Array<Scope["references"][number]>) {
			into.push(...scope.references);
			for (const child of scope.childScopes)
				if (child.variableScope === scope.variableScope) referencesOf(child, into);
			return into;
		}

		function isLet(variable: NonNullable<Scope["references"][number]["resolved"]>): boolean {
			const declarator = variable.identifiers[0]?.parent;
			return (
				declarator?.type === "VariableDeclarator" &&
				declarator.parent?.type === "VariableDeclaration" &&
				declarator.parent.kind === "let"
			);
		}

		return {
			FunctionExpression(node) {
				const call = effectBodyCall(node);
				if (!call || serialized(call, node)) return;
				bodies.set(node, { yields: [], tests: [], writes: [], snapshots: new Map() });
			},
			YieldExpression(node) {
				if (!node.delegate || leavesBody(node)) return;
				bodyOf(node)?.body.yields.push({ start: node.start, end: node.end });
			},
			VariableDeclarator(node) {
				const init = node.init;
				if (
					node.id.type !== "Identifier" ||
					init?.type !== "YieldExpression" ||
					!init.argument
				)
					return;
				const get = refCall(init.argument, REF_GET);
				const first = get?.arguments[0];
				if (!first) return;
				bodyOf(node)?.body.snapshots.set(node.id.name, `ref:${text(first)}`);
			},
			CallExpression(node) {
				const owner = bodyOf(node);
				if (!owner) return;
				const get = refCall(node, REF_GET);
				const getTarget = get?.arguments[0];
				if (getTarget && isInCondition(node, owner.fn))
					owner.body.tests.push({ key: `ref:${text(getTarget)}`, pos: node.start });
				const set = refCall(node, REF_SET);
				const setTarget = set?.arguments[0];
				if (setTarget)
					owner.body.writes.push({
						key: `ref:${text(setTarget)}`,
						pos: node.start,
						node
					});
			},
			"Program:exit"() {
				for (const [fn, body] of bodies) {
					const scope = source.getScope(fn);
					for (const reference of referencesOf(scope, [])) {
						const variable = reference.resolved;
						if (!variable) continue;
						const identifier = reference.identifier;
						const snapshot = body.snapshots.get(variable.name);
						if (snapshot && variable.scope.variableScope === scope.variableScope) {
							if (reference.isRead() && isInCondition(identifier, fn))
								body.tests.push({ key: snapshot, pos: identifier.start });
							continue;
						}
						if (
							!isLet(variable) ||
							variable.scope.variableScope === scope.variableScope
						)
							continue;
						const key = `let:${variable.name}`;
						if (reference.isRead() && isInCondition(identifier, fn))
							body.tests.push({ key, pos: identifier.start });
						if (reference.isWrite() && !reference.init && identifier.parent)
							body.writes.push({
								key,
								pos: identifier.parent.end,
								node: identifier.parent
							});
					}
					const reported = new Set<ESTree.Node>();
					for (const write of body.writes) {
						if (reported.has(write.node)) continue;
						const stale = body.tests.some(
							(test) =>
								test.key === write.key &&
								test.pos < write.pos &&
								body.yields.some(
									(step) => step.start > test.pos && step.end <= write.pos
								)
						);
						if (!stale) continue;
						reported.add(write.node);
						context.report({
							node: write.node,
							messageId: "checkYieldWrite",
							data: { state: write.key.slice(4) }
						});
					}
				}
			}
		};
	}
});
