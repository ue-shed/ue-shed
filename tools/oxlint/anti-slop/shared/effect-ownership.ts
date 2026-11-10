import type { ESTree } from "@oxlint/plugins";

/** A function boundary: state written inside one is written by whoever runs it, later. */
export type FunctionNode =
	| ESTree.ArrowFunctionExpression
	| ESTree.FunctionExpression
	| ESTree.FunctionDeclaration;

export const TEST_FILE =
	/\.(?:test|spec|testkit)\.[cm]?[jt]sx?$|\.test-support\.[cm]?[jt]sx?$|[\\/](?:tests?|__tests__|testkit|testing|fixtures|integration|e2e)[\\/]/;

export function isFunctionNode(node: ESTree.Node | null | undefined): node is FunctionNode {
	return (
		node?.type === "ArrowFunctionExpression" ||
		node?.type === "FunctionExpression" ||
		node?.type === "FunctionDeclaration"
	);
}

/** The innermost function that contains `node`, or undefined at module level. */
export function enclosingFunction(node: ESTree.Node): FunctionNode | undefined {
	let current: ESTree.Node | null = node.parent;
	while (current) {
		if (isFunctionNode(current)) return current;
		current = current.parent;
	}
	return undefined;
}

/** `Effect.<name>`, by member name. */
export function effectMember(node: ESTree.Node, names: ReadonlySet<string>): boolean {
	return (
		node.type === "MemberExpression" &&
		!node.computed &&
		node.object.type === "Identifier" &&
		node.object.name === "Effect" &&
		node.property.type === "Identifier" &&
		names.has(node.property.name)
	);
}

const GENERATOR_RUNNERS = new Set(["gen", "fn", "fnUntraced"]);

/** The call that runs `fn` as an Effect body: `Effect.gen(fn)`, `Effect.fn(fn)`, `Effect.fn("x")(fn)`. */
export function effectBodyCall(fn: FunctionNode): ESTree.CallExpression | undefined {
	if (fn.type === "ArrowFunctionExpression" || !fn.generator) return undefined;
	const call = fn.parent;
	if (call?.type !== "CallExpression" || !call.arguments.includes(fn)) return undefined;
	const callee = call.callee;
	if (effectMember(callee, GENERATOR_RUNNERS)) return call;
	if (callee.type === "CallExpression" && effectMember(callee.callee, GENERATOR_RUNNERS))
		return call;
	return undefined;
}

/** The name of a call's callee: `name(...)` or `x.name(...)`. */
export function calleeName(call: ESTree.CallExpression): string | undefined {
	const callee = call.callee;
	if (callee.type === "Identifier") return callee.name;
	if (
		callee.type === "MemberExpression" &&
		!callee.computed &&
		callee.property.type === "Identifier"
	)
		return callee.property.name;
	return undefined;
}

const REF_MODULES = new Set(["Ref", "SubscriptionRef", "SynchronizedRef"]);

/** `Ref.<op>(ref, …)` for one of `ops`, returning the call. */
export function refCall(
	node: ESTree.Node,
	ops: ReadonlySet<string>
): ESTree.CallExpression | undefined {
	if (node.type !== "CallExpression") return undefined;
	const callee = node.callee;
	if (
		callee.type === "MemberExpression" &&
		!callee.computed &&
		callee.object.type === "Identifier" &&
		REF_MODULES.has(callee.object.name) &&
		callee.property.type === "Identifier" &&
		ops.has(callee.property.name) &&
		node.arguments.length > 0
	)
		return node;
	return undefined;
}

/** Whether `node` sits in the condition of an `if`, `?:`, loop or `&&`/`||` guard. */
export function isInCondition(node: ESTree.Node, stop: ESTree.Node): boolean {
	let child: ESTree.Node = node;
	let current: ESTree.Node | null = node.parent;
	while (current && current !== stop) {
		if (isFunctionNode(current)) return false;
		switch (current.type) {
			case "IfStatement":
			case "ConditionalExpression":
			case "WhileStatement":
			case "DoWhileStatement":
			case "ForStatement":
				if (current.test === child) return true;
				break;
			case "LogicalExpression":
				if (current.left === child) return true;
				break;
			default:
				break;
		}
		child = current;
		current = current.parent;
	}
	return false;
}
