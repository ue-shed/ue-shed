import { Effect, Schema, Struct } from "effect";
import { CultureCode } from "@ue-shed/localization/browser";
import { BuiltInCheckId, CheckSeverity } from "./localization-check-ids.js";
import { LocalizationCheckScope } from "./localization-check-scope.js";
import {
	localizationCheckCatalogue,
	localizationCheckDefaults,
	type LocalizationCheckCatalogue,
	type LocalizationCheckParams
} from "./localization-check-catalogue.js";
import {
	TextQualityRule,
	TextQualityRuleId,
	TextQualityRuleDocument,
	TextQualityReport,
	TextRole,
	decodeTextQualityRuleDocument
} from "./quality-schema.js";
import type { TextCorpus } from "./schema.js";
import { evaluateTextQuality } from "./quality.js";

const [Budget, Terminology] = TextQualityRule.members;
export const LocalizationProjectRule = Schema.Union([
	Budget.mapFields(({ maximumCharacters, ...fields }) => ({
		...fields,
		/** The severity of the rule's findings; absent, `normal`. */
		severity: Schema.optionalKey(CheckSeverity),
		kind: Schema.Literal("localization_character_budget"),
		cultures: Schema.Record(CultureCode, maximumCharacters),
		defaultMaximumCharacters: Schema.optionalKey(maximumCharacters)
	})),
	Terminology.mapFields(({ terms, ...fields }) => ({
		...fields,
		/** The severity of the rule's findings; absent, `normal`. */
		severity: Schema.optionalKey(CheckSeverity),
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
function checkSetting<Params extends Schema.Top>(params: Params) {
	return Schema.Struct({
		/** Whether the check runs; absent, the preset decides. */
		enabled: Schema.optionalKey(Schema.Boolean),
		/** The severity of the check's findings; absent, the catalogue's. */
		severity: Schema.optionalKey(CheckSeverity),
		scope: Schema.optionalKey(LocalizationCheckScope),
		/** Parameters over the catalogue's defaults; unlisted fields keep their default. */
		params: Schema.optionalKey(params)
	});
}
type CheckSettingFields = {
	readonly [Id in BuiltInCheckId]: Schema.optionalKey<
		ReturnType<typeof checkSetting<LocalizationCheckCatalogue[Id]["params"]>>
	>;
};
// SAFETY: one optional setting per `BuiltInCheckId`, each with that check's catalogue parameters.
// Verified by: localization-check-settings.test.ts — resolves every check's own parameter schema and defaults.
const checkSettingFields = Object.fromEntries(
	BuiltInCheckId.literals.map((id) => [
		id,
		Schema.optionalKey(checkSetting(localizationCheckCatalogue[id].params))
	])
) as CheckSettingFields;

/** A version-3 rule file's settings for the built-in checks, by check ID. */
export const LocalizationCheckSettings = Schema.Struct(checkSettingFields);
export type LocalizationCheckSettings = typeof LocalizationCheckSettings.Type;

/**
 * Where checks start before the rule file's settings: `default` runs every built-in check with
 * the catalogue's severity (and `segment_separator` once it has a separator); `none` runs only the
 * checks the file enables.
 */
export const LocalizationCheckPreset = Schema.Literals(["default", "none"]);
export type LocalizationCheckPreset = typeof LocalizationCheckPreset.Type;

const CustomCheckBase = {
	/** The rule ID its findings and review marks record; unique among the file's rules. */
	id: TextQualityRuleId,
	/** A short name for lists and filters. */
	label: Schema.Trim.check(Schema.isNonEmpty(), Schema.isMaxLength(128)),
	/** The severity of its findings; absent, `normal`. */
	severity: Schema.optionalKey(CheckSeverity),
	scope: Schema.optionalKey(LocalizationCheckScope),
	/**
	 * `source` checks a keyed line's source once, under its source culture; `translation` checks
	 * each culture's shipped translation, the native culture aside.
	 */
	subject: Schema.Literals(["source", "translation"]),
	recovery: Schema.Trim.check(Schema.isNonEmpty(), Schema.isMaxLength(2048))
};
const CustomTerm = Schema.Trim.check(Schema.isNonEmpty(), Schema.isMaxLength(1024));

/**
 * A check the project defines. `pattern` reports text a JavaScript regular expression (Unicode
 * mode) matches, or with `report: "no_match"` text it does not match; `length` reports text
 * shorter than `minimum` or longer than `maximum`, in `visible` characters (rich text, modifiers
 * and arguments removed, wide characters counted twice, as `length_outlier` measures) or code
 * point `characters`; `forbidden_term` reports text that uses one of `terms`, matched as the
 * terminology rules match them. Each is scoped by culture, role and object path like the
 * built-in checks.
 */
export const CustomLocalizationCheck = Schema.Union([
	Schema.Struct({
		...CustomCheckBase,
		kind: Schema.Literal("pattern"),
		pattern: Schema.String.check(Schema.isNonEmpty(), Schema.isMaxLength(1024)),
		caseSensitive: Schema.optionalKey(Schema.Boolean),
		report: Schema.optionalKey(Schema.Literals(["match", "no_match"]))
	}),
	Schema.Struct({
		...CustomCheckBase,
		kind: Schema.Literal("length"),
		measure: Schema.Literals(["visible", "characters"]),
		minimum: Schema.optionalKey(Schema.Int.check(Schema.isGreaterThan(0))),
		maximum: Schema.optionalKey(Schema.Int.check(Schema.isGreaterThan(0)))
	}),
	Schema.Struct({
		...CustomCheckBase,
		kind: Schema.Literal("forbidden_term"),
		terms: Schema.Array(CustomTerm).check(Schema.isMinLength(1), Schema.isMaxLength(256)),
		caseSensitive: Schema.Boolean
	})
]);
export type CustomLocalizationCheck = typeof CustomLocalizationCheck.Type;

/** Whether a custom check is usable: a compiling pattern, a length with a bound in order. */
function validCustomCheck(check: CustomLocalizationCheck): boolean {
	if (check.id.startsWith("localization.")) return false;
	switch (check.kind) {
		case "pattern":
			try {
				new RegExp(check.pattern, "u");
				return true;
			} catch {
				return false;
			}
		case "length":
			return (
				(check.minimum !== undefined || check.maximum !== undefined) &&
				(check.minimum ?? 0) <= (check.maximum ?? Number.MAX_SAFE_INTEGER)
			);
		case "forbidden_term":
			return true;
	}
}

/**
 * V3 keeps v2's roles, source rules and localization rules and moves every built-in check's
 * policy into `checks`: whether it runs, its severity, its scope and its parameters. The v1 and
 * v2 fields `disabledLocalizationChecks`, `segmentSeparator`, `optionalTags` and
 * `optionalArguments` become check settings. A file may hold only check settings.
 */
export const TextQualityRuleDocumentV3 = TextQualityRuleDocumentV2.mapFields(
	Struct.omit([
		"disabledLocalizationChecks",
		"segmentSeparator",
		"optionalTags",
		"optionalArguments"
	])
).mapFields((fields) => ({
	...fields,
	schemaVersion: Schema.Literal(3),
	preset: Schema.optionalKey(LocalizationCheckPreset),
	roles: Schema.Array(TextRole).check(Schema.isMaxLength(256)),
	localizationRules: Schema.optionalKey(
		Schema.Array(LocalizationProjectRule).check(Schema.isMaxLength(512))
	),
	checks: Schema.optionalKey(LocalizationCheckSettings),
	/** Checks the project defines, reported beside the built-in ones. */
	customChecks: Schema.optionalKey(
		Schema.Array(CustomLocalizationCheck).check(Schema.isMaxLength(512))
	)
}));
export type TextQualityRuleDocumentV3 = typeof TextQualityRuleDocumentV3.Type;

export const GameTextRuleDocument = Schema.Union([
	TextQualityRuleDocument,
	TextQualityRuleDocumentV2,
	TextQualityRuleDocumentV3
]);
export type GameTextRuleDocument = typeof GameTextRuleDocument.Type;

export class GameTextRuleDocumentError extends Schema.TaggedError<GameTextRuleDocumentError>()(
	"GameTextRuleDocumentError",
	{
		retrySafe: Schema.Boolean,
		nextStep: Schema.Literals(["fix_input", "retry", "reconcile", "escalate"]),
		cause: Schema.optionalKey(Schema.Defect()),
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

function invalid(
	code: GameTextRuleDocumentError["code"],
	cause?: unknown
): GameTextRuleDocumentError {
	if (code === "invalid_json")
		return new GameTextRuleDocumentError({
			...(cause === undefined ? undefined : { cause }),
			retrySafe: false,
			nextStep: "fix_input",
			code,
			message: "The Game Text quality rule file is not valid JSON.",
			recovery:
				"Correct the JSON syntax and retry with a version-1, version-2 or version-3 rule document."
		});
	return new GameTextRuleDocumentError({
		...(cause === undefined ? undefined : { cause }),
		retrySafe: false,
		nextStep: "fix_input",
		code,
		message: "The Game Text rule document could not be validated.",
		recovery:
			"Use version 1, 2 or 3, unique role/rule/culture keys, non-empty terms, positive budgets, valid check parameters, and declared roles (scopes included)."
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
	return Effect.gen(function* () {
		const json = yield* Schema.decodeUnknownEffect(Schema.fromJsonString(Schema.Json))(
			input
		).pipe(Effect.mapError((cause) => invalid("invalid_json", cause)));
		const decoded = yield* Schema.decodeUnknownEffect(GameTextRuleDocument)(json).pipe(
			Effect.mapError((cause) => invalid("invalid_structure", cause))
		);
		// Version 3 rejects unknown keys, so a misspelt check or parameter is not ignored.
		const document =
			decoded.schemaVersion === 3
				? yield* Schema.decodeUnknownEffect(TextQualityRuleDocumentV3)(json, {
						onExcessProperty: "error"
					}).pipe(Effect.mapError((cause) => invalid("invalid_structure", cause)))
				: decoded;
		if (document.schemaVersion === 1)
			return yield* decodeTextQualityRuleDocument(document).pipe(
				Effect.mapError((error) => invalid(error.code, error))
			);
		if (duplicateCultureKey(input)) return yield* Effect.fail(invalid("duplicate_culture_key"));
		const custom = document.schemaVersion === 3 ? (document.customChecks ?? []) : [];
		if (!custom.every(validCustomCheck))
			return yield* Effect.fail(invalid("invalid_structure"));
		const rules = [...document.rules, ...(document.localizationRules ?? [])];
		if (rules.length === 0 && document.schemaVersion === 2)
			return yield* Effect.fail(invalid("invalid_structure"));
		const roles = new Set(document.roles.map((role) => role.id));
		if (roles.size !== document.roles.length)
			return yield* Effect.fail(invalid("duplicate_role_id"));
		const ids = [...rules, ...custom].map((rule) => rule.id);
		if (new Set(ids).size !== ids.length)
			return yield* Effect.fail(invalid("duplicate_rule_id"));
		const scopeRoles =
			document.schemaVersion === 3
				? [...Object.values(document.checks ?? {}), ...custom].flatMap(
						(setting) => setting?.scope?.roles ?? []
					)
				: [];
		if (
			rules.some((rule) => !roles.has(rule.role)) ||
			scopeRoles.some((role) => !roles.has(role))
		)
			return yield* Effect.fail(invalid("unknown_role_id"));
		return document;
	});
}

export const GameTextSourceQualityReport = TextQualityReport.mapFields((fields) => ({
	...fields,
	ruleDocumentVersion: Schema.Literals([1, 2, 3])
}));
export type GameTextSourceQualityReport = typeof GameTextSourceQualityReport.Type;
/** Source evaluation keeps v1 behavior; translation policy requires a selected target's join. */
export function evaluateGameTextSourceQuality(
	corpus: TextCorpus,
	document: GameTextRuleDocument
): GameTextSourceQualityReport {
	if (document.schemaVersion === 1) return evaluateTextQuality(corpus, document);
	const report = evaluateTextQuality(corpus, {
		roles: document.roles,
		rules: document.rules,
		schemaVersion: 1
	});
	return { ...report, ruleDocumentVersion: document.schemaVersion };
}

/** One built-in check as a rule file resolves it. */
export interface ResolvedLocalizationCheck<Id extends BuiltInCheckId = BuiltInCheckId> {
	readonly enabled: boolean;
	readonly severity: CheckSeverity;
	readonly scope?: LocalizationCheckScope | undefined;
	readonly params: LocalizationCheckParams[Id];
}
/** Every built-in check as a rule file resolves it. */
export type ResolvedLocalizationChecks = {
	readonly [Id in BuiltInCheckId]: ResolvedLocalizationCheck<Id>;
};

const resolvedCache = new WeakMap<GameTextRuleDocument, ResolvedLocalizationChecks>();

/**
 * Each built-in check's settings under a rule file: v3 `checks` over its preset, or the v1 and v2
 * fields as their v3 equivalents. Without a file, every check runs with the catalogue's severity
 * and defaults. `segment_separator` runs only once it has a separator. Resolved once per document.
 */
export function resolveLocalizationChecks(
	document: GameTextRuleDocument | undefined
): ResolvedLocalizationChecks {
	const cached = document && resolvedCache.get(document);
	if (cached) return cached;
	const settings: LocalizationCheckSettings =
		document === undefined
			? {}
			: document.schemaVersion === 3
				? (document.checks ?? {})
				: legacyCheckSettings(document);
	const presetEnabled = document?.schemaVersion !== 3 || document.preset !== "none";
	const separated = settings.segment_separator?.params?.separator !== undefined;
	// SAFETY: one entry per `BuiltInCheckId`, each with that check's catalogue parameters.
	// Verified by: localization-check-settings.test.ts — resolves every check's own parameter schema and defaults.
	const resolved = Object.fromEntries(
		BuiltInCheckId.literals.map((id) => {
			const setting = settings[id];
			const params = setting?.params ?? localizationCheckDefaults[id];
			const enabled =
				(setting?.enabled ?? presetEnabled) && (id !== "segment_separator" || separated);
			return [
				id,
				{
					enabled,
					severity: setting?.severity ?? localizationCheckCatalogue[id].severity,
					...(setting?.scope ? { scope: setting.scope } : undefined),
					params
				}
			];
		})
	) as ResolvedLocalizationChecks;
	if (document) resolvedCache.set(document, resolved);
	return resolved;
}

/** The v1 and v2 check fields as v3 check settings, as `migrateGameTextRuleDocument` writes them. */
function legacyCheckSettings(document: TextQualityRuleDocument | TextQualityRuleDocumentV2) {
	const settings: { -readonly [Id in BuiltInCheckId]?: LocalizationCheckSettings[Id] } = {};
	for (const id of document.disabledLocalizationChecks ?? []) settings[id] = { enabled: false };
	const optionalArguments = document.optionalArguments ?? [];
	const optionalTags = document.optionalTags ?? [];
	const withParams = <Id extends BuiltInCheckId>(id: Id, params: LocalizationCheckParams[Id]) => {
		// SAFETY: `params` are check `Id`'s, so the setting is that check's setting.
		// Verified by: localization-check-settings.test.ts — reads v1 and v2 check fields as their v3 settings and migrates them unchanged.
		settings[id] = { ...settings[id], params } as LocalizationCheckSettings[Id];
	};
	if (document.segmentSeparator !== undefined)
		withParams("segment_separator", { separator: document.segmentSeparator });
	if (optionalArguments.length) {
		withParams("format_arguments", { optionalArguments });
		withParams("format_argument_renamed", { optionalArguments });
		withParams("rich_text_tag_case", { optionalArguments });
	}
	if (optionalArguments.length || optionalTags.length) {
		withParams("rich_text_tags", { optionalTags, optionalArguments });
		withParams("rich_text_tags_added", { optionalTags, optionalArguments });
	}
	return settings;
}

/**
 * A v1 or v2 rule file as version 3, with the same roles, rules and check behaviour; a v3 file
 * is returned as it is. Hosts that edit rule files can offer it as an upgrade.
 */
export function migrateGameTextRuleDocument(
	document: GameTextRuleDocument
): TextQualityRuleDocumentV3 {
	if (document.schemaVersion === 3) return document;
	const checks = legacyCheckSettings(document);
	return {
		schemaVersion: 3,
		roles: document.roles,
		rules: document.rules,
		...(document.schemaVersion === 2 && document.localizationRules
			? { localizationRules: document.localizationRules }
			: undefined),
		...(Object.keys(checks).length ? { checks } : undefined)
	};
}
