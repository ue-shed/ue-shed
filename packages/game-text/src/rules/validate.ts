import { Predicate, Schema } from "effect";
import { GameTextRuleDocumentError } from "../game-text-rules.js";
import { Expr, RuleDocumentV4 } from "./schema.js";

function invalid(code: "invalid_expression" | "rule_cycle", message: string): never {
	throw new GameTextRuleDocumentError({
		code,
		message,
		retrySafe: false,
		nextStep: "fix_input",
		recovery: "Correct the rule expression, parameters, roles or references and evaluate again."
	});
}

/** Validate internal v4 structure and policy references before submitting it to the compiler. */
export function validateRuleDocument(input: Schema.Json): RuleDocumentV4 {
	const result = Schema.decodeUnknownExit(RuleDocumentV4)(input, { onExcessProperty: "error" });
	if (result._tag === "Failure")
		invalid(
			"invalid_expression",
			"The v4 rule document has an invalid expression or structure."
		);
	const document = result.value;
	const roles = new Set<string>(document.roles.map((role) => role.id));
	if (roles.size !== document.roles.length)
		invalid("invalid_expression", "Role IDs must be unique.");
	const rules = new Map(document.rules.map((rule) => [rule.id, rule]));
	if (rules.size !== document.rules.length)
		invalid("invalid_expression", "Rule IDs must be unique.");
	const graph = new Map<string, Set<string>>();
	for (const rule of document.rules) {
		if (
			(rule.role && !roles.has(rule.role)) ||
			rule.scope?.roles?.some((role) => !roles.has(role))
		)
			invalid("invalid_expression", `Rule ${rule.id} names an undeclared role.`);
		const references = new Set<string>();
		const walk = (expression: Expr): void => {
			if (!Predicate.isObject(expression)) return;
			const [operator, argument] = Object.entries(expression)[0]!;
			if (operator === "lit") return;
			if (operator === "param" && !Object.hasOwn(rule.params ?? {}, String(argument)))
				invalid(
					"invalid_expression",
					`Rule ${rule.id} has no parameter ${String(argument)}.`
				);
			if (operator === "finding" || operator === "findingField") {
				const id =
					"finding" in expression
						? expression.finding
						: "findingField" in expression
							? String(expression.findingField[0])
							: "";
				const dependency = rules.get(id);
				if (dependency && dependency.subject !== rule.subject)
					invalid(
						"invalid_expression",
						`Rule ${rule.id} references a different subject.`
					);
				references.add(id);
			}
			if ("object" in expression) Object.values(expression.object).forEach(walk);
			else if (Schema.is(Schema.Array(Expr))(argument)) argument.forEach(walk);
			else if (
				operator !== "field" &&
				operator !== "param" &&
				operator !== "var" &&
				operator !== "finding"
			)
				if (Schema.is(Expr)(argument)) walk(argument);
		};
		for (const key of [
			"when",
			"actual",
			"expectation",
			"fix",
			"affected",
			"translationOrigin",
			"extra",
			"recovery",
			"each"
		] as const) {
			const expression = rule[key];
			if (expression !== undefined) walk(expression);
		}
		Object.values(rule.let ?? {}).forEach(walk);
		graph.set(rule.id, references);
	}
	const visiting = new Set<string>(),
		visited = new Set<string>();
	const visit = (id: string): void => {
		if (visiting.has(id))
			invalid("rule_cycle", `The rule reference graph contains a cycle at ${id}.`);
		if (visited.has(id)) return;
		visiting.add(id);
		for (const dependency of graph.get(id) ?? []) visit(dependency);
		visiting.delete(id);
		visited.add(id);
	};
	for (const rule of document.rules) visit(rule.id);
	return document;
}
