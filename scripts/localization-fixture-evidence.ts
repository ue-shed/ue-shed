import assert from "node:assert/strict";
import { Schema } from "effect";
import { isJsonObject, type JsonObject, type JsonValue } from "./json.ts";

export const localizationStates = [
	"translated",
	"not_translated",
	"needs_update",
	"not_synced",
	"not_gathered",
	"changed_since_gather",
	"not_found",
	"gathered_only",
	"outside_target"
] as const;

const LocalizationIdentity = Schema.Struct({
	culture: Schema.String,
	namespace: Schema.String,
	key: Schema.String
});
type LocalizationIdentity = Schema.Schema.Type<typeof LocalizationIdentity>;

const NullableText = Schema.Union([Schema.String, Schema.Null]);
const FormatValidation = Schema.Struct({
	valid: Schema.Boolean,
	errors: Schema.Array(Schema.String),
	arguments: Schema.Array(Schema.String)
});
export const LocalizationValidationEvidence = Schema.Struct({
	checkedTranslation: NullableText,
	sourceFormat: FormatValidation,
	translationFormat: Schema.NullOr(FormatValidation),
	cardinalForms: Schema.Array(Schema.String),
	ordinalForms: Schema.Array(Schema.String),
	sourceRichTextValid: Schema.Boolean,
	translationRichTextValid: Schema.NullOr(Schema.Boolean),
	sourceSafeWhitespaceValid: Schema.Boolean,
	translationSafeWhitespaceValid: Schema.NullOr(Schema.Boolean),
	poRoundTripTranslation: NullableText
});
export type LocalizationValidationEvidence = typeof LocalizationValidationEvidence.Type;
export const LocalizationEvidenceEntry = Schema.Struct({
	...LocalizationIdentity.fields,
	manifestSource: NullableText,
	currentAssetSource: NullableText,
	archiveSource: NullableText,
	archiveTranslation: NullableText,
	runtimeText: NullableText,
	poMsgstr: NullableText,
	poDecodedMsgstr: NullableText,
	validation: Schema.NullOr(LocalizationValidationEvidence),
	manifestKeyPaths: Schema.Array(Schema.String),
	manifestDevNotes: Schema.optionalKey(Schema.Array(Schema.String)),
	poExtractedComments: Schema.Array(Schema.String),
	inTarget: Schema.Boolean,
	packageReadable: Schema.Boolean,
	gatheredOnly: Schema.Boolean
});
type LocalizationEvidenceEntry = Schema.Schema.Type<typeof LocalizationEvidenceEntry>;

export const LocalizationEvidence = Schema.Struct({
	schemaVersion: Schema.Literal(1),
	target: Schema.String,
	nativeCulture: Schema.Literal("en"),
	engineVersion: Schema.Literals(["5.7", "5.8"]),
	entries: Schema.Array(LocalizationEvidenceEntry)
});
const LocalizationIntent = Schema.Struct({
	schemaVersion: Schema.Literal(1),
	target: Schema.String,
	entries: Schema.Array(
		Schema.Struct({
			...LocalizationIdentity.fields,
			state: Schema.Literals(localizationStates)
		})
	)
});

function identity(entry: LocalizationIdentity): string {
	return JSON.stringify([entry.culture, entry.namespace, entry.key]);
}

// Fixture-only rules: current occurrences have priority over translation status.
// Source-only occurrences retain translation/runtime evidence but are labelled gathered_only.
function state(entry: LocalizationEvidenceEntry) {
	const manifest = entry.manifestSource;
	const current = entry.currentAssetSource;
	const archive = entry.archiveSource;
	const translation = entry.archiveTranslation;
	const po = entry.poDecodedMsgstr;
	if (!entry.inTarget) {
		assert.notEqual(current, null);
		assert.equal(manifest, null);
		return "outside_target";
	}
	if (manifest === null) {
		assert.notEqual(current, null);
		assert.equal(entry.packageReadable, true);
		return "not_gathered";
	}
	if (entry.gatheredOnly) return "gathered_only";
	assert.equal(entry.packageReadable, true, "asset state needs complete package evidence");
	if (current === null) return "not_found";
	if (current !== manifest) return "changed_since_gather";
	if (translation && archive !== manifest) return "needs_update";
	// Only a non-empty PO translation awaits import; Unreal's PO import skips empty msgstr values.
	if (po !== null && po !== "" && po !== (translation ?? "")) return "not_synced";
	if (!translation) return "not_translated";
	return "translated";
}

export function assertLocalizationIntent(evidenceJson: JsonObject, intentJson: JsonObject) {
	const evidence = Schema.decodeUnknownSync(LocalizationEvidence)(evidenceJson);
	const intent = Schema.decodeUnknownSync(LocalizationIntent)(intentJson);
	assert.equal(evidence.target, intent.target);
	assert.equal(evidence.nativeCulture, "en");
	const actual = new Map<string, string>();
	for (const entry of evidence.entries) {
		const id = identity(entry);
		assert.ok(!actual.has(id), `duplicate evidence ${id}`);
		actual.set(id, state(entry));
		const manifest = entry.manifestSource;
		const translation = entry.archiveTranslation;
		const archive = entry.archiveSource;
		assert.equal(
			entry.runtimeText,
			manifest === null ? null : translation && archive === manifest ? translation : manifest,
			`Unreal runtime source-check drift for ${id}`
		);
		if (manifest !== null) assert.ok(entry.manifestKeyPaths.length > 0);
		if (manifest !== null) {
			assert.ok(entry.validation, "manifest evidence requires actual Unreal validation");
			const po = entry.poDecodedMsgstr;
			assert.equal(
				entry.validation.checkedTranslation,
				po && po !== (translation ?? "") ? po : translation
			);
		} else assert.equal(entry.validation, null);
		if (evidence.engineVersion === "5.8") assert.ok(entry.manifestDevNotes);
		else assert.equal(entry.manifestDevNotes, undefined);
	}
	const expected = new Map<string, string>();
	for (const entry of intent.entries) {
		const id = identity(entry);
		assert.ok(!expected.has(id), `duplicate intent ${id}`);
		expected.set(id, entry.state);
	}
	assert.deepEqual(actual, expected, "localization evidence does not match the authored intent");
	assert.deepEqual(
		new Set(actual.values()),
		new Set(localizationStates),
		"missing state coverage"
	);
	const find = (culture: string, namespace: string, key: string) => {
		const result = evidence.entries.find(
			(entry) =>
				entry.culture === culture && entry.namespace === namespace && entry.key === key
		);
		assert.ok(result, `missing ${culture}/${namespace}/${key}`);
		return result;
	};
	const table = "Fixture.Localization.Table";
	const named = find("de", table, "NamedArgument");
	assert.equal(named.manifestSource, "Talking with {PlayerName}");
	assert.equal(named.archiveTranslation, "Gespräch mit {Name}");
	assert.equal(find("de", table, "OrderedArgument").archiveTranslation, "Kontrollpunkt {0}");
	assert.equal(
		find("fr", table, "Plural").archiveTranslation,
		"{Count} {Count}|plural(one=objet,other=objets)"
	);
	assert.equal(find("en", "Fixture.Localization.Asset", "DuplicateA").manifestSource, "Confirm");
	assert.equal(find("en", "Fixture.Localization.Asset", "DuplicateB").manifestSource, "Confirm");
	// Validator evidence comes from Unreal, not the product checks. Assert fixture coverage here;
	// the browser check tests compare individual findings with these recorded outcomes.
	assert.equal(find("de", table, "RichText").validation?.translationRichTextValid, false);
	assert.equal(find("fr", table, "RichText").validation?.translationRichTextValid, true);
	assert.equal(find("de", table, "Whitespace").validation?.translationSafeWhitespaceValid, false);
	assert.equal(
		find("de", table, "MissingPluralForm").validation?.translationFormat?.valid,
		false
	);
	assert.equal(find("de", table, "Ordinal").validation?.translationFormat?.valid, false);
	assert.equal(find("fr", table, "Ordinal").validation?.translationFormat?.valid, true);
	const escaped = find("de", table, "LiteralEscape").validation;
	assert.ok(escaped);
	assert.equal(escaped.checkedTranslation, "Schreib \\n");
	assert.notEqual(escaped.poRoundTripTranslation, escaped.checkedTranslation);
	assert.equal(find("de", table, "LiteralEscape").poDecodedMsgstr, "");
	const namedValidation = named.validation;
	assert.ok(namedValidation);
	assert.deepEqual(namedValidation.sourceFormat.arguments, ["PlayerName"]);
	assert.deepEqual(namedValidation.translationFormat?.arguments, ["Name"]);
	assert.equal(
		namedValidation.translationFormat?.valid,
		true,
		"pattern validation does not compare source argument names"
	);
	const welcome = find("de", table, "Welcome");
	assert.ok(
		welcome.poExtractedComments.some((comment) =>
			comment.includes("Greeting on the start screen.")
		),
		"translator note did not survive Unreal export"
	);
	if (evidence.engineVersion === "5.8") {
		assert.ok(welcome.manifestDevNotes);
		assert.ok(welcome.manifestDevNotes.includes("Greeting on the start screen."));
	}
	const outdated = find("de", "Fixture.Localization.Asset", "Outdated");
	assert.equal(outdated.archiveSource, "Open the door");
	assert.equal(outdated.manifestSource, "Open the gate");
	assert.equal(outdated.poMsgstr, "", "Unreal must export stale translations as empty");
	assert.equal(outdated.runtimeText, "Open the gate");
}

// JSON object field order is not evidence. Array order, notes, keys, paths and text are evidence.
export function canonicalLocalizationEvidence(value: JsonValue): JsonValue {
	if (Array.isArray(value)) return value.map(canonicalLocalizationEvidence);
	if (isJsonObject(value))
		return Object.fromEntries(
			Object.keys(value)
				.sort()
				.map((key) => [key, canonicalLocalizationEvidence(value[key])])
		);
	return value;
}
