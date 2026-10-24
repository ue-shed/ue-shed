import { Effect, Schema } from "effect";
import { CultureCode } from "@ue-shed/localization/browser";
import { BuiltInCheckId, CheckSeverity } from "./localization-check-ids.js";
import { LocalizationCheckScope } from "./localization-check-scope.js";
import { engineRunsPattern } from "./rule-regex.js";
import {
	localizationCheckCatalogue,
	localizationCheckDefaults,
	type LocalizationCheckParams
} from "./localization-check-catalogue.js";
import {
	TextQualityReport,
	TextQualityRuleId,
	TextRole,
	TextRoleId,
	TextTerminologyEntry
} from "./quality-schema.js";

const Recovery = Schema.Trim.check(Schema.isNonEmpty(), Schema.isMaxLength(2048));
const MaximumCharacters = Schema.Int.check(Schema.isGreaterThan(0));
const Terms = Schema.Array(TextTerminologyEntry).check(
	Schema.isMinLength(1),
	Schema.isMaxLength(256)
);
/** What every entry may set. */
const EntryFields = {
	/** Whether the rule runs; absent, it does. */
	enabled: Schema.optionalKey(Schema.Boolean),
	scope: Schema.optionalKey(LocalizationCheckScope)
};
/** What every project rule has. */
const RuleFields = {
	...EntryFields,
	/** The rule ID its findings and review marks record; unique among the file's rules. */
	id: TextQualityRuleId,
	/** What to do about a finding, shown with it. */
	recovery: Recovery
};
const Severity = {
	/** The severity of the rule's findings; absent, `normal`. */
	severity: Schema.optionalKey(CheckSeverity)
};

function builtInCheckEntry<Id extends BuiltInCheckId>(id: Id) {
	return Schema.Struct({
		kind: Schema.Literal(id),
		...EntryFields,
		/** The severity of the check's findings; absent, the catalogue's. */
		severity: Schema.optionalKey(CheckSeverity),
		/** Parameters over the catalogue's defaults; unlisted fields keep their default. */
		params: Schema.optionalKey(localizationCheckCatalogue[id].params)
	});
}
type BuiltInCheckEntrySchemas = {
	readonly [Id in BuiltInCheckId]: ReturnType<typeof builtInCheckEntry<Id>>;
};
// SAFETY: one schema per `BuiltInCheckId`, each with that check's catalogue parameters.
// Verified by: game-text-rules.test.ts — "decodes each built-in check with its own parameters".
const builtInCheckEntries = BuiltInCheckId.literals.map(builtInCheckEntry) as ReadonlyArray<
	BuiltInCheckEntrySchemas[BuiltInCheckId]
>;

/** A built-in check the file runs, named by its ID, with the file's settings for it. */
export const BuiltInCheckEntry = Schema.Union(builtInCheckEntries);
export type BuiltInCheckEntry = typeof BuiltInCheckEntry.Type;

/**
 * A role's source rule: a character budget in UTF-16 code units, or terminology. It checks each
 * text unit with a saved place of its role, once, without a localization target.
 */
export const TextQualityRule = Schema.Union([
	Schema.Struct({
		kind: Schema.Literal("character_budget"),
		...RuleFields,
		role: TextRoleId,
		maximumCharacters: MaximumCharacters
	}),
	Schema.Struct({
		kind: Schema.Literal("terminology"),
		...RuleFields,
		role: TextRoleId,
		caseSensitive: Schema.Boolean,
		terms: Terms
	})
]);
export type TextQualityRule = typeof TextQualityRule.Type;

/**
 * A role's localization rule: a character budget per culture, or terminology per culture, for each
 * culture's shipped translation.
 */
export const LocalizationProjectRule = Schema.Union([
	Schema.Struct({
		kind: Schema.Literal("localization_character_budget"),
		...RuleFields,
		...Severity,
		role: TextRoleId,
		cultures: Schema.Record(CultureCode, MaximumCharacters),
		defaultMaximumCharacters: Schema.optionalKey(MaximumCharacters)
	}),
	Schema.Struct({
		kind: Schema.Literal("localization_terminology"),
		...RuleFields,
		...Severity,
		role: TextRoleId,
		caseSensitive: Schema.Boolean,
		cultures: Schema.Record(CultureCode, Terms)
	})
]);
export type LocalizationProjectRule = typeof LocalizationProjectRule.Type;

const CustomCheckFields = {
	...RuleFields,
	...Severity,
	/** A short name for lists and filters. */
	label: Schema.Trim.check(Schema.isNonEmpty(), Schema.isMaxLength(128)),
	/**
	 * `source` checks a keyed line's source once, under its source culture; `translation` checks
	 * each culture's shipped translation, the native culture aside.
	 */
	subject: Schema.Literals(["source", "translation"])
};
const CustomTerm = Schema.Trim.check(Schema.isNonEmpty(), Schema.isMaxLength(1024));

/**
 * A check the project defines. `pattern` reports text a JavaScript regular expression (Unicode
 * mode) matches, or with `report: "no_match"` text it does not match; a lookbehind in it must have a
 * fixed width, or be an alternation of fixed-width branches, without backreferences. `length` reports text
 * shorter than `minimum` or longer than `maximum`, in `visible` characters (rich text, modifiers
 * and arguments removed, wide characters counted twice, as `length_outlier` measures) or code
 * point `characters`; `forbidden_term` reports text that uses one of `terms`, matched as the
 * terminology rules match them. Each is scoped by culture, role and object path like the
 * built-in checks.
 */
export const CustomLocalizationCheck = Schema.Union([
	Schema.Struct({
		kind: Schema.Literal("pattern"),
		...CustomCheckFields,
		pattern: Schema.String.check(Schema.isNonEmpty(), Schema.isMaxLength(1024)),
		caseSensitive: Schema.optionalKey(Schema.Boolean),
		report: Schema.optionalKey(Schema.Literals(["match", "no_match"]))
	}),
	Schema.Struct({
		kind: Schema.Literal("length"),
		...CustomCheckFields,
		measure: Schema.Literals(["visible", "characters"]),
		minimum: Schema.optionalKey(MaximumCharacters),
		maximum: Schema.optionalKey(MaximumCharacters)
	}),
	Schema.Struct({
		kind: Schema.Literal("forbidden_term"),
		...CustomCheckFields,
		terms: Schema.Array(CustomTerm).check(Schema.isMinLength(1), Schema.isMaxLength(256)),
		caseSensitive: Schema.Boolean
	})
]);
export type CustomLocalizationCheck = typeof CustomLocalizationCheck.Type;

/** One rule the file runs: a built-in check by its ID, or a project rule with its own. */
export const GameTextRuleEntry = Schema.Union([
	BuiltInCheckEntry,
	TextQualityRule,
	LocalizationProjectRule,
	CustomLocalizationCheck
]);
export type GameTextRuleEntry = typeof GameTextRuleEntry.Type;

/**
 * A project's Game Text rules file: the roles its rules name, and the rules it runs. Nothing runs
 * that the file doesn't list, and without a file nothing runs. Parse JSON with
 * `decodeGameTextRuleDocumentJson`, which also rejects unknown keys, duplicate IDs and culture
 * keys, undeclared roles and patterns the engine can't run.
 */
export const GameTextRuleDocument = Schema.Struct({
	schemaVersion: Schema.Literal(1),
	roles: Schema.Array(TextRole).check(Schema.isMaxLength(256)),
	rules: Schema.Array(GameTextRuleEntry).check(Schema.isMaxLength(1024))
});
export type GameTextRuleDocument = typeof GameTextRuleDocument.Type;

const isBuiltInCheck = Schema.is(BuiltInCheckId);
/** Whether an entry names a built-in check rather than defining a project rule. */
export function isBuiltInCheckEntry(entry: GameTextRuleEntry): entry is BuiltInCheckEntry {
	return isBuiltInCheck(entry.kind);
}
/** An entry's rule ID in the file: a built-in check's ID, or a project rule's own. */
export function ruleEntryId(entry: GameTextRuleEntry): string {
	return isBuiltInCheckEntry(entry) ? entry.kind : entry.id;
}
/** Whether a listed entry runs: unless the file turns it off. */
function runs(entry: GameTextRuleEntry): boolean {
	return entry.enabled !== false;
}

/** The file's source rules that run, in file order. */
export function sourceRulesOf(
	document: Pick<GameTextRuleDocument, "rules"> | undefined
): TextQualityRule[] {
	return (document?.rules ?? []).filter(
		(entry): entry is TextQualityRule =>
			(entry.kind === "character_budget" || entry.kind === "terminology") && runs(entry)
	);
}
/** The file's localization rules that run, in file order. */
export function localizationRulesOf(
	document: Pick<GameTextRuleDocument, "rules"> | undefined
): LocalizationProjectRule[] {
	return (document?.rules ?? []).filter(
		(entry): entry is LocalizationProjectRule =>
			(entry.kind === "localization_character_budget" ||
				entry.kind === "localization_terminology") &&
			runs(entry)
	);
}
/** The file's custom checks that run, in file order. */
export function customLocalizationChecks(
	document: Pick<GameTextRuleDocument, "rules"> | undefined
): CustomLocalizationCheck[] {
	return (document?.rules ?? []).filter(
		(entry): entry is CustomLocalizationCheck =>
			(entry.kind === "pattern" ||
				entry.kind === "length" ||
				entry.kind === "forbidden_term") &&
			runs(entry)
	);
}

/**
 * Invalid rule JSON, structure or referenced policy identities. The stable code guides
 * correction; the original JSON/schema cause remains available when parsing failed.
 */
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
			"unknown_role_id",
			"invalid_overlay"
		]),
		message: Schema.String,
		recovery: Schema.String
	}
) {}

function invalid(
	code: GameTextRuleDocumentError["code"],
	cause?: unknown
): GameTextRuleDocumentError {
	const fields = {
		...(cause === undefined ? undefined : { cause }),
		retrySafe: false,
		nextStep: "fix_input" as const,
		code
	};
	switch (code) {
		case "invalid_json":
			return new GameTextRuleDocumentError({
				...fields,
				message: "The Game Text rule file is not valid JSON.",
				recovery: "Correct the JSON syntax and retry with a version-1 rule file."
			});
		case "invalid_overlay":
			return new GameTextRuleDocumentError({
				...fields,
				message: "The Game Text rule overlay doesn't apply to the project's rule file.",
				recovery:
					"Patch only rules the file lists, add rules and roles under new IDs, and keep each patched rule valid."
			});
		default:
			return new GameTextRuleDocumentError({
				...fields,
				message: "The Game Text rule file could not be validated.",
				recovery:
					"Use schemaVersion 1 with known rule kinds and check parameters, unique role, rule and culture keys, non-empty terms, positive budgets, patterns the engine runs, and declared roles (scopes included)."
			});
	}
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

/**
 * Whether a custom check is usable: a pattern JavaScript compiles and the engine runs, a length
 * with a bound in order.
 */
function validCustomCheck(check: CustomLocalizationCheck): boolean {
	switch (check.kind) {
		case "pattern":
			try {
				new RegExp(check.pattern, "u");
			} catch {
				return false;
			}
			return engineRunsPattern(check.pattern);
		case "length":
			return (
				(check.minimum !== undefined || check.maximum !== undefined) &&
				(check.minimum ?? 0) <= (check.maximum ?? Number.MAX_SAFE_INTEGER)
			);
		case "forbidden_term":
			return true;
	}
}

/** The checks the decoder makes beyond the schema; the first that fails names the error. */
function validateRuleDocument(
	document: GameTextRuleDocument
): Effect.Effect<GameTextRuleDocument, GameTextRuleDocumentError> {
	const roles = new Set(document.roles.map((role) => role.id));
	if (roles.size !== document.roles.length) return Effect.fail(invalid("duplicate_role_id"));
	const ids = document.rules.map(ruleEntryId);
	if (new Set(ids).size !== ids.length) return Effect.fail(invalid("duplicate_rule_id"));
	for (const entry of document.rules) {
		if (isBuiltInCheckEntry(entry)) {
			// A separator check with nothing to compare would run and report nothing.
			if (
				entry.kind === "segment_separator" &&
				runs(entry) &&
				!(entry.params && "separator" in entry.params)
			)
				return Effect.fail(invalid("invalid_structure"));
		} else if (
			// A project rule's ID can't pass for a built-in check's, in the file or in findings.
			isBuiltInCheck(entry.id) ||
			entry.id.startsWith("localization.") ||
			((entry.kind === "pattern" ||
				entry.kind === "length" ||
				entry.kind === "forbidden_term") &&
				!validCustomCheck(entry))
		)
			return Effect.fail(invalid("invalid_structure"));
		if (
			("role" in entry && !roles.has(entry.role)) ||
			(entry.scope?.roles ?? []).some((role) => !roles.has(role))
		)
			return Effect.fail(invalid("unknown_role_id"));
	}
	return Effect.succeed(document);
}

/**
 * Validates a rules file that is already JSON: its schema, rejecting unknown keys, then IDs, roles
 * and patterns. Use `decodeGameTextRuleDocumentJson` for text, which also finds duplicate culture
 * keys before parsing loses them.
 */
export function decodeGameTextRuleDocument<Input>(
	input: Input
): Effect.Effect<GameTextRuleDocument, GameTextRuleDocumentError> {
	return Schema.decodeUnknownEffect(GameTextRuleDocument)(input, {
		onExcessProperty: "error"
	}).pipe(
		Effect.mapError((cause) => invalid("invalid_structure", cause)),
		Effect.flatMap(validateRuleDocument)
	);
}

/**
 * Validates authored rule JSON: its schema, unknown keys rejected, duplicate culture keys, unique
 * role and rule IDs, declared roles and usable patterns. Failures retain
 * GameTextRuleDocumentError and the original parse issue.
 */
export function decodeGameTextRuleDocumentJson(
	input: string
): Effect.Effect<GameTextRuleDocument, GameTextRuleDocumentError> {
	return Effect.gen(function* () {
		const json = yield* Schema.decodeUnknownEffect(Schema.fromJsonString(Schema.Json))(
			input
		).pipe(Effect.mapError((cause) => invalid("invalid_json", cause)));
		const document = yield* decodeGameTextRuleDocument(json);
		if (duplicateCultureKey(input)) return yield* Effect.fail(invalid("duplicate_culture_key"));
		return document;
	});
}

/** A host's change to one rule its project's file lists. */
export const GameTextRulePatch = Schema.Struct({
	/** The rule to change: a built-in check's ID, or a project rule's. */
	id: Schema.String.check(Schema.isNonEmpty()),
	enabled: Schema.optionalKey(Schema.Boolean),
	severity: Schema.optionalKey(CheckSeverity),
	/** Replaces the rule's scope; `{}` removes it. */
	scope: Schema.optionalKey(LocalizationCheckScope),
	/** Merged key by key into a built-in check's `params`, or into a project rule's own fields. */
	params: Schema.optionalKey(Schema.Record(Schema.String, Schema.Json))
});
export type GameTextRulePatch = typeof GameTextRulePatch.Type;
/**
 * Changes a host makes to a project's rules file without editing it: patches to the rules it
 * lists, and roles and rules it adds.
 */
export const GameTextRuleOverlay = Schema.Struct({
	schemaVersion: Schema.Literal(1),
	/** Added to the file's roles. */
	roles: Schema.optionalKey(Schema.Array(TextRole).check(Schema.isMaxLength(256))),
	patches: Schema.optionalKey(Schema.Array(GameTextRulePatch).check(Schema.isMaxLength(1024))),
	/** Added after the file's rules. */
	rules: Schema.optionalKey(Schema.Array(GameTextRuleEntry).check(Schema.isMaxLength(1024)))
});
export type GameTextRuleOverlay = typeof GameTextRuleOverlay.Type;

/** A rule's identity and the settings a patch sets in their own fields, never in `params`. */
const reservedPatchParams = new Set(["id", "kind", "enabled", "severity", "scope"]);

/** Two patches to one rule as one: the later one's settings win, `params` merged key by key. */
const mergePatches = (earlier: GameTextRulePatch, later: GameTextRulePatch): GameTextRulePatch => ({
	...earlier,
	...later,
	...(earlier.params && later.params
		? { params: { ...earlier.params, ...later.params } }
		: undefined)
});

/** A rule with a patch's settings, to decode again: a patch's values are unchecked. */
const patchedEntry = (entry: GameTextRuleEntry, patch: GameTextRulePatch) => {
	const { scope, ...rest } = entry;
	const replaced =
		patch.scope === undefined
			? scope
			: Object.keys(patch.scope).length
				? patch.scope
				: undefined;
	return {
		...rest,
		...(isBuiltInCheckEntry(entry)
			? patch.params
				? { params: { ...entry.params, ...patch.params } }
				: undefined
			: patch.params),
		...(replaced ? { scope: replaced } : undefined),
		...(patch.enabled === undefined ? undefined : { enabled: patch.enabled }),
		...(patch.severity === undefined ? undefined : { severity: patch.severity })
	};
};

/**
 * A project's rules file with a host's overlay applied: what the host's scans read. A patch names a
 * rule the file lists; an added rule or role takes an ID the file doesn't use; the result must
 * decode as a rules file. Anything else is `invalid_overlay`. Without a file, the overlay applies
 * to an empty one.
 */
export function applyRuleOverlay(
	document: GameTextRuleDocument | undefined,
	overlay: GameTextRuleOverlay
): Effect.Effect<GameTextRuleDocument, GameTextRuleDocumentError> {
	const listed = new Set((document?.rules ?? []).map(ruleEntryId));
	const patches = new Map<string, GameTextRulePatch>();
	for (const patch of overlay.patches ?? []) {
		// A patch changes a rule's settings, never which rule it is; `params` holds only
		// parameters, since the settings have their own fields.
		if (
			!listed.has(patch.id) ||
			Object.keys(patch.params ?? {}).some((key) => reservedPatchParams.has(key))
		)
			return Effect.fail(invalid("invalid_overlay"));
		const earlier = patches.get(patch.id);
		patches.set(patch.id, earlier ? mergePatches(earlier, patch) : patch);
	}
	const roles = [...(document?.roles ?? []), ...(overlay.roles ?? [])];
	if (
		(overlay.rules ?? []).some((entry) => listed.has(ruleEntryId(entry))) ||
		new Set(roles.map((role) => role.id)).size !== roles.length
	)
		return Effect.fail(invalid("invalid_overlay"));
	const rules = (document?.rules ?? []).map((entry) => {
		const patch = patches.get(ruleEntryId(entry));
		return patch ? patchedEntry(entry, patch) : entry;
	});
	return decodeGameTextRuleDocument({
		schemaVersion: 1,
		roles,
		rules: [...rules, ...(overlay.rules ?? [])]
	}).pipe(Effect.mapError((cause) => invalid("invalid_overlay", cause)));
}

/**
 * Source-quality report retaining the version of the rule document that produced it. Findings
 * describe configurable policy, not a claim that Unreal rejected the saved text.
 */
export const GameTextSourceQualityReport = TextQualityReport.mapFields((fields) => ({
	...fields,
	ruleDocumentVersion: Schema.Literal(1)
}));
export type GameTextSourceQualityReport = typeof GameTextSourceQualityReport.Type;
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
 * Each built-in check under a rules file: a check runs when the file lists it and doesn't turn it
 * off, with the file's severity, scope and parameters over the catalogue's. Without a file, no
 * check runs. Resolved once per document.
 */
export function resolveLocalizationChecks(
	document: GameTextRuleDocument | undefined
): ResolvedLocalizationChecks {
	const cached = document && resolvedCache.get(document);
	if (cached) return cached;
	const entries = new Map(
		(document?.rules ?? []).filter(isBuiltInCheckEntry).map((entry) => [entry.kind, entry])
	);
	// SAFETY: one entry per `BuiltInCheckId`, each with that check's catalogue parameters.
	// Verified by: game-text-rules.test.ts — "decodes each built-in check with its own parameters".
	const resolved = Object.fromEntries(
		BuiltInCheckId.literals.map((id) => {
			const entry = entries.get(id);
			const params = { ...localizationCheckDefaults[id], ...entry?.params };
			return [
				id,
				{
					// A file can't list the separator check without a separator; a built one can.
					enabled:
						entry !== undefined &&
						runs(entry) &&
						(id !== "segment_separator" || "separator" in params),
					severity: entry?.severity ?? localizationCheckCatalogue[id].severity,
					...(entry?.scope ? { scope: entry.scope } : undefined),
					params
				}
			];
		})
	) as ResolvedLocalizationChecks;
	if (document) resolvedCache.set(document, resolved);
	return resolved;
}
