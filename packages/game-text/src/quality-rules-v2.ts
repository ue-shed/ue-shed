import { Effect, Schema } from "effect";
import { CultureCode } from "@ue-shed/localization/browser";
import {
	TextQualityRule,
	TextQualityRuleDocument,
	TextQualityReport,
	decodeTextQualityRuleDocument
} from "./quality-schema.js";
import type { TextCorpus } from "./schema.js";
import { evaluateTextQuality } from "./quality.js";

const [Budget, Terminology] = TextQualityRule.members;
export const LocalizationProjectRule = Schema.Union([
	Budget.mapFields(({ maximumCharacters, ...fields }) => ({
		...fields,
		kind: Schema.Literal("localization_character_budget"),
		cultures: Schema.Record(CultureCode, maximumCharacters),
		defaultMaximumCharacters: Schema.optionalKey(maximumCharacters)
	})),
	Terminology.mapFields(({ terms, ...fields }) => ({
		...fields,
		kind: Schema.Literal("localization_terminology"),
		cultures: Schema.Record(CultureCode, terms)
	}))
]);
export type LocalizationProjectRule = typeof LocalizationProjectRule.Type;

/** V1 owns source rules and role semantics; v2 adds translation policy without changing them. */
export const TextQualityRuleDocumentV2 = TextQualityRuleDocument.mapFields((fields) => ({
	...fields,
	schemaVersion: Schema.Literal(2),
	rules: Schema.Array(TextQualityRule).check(Schema.isMaxLength(512)),
	localizationRules: Schema.optionalKey(
		Schema.Array(LocalizationProjectRule).check(Schema.isMinLength(1), Schema.isMaxLength(512))
	)
}));
export type TextQualityRuleDocumentV2 = typeof TextQualityRuleDocumentV2.Type;
export const GameTextRuleDocument = Schema.Union([
	TextQualityRuleDocument,
	TextQualityRuleDocumentV2
]);
export type GameTextRuleDocument = typeof GameTextRuleDocument.Type;

export class GameTextRuleDocumentError extends Schema.TaggedErrorClass<GameTextRuleDocumentError>()(
	"GameTextRuleDocumentError",
	{
		code: Schema.Literals([
			"invalid_json",
			"invalid_structure",
			"duplicate_culture_key",
			"duplicate_role_id",
			"duplicate_rule_id",
			"unknown_role_id"
		]),
		message: Schema.String,
		recovery: Schema.String
	}
) {}

function invalid(code: GameTextRuleDocumentError["code"]): GameTextRuleDocumentError {
	if (code === "invalid_json")
		return new GameTextRuleDocumentError({
			code,
			message: "The Game Text quality rule file is not valid JSON.",
			recovery:
				"Correct the JSON syntax and retry with a version-1 or version-2 rule document."
		});
	return new GameTextRuleDocumentError({
		code,
		message: "The Game Text rule document could not be validated.",
		recovery:
			"Use version 1 or 2, unique role/rule/culture keys, non-empty terms, positive budgets, and declared roles."
	});
}

/** Called only after JSON/schema validation: inspect keys before JSON loses duplicates. */
function duplicateCultureKey(input: string): boolean {
	const stack: Array<{ keys: Set<string>; cultures: boolean }> = [];
	let pendingKey = "";
	for (let index = 0; index < input.length; index++) {
		const character = input[index];
		if (character === '"') {
			const start = index++;
			while (index < input.length) {
				if (input[index] === "\\") index += 2;
				else if (input[index] === '"') break;
				else index++;
			}
			let next = index + 1;
			while (/\s/u.test(input[next] ?? "") && next < input.length) next++;
			if (input[next] === ":") {
				pendingKey = Schema.decodeUnknownSync(Schema.fromJsonString(Schema.String))(
					input.slice(start, index + 1)
				);
				const current = stack.at(-1);
				if (current?.cultures && current.keys.has(pendingKey)) return true;
				current?.keys.add(pendingKey);
			}
		} else if (character === "{") {
			stack.push({ keys: new Set(), cultures: pendingKey === "cultures" });
			pendingKey = "";
		} else if (character === "}") stack.pop();
	}
	return false;
}

export function decodeGameTextRuleDocumentJson(
	input: string
): Effect.Effect<GameTextRuleDocument, GameTextRuleDocumentError> {
	return Schema.decodeUnknownEffect(Schema.fromJsonString(Schema.Json))(input).pipe(
		Effect.mapError(() => invalid("invalid_json")),
		Effect.flatMap((json) =>
			Schema.decodeUnknownEffect(GameTextRuleDocument)(json).pipe(
				Effect.mapError(() => invalid("invalid_structure"))
			)
		),
		Effect.flatMap(
			(document): Effect.Effect<GameTextRuleDocument, GameTextRuleDocumentError> => {
				if (document.schemaVersion === 1)
					return decodeTextQualityRuleDocument(document).pipe(
						Effect.mapError((error) => invalid(error.code))
					);
				if (duplicateCultureKey(input))
					return Effect.fail(invalid("duplicate_culture_key"));
				const rules = [...document.rules, ...(document.localizationRules ?? [])];
				if (rules.length === 0) return Effect.fail(invalid("invalid_structure"));
				const roles = new Set(document.roles.map((role) => role.id));
				if (roles.size !== document.roles.length)
					return Effect.fail(invalid("duplicate_role_id"));
				if (new Set(rules.map((rule) => rule.id)).size !== rules.length)
					return Effect.fail(invalid("duplicate_rule_id"));
				if (rules.some((rule) => !roles.has(rule.role)))
					return Effect.fail(invalid("unknown_role_id"));
				return Effect.succeed(document);
			}
		)
	);
}

export const GameTextSourceQualityReport = TextQualityReport.mapFields((fields) => ({
	...fields,
	ruleDocumentVersion: Schema.Literals([1, 2])
}));
export type GameTextSourceQualityReport = typeof GameTextSourceQualityReport.Type;
/** Source evaluation keeps v1 behavior; translation policy requires a selected target's join. */
export function evaluateGameTextSourceQuality(
	corpus: TextCorpus,
	document: GameTextRuleDocument
): GameTextSourceQualityReport {
	if (document.schemaVersion === 1) return evaluateTextQuality(corpus, document);
	const report = evaluateTextQuality(corpus, { ...document, schemaVersion: 1 });
	return { ...report, ruleDocumentVersion: 2 };
}
