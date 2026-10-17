import { Effect, Schema } from "effect";
import { BuiltInCheckId, CheckSeverity, SourceCheckId } from "./localization-check-ids.js";
import { TextQualityRuleId } from "./quality-schema.js";

/**
 * Where a check's logic comes from. `unreal`: the finding states what Unreal does with the text
 * (its parsers, validators, gather and runtime), so the logic is fixed and only severity, on/off
 * and scope belong to the project. `heuristic`: a judgment that the text is probably wrong; its
 * thresholds and word lists are parameters the project may change.
 */
export const CheckBasis = Schema.Literals(["unreal", "heuristic"]);
export type CheckBasis = typeof CheckBasis.Type;

const PositiveInt = Schema.Int.check(Schema.isGreaterThan(0));
const Ratio = Schema.Number.check(Schema.isGreaterThan(0), Schema.isFinite());
const Word = Schema.String.check(Schema.isNonEmpty(), Schema.isMaxLength(128));
const Words = Schema.Array(Word).check(Schema.isMaxLength(256));
/** A culture code prefix such as `zh` or `pt-BR`, matched with or without a region. */
const CulturePrefix = Schema.String.check(Schema.isPattern(/^[A-Za-z]{2,8}(?:-[A-Za-z0-9-]+)?$/u));

function withDefault<S extends Schema.Top>(
	schema: S,
	value: S["Encoded"]
): Schema.withDecodingDefaultKey<S> {
	return schema.pipe(Schema.withDecodingDefaultKey<S>(Effect.succeed(value)));
}

/** No parameters: the check's logic is Unreal's, or has nothing to tune. */
export const NoCheckParams = Schema.Struct({});
export type NoCheckParams = typeof NoCheckParams.Type;

/**
 * `length_outlier`: a source of at least `minimumSourceLength` visible characters whose
 * translation is under `minimumRatio` or over `maximumRatio` times as long. Ordinary expansion
 * stays far inside (German and French run about 1.2–1.4×, East Asian scripts near 1× with wide
 * characters counted twice). Cultures starting with one of `compactCultures` often run shorter
 * than wide characters counted twice allow for, so their minimum is `compactMinimumRatio`.
 */
export const LengthOutlierParams = Schema.Struct({
	minimumSourceLength: withDefault(PositiveInt, 20),
	minimumRatio: withDefault(Ratio, 1 / 3),
	maximumRatio: withDefault(Ratio, 3),
	compactCultures: withDefault(Schema.Array(CulturePrefix).check(Schema.isMaxLength(64)), [
		"zh",
		"ja",
		"ko",
		"th"
	]),
	compactMinimumRatio: withDefault(Ratio, 0.25)
});
export type LengthOutlierParams = typeof LengthOutlierParams.Type;

/**
 * `placeholder_translation`: a translation of at most `maximumLength` characters that is one of
 * `words` (compared trimmed, lower-cased, without trailing punctuation), starts with one of
 * `caseSensitiveWords` as written, or is only punctuation for a source of at least
 * `minimumPunctuationSourceWords` words. "script lama" is Indonesian for "old script"; "todo" is
 * Spanish and Portuguese for "all", so only an upper-case `TODO` counts.
 */
export const PlaceholderTranslationParams = Schema.Struct({
	words: withDefault(Words, [
		"skip",
		"skipped",
		"script lama",
		"tbd",
		"tba",
		"fixme",
		"placeholder",
		"to be translated",
		"untranslated",
		"not translated",
		"n/a",
		"xxx"
	]),
	caseSensitiveWords: withDefault(Words, ["TODO"]),
	maximumLength: withDefault(PositiveInt, 24),
	minimumPunctuationSourceWords: withDefault(PositiveInt, 3)
});
export type PlaceholderTranslationParams = typeof PlaceholderTranslationParams.Type;

/**
 * `placeholder_text`: `markers` matched between Unicode word boundaries and as written (upper case only by
 * default: "todo" is Spanish and Portuguese for "all"), and `phrases` matched as whole words in
 * any case.
 */
export const PlaceholderTextParams = Schema.Struct({
	markers: withDefault(Words, ["TODO", "TBD", "FIXME"]),
	phrases: withDefault(Words, ["lorem ipsum", "to be translated", "placeholder"])
});
export type PlaceholderTextParams = typeof PlaceholderTextParams.Type;

/**
 * `inconsistent_translation`: sources with letters, at least `minimumLength` visible characters
 * and at most `maximumWords` words, such as names, labels and short UI text. Longer sentences are
 * often translated to fit their scene.
 */
export const InconsistentTranslationParams = Schema.Struct({
	minimumLength: withDefault(PositiveInt, 3),
	maximumWords: withDefault(PositiveInt, 4)
});
export type InconsistentTranslationParams = typeof InconsistentTranslationParams.Type;

const TagName = Schema.String.check(Schema.isPattern(/^[A-Za-z_][\w.-]*$/u));
const ArgumentName = Schema.String.check(Schema.isNonEmpty(), Schema.isMaxLength(128));

/**
 * Format argument names the game always supplies, so a translation may add them, such as a
 * player's name a culture's grammar asks for. Case-sensitive, as argument names are.
 */
const optionalArguments = withDefault(
	Schema.Array(ArgumentName).check(Schema.isMaxLength(256)),
	[]
);

/**
 * `format_arguments`, `format_argument_renamed` and `rich_text_tag_case`: adding an optional
 * argument, or a rich-text tag wrapped around only that argument, is not reported, and an added
 * optional argument does not pair with a dropped one as a rename.
 */
export const OptionalArgumentParams = Schema.Struct({ optionalArguments });
export type OptionalArgumentParams = typeof OptionalArgumentParams.Type;

/**
 * `rich_text_tags` and `rich_text_tags_added`: `optionalTags` are tag names a translation may use
 * or leave out, such as a name style a culture applies differently, compared without case;
 * `optionalArguments` as for `format_arguments`, so a tag around only such an argument is left out.
 */
export const RichTextTagParams = Schema.Struct({
	optionalTags: withDefault(Schema.Array(TagName).check(Schema.isMaxLength(256)), []),
	optionalArguments
});
export type RichTextTagParams = typeof RichTextTagParams.Type;

/**
 * `segment_separator`: text the project uses to join segments of one line, such as `"//"`. Each
 * translation must use it as often as its source. The check has nothing to compare until it is set.
 */
export const SegmentSeparatorParams = Schema.Struct({
	separator: Schema.optionalKey(Schema.String.check(Schema.isNonEmpty(), Schema.isMaxLength(16)))
});
export type SegmentSeparatorParams = typeof SegmentSeparatorParams.Type;

/** One built-in check: what it is, how it is rated by default and what it can be tuned with. */
export interface LocalizationCheckDescriptor<
	Id extends BuiltInCheckId,
	Params extends object,
	EncodedParams
> {
	readonly id: Id;
	/** `localization` checks compare a translation with its source; `source` checks the source. */
	readonly subject: "localization" | "source";
	readonly basis: CheckBasis;
	/** A short name for lists and filters, such as "Unusual length". */
	readonly label: string;
	/** The severity a finding has unless the project rates the check otherwise. */
	readonly severity: CheckSeverity;
	/** The check's parameters; every field has a default, so `{}` decodes to `defaults`. */
	readonly params: Schema.Codec<Params, EncodedParams>;
	readonly defaults: Params;
	/** What the check reports, with these parameters. */
	condition(params: Params): string;
	/** What the check reports with its default parameters. */
	readonly defaultCondition: string;
}

function check<Id extends BuiltInCheckId, Params extends object, EncodedParams>(
	id: Id,
	descriptor: {
		readonly basis: CheckBasis;
		readonly label: string;
		readonly severity: CheckSeverity;
		readonly params: Schema.Codec<Params, EncodedParams>;
		readonly condition: (params: Params) => string;
	}
): LocalizationCheckDescriptor<Id, Params, EncodedParams> {
	const defaults = Schema.decodeUnknownSync(descriptor.params)({});
	return {
		id,
		// These two source checks retain their historical LocalizationCheckId membership.
		subject:
			id === "missing_translator_notes" ||
			id === "duplicate_source" ||
			Schema.is(SourceCheckId)(id)
				? "source"
				: "localization",
		...descriptor,
		defaults,
		defaultCondition: descriptor.condition(defaults)
	};
}

/** Plain text for a fixed condition. */
const fixed =
	(text: string) =>
	(_params: NoCheckParams): string =>
		text;

const RATIO_WORDS = new Map([
	[1 / 2, "half"],
	[1 / 3, "a third"],
	[1 / 4, "a quarter"],
	[1 / 5, "a fifth"]
]);
const TIMES_WORDS = new Map([
	[2, "twice"],
	[3, "three times"],
	[4, "four times"],
	[5, "five times"]
]);
const NUMBER_WORDS = ["zero", "one", "two", "three", "four", "five", "six", "seven", "eight"];
const ratioText = (ratio: number) => RATIO_WORDS.get(ratio) ?? `${ratio}×`;
const timesText = (ratio: number) => TIMES_WORDS.get(ratio) ?? `${ratio} times`;
const countText = (count: number) => NUMBER_WORDS[count] ?? String(count);
const quoted = (values: readonly string[]) => values.map((value) => `"${value}"`).join(", ");
const codes = (values: readonly string[]) => values.map((value) => `\`${value}\``).join(", ");
const suppliedArguments = (params: { readonly optionalArguments: readonly string[] }) =>
	params.optionalArguments.length
		? `; the game always supplies ${codes(params.optionalArguments)}`
		: "";
const optionalTagText = (params: RichTextTagParams) =>
	(params.optionalTags.length ? `; ${codes(params.optionalTags)} are optional` : "") +
	suppliedArguments(params);

/**
 * Every built-in check, in `BuiltInCheckId` order. Severities, labels, parameter defaults and
 * condition texts live here and nowhere else: the package README's check table is generated from
 * it, and hosts can show the same descriptions instead of writing their own.
 */
export const localizationCheckCatalogue = {
	format_arguments: check("format_arguments", {
		basis: "unreal",
		label: "Format arguments",
		severity: "normal",
		params: OptionalArgumentParams,
		condition: (params) =>
			`Source arguments the translation drops, or arguments it adds${suppliedArguments(params)}`
	}),
	argument_modifiers: check("argument_modifiers", {
		basis: "unreal",
		label: "Plural and gender forms",
		severity: "normal",
		params: NoCheckParams,
		condition: fixed("Plural, ordinal, gender and Hangul modifier syntax and forms")
	}),
	rich_text: check("rich_text", {
		basis: "unreal",
		label: "Rich text tags",
		severity: "normal",
		params: NoCheckParams,
		condition: fixed("Unbalanced tags, as Unreal's compile validator counts them")
	}),
	po_escape_safety: check("po_escape_safety", {
		basis: "unreal",
		label: "Unsafe escapes",
		severity: "normal",
		params: NoCheckParams,
		condition: fixed(
			"Literal `\\n`, `\\r`, `\\t` that Unreal's PO round trip turns into control characters"
		)
	}),
	whitespace: check("whitespace", {
		basis: "unreal",
		label: "Whitespace",
		severity: "normal",
		params: NoCheckParams,
		condition: fixed(
			"Leading or trailing whitespace that differs from the source, or unsafe edge spaces"
		)
	}),
	empty_translation: check("empty_translation", {
		basis: "unreal",
		label: "Empty translation",
		severity: "normal",
		params: NoCheckParams,
		condition: fixed("An existing empty PO or archive entry")
	}),
	missing_translator_notes: check("missing_translator_notes", {
		basis: "heuristic",
		label: "No translator notes",
		severity: "low",
		params: NoCheckParams,
		condition: fixed("No translator notes on any occurrence or manifest entry")
	}),
	duplicate_source: check("duplicate_source", {
		basis: "heuristic",
		label: "Same text, different keys",
		severity: "low",
		params: NoCheckParams,
		condition: fixed("The same source text under different keys")
	}),
	format_argument_renamed: check("format_argument_renamed", {
		basis: "unreal",
		label: "Renamed format arguments",
		severity: "normal",
		params: OptionalArgumentParams,
		condition: (params) =>
			`A dropped and an added argument paired in order, as \`{qty}\` → \`{qté}\`; one rename stages a change${suppliedArguments(params)}`
	}),
	// A dropped tag loses styling or an inline image; an added one only styles more text.
	rich_text_tags: check("rich_text_tags", {
		basis: "unreal",
		label: "Missing tags",
		severity: "normal",
		params: RichTextTagParams,
		condition: (params) =>
			`Tags (\`<b>…</>\`, \`<Name>…</>\`, \`<img/>\`) the translation drops, compared without case${optionalTagText(params)}`
	}),
	// Slate matches style and decorator names without case, so a case change usually still renders.
	rich_text_tag_case: check("rich_text_tag_case", {
		basis: "heuristic",
		label: "Tag case changed",
		severity: "low",
		params: OptionalArgumentParams,
		condition: (params) =>
			`The same tag in another case, as \`<italic>\` for \`<Italic>\`; Slate matches names without case${suppliedArguments(params)}`
	}),
	line_breaks: check("line_breaks", {
		basis: "heuristic",
		label: "Line breaks",
		severity: "normal",
		params: NoCheckParams,
		condition: fixed(
			"A different number of line breaks inside the text than the source; edges are `whitespace`'s"
		)
	}),
	segment_separator: check("segment_separator", {
		basis: "heuristic",
		label: "Segment separators",
		severity: "normal",
		params: SegmentSeparatorParams,
		condition: (params) =>
			params.separator === undefined
				? "The `separator` parameter used a different number of times than in the source; off until it is set"
				: `\`${params.separator}\` used a different number of times than in the source`
	}),
	length_outlier: check("length_outlier", {
		basis: "heuristic",
		label: "Unusual length",
		severity: "normal",
		params: LengthOutlierParams,
		condition: (params) =>
			`A translation under ${ratioText(params.minimumRatio)}${
				params.compactCultures.length
					? ` (${params.compactCultures.join(", ")}: ${ratioText(params.compactMinimumRatio)})`
					: ""
			} or over ${timesText(params.maximumRatio)} the source's length, for a source of ${params.minimumSourceLength} or more visible characters`
	}),
	// Unreal drops an archive translation whose recorded source differs: players see the source.
	outdated_translation: check("outdated_translation", {
		basis: "unreal",
		label: "Translated from older text",
		severity: "blocking",
		params: NoCheckParams,
		condition: fixed(
			"An archive translation recorded for older source text; Unreal ships the source instead"
		)
	}),
	inconsistent_translation: check("inconsistent_translation", {
		basis: "heuristic",
		label: "Translated inconsistently",
		severity: "normal",
		params: InconsistentTranslationParams,
		condition: (params) =>
			`Short shared source text (${params.minimumLength} or more visible characters, up to ${countText(params.maximumWords)} words) translated differently in one culture`
	}),
	rich_text_tags_added: check("rich_text_tags_added", {
		basis: "heuristic",
		label: "Extra tags",
		severity: "low",
		params: RichTextTagParams,
		condition: (params) => `Tags the translation adds and drops none${optionalTagText(params)}`
	}),
	// The recorded source differs from the current one only in CRLF against LF line endings.
	source_line_endings_changed: check("source_line_endings_changed", {
		basis: "unreal",
		label: "Source line endings changed",
		severity: "low",
		params: NoCheckParams,
		condition: fixed(
			"An archive translation recorded for the same source with other line endings (`\\r\\n`, `\\n`)"
		)
	}),
	placeholder_translation: check("placeholder_translation", {
		basis: "heuristic",
		label: "Placeholder translation",
		severity: "normal",
		params: PlaceholderTranslationParams,
		condition: (params) =>
			`A translation that is only one of ${params.words.length + params.caseSensitiveWords.length} placeholder words${
				params.words.length && params.caseSensitiveWords.length
					? ` (such as "${params.words[0]!}" or "${params.caseSensitiveWords[0]!}")`
					: ""
			}, or only punctuation ("...") for a source of ${countText(params.minimumPunctuationSourceWords)} words or more`
	}),
	// Culture-invariant text is never gathered. Most of it is developer or data text no player
	// reads, so a finding only asks for a look.
	culture_invariant_text: check("culture_invariant_text", {
		basis: "heuristic",
		label: "Won't be translated",
		severity: "low",
		params: NoCheckParams,
		condition: fixed(
			"Culture-invariant player text in a property that is localizable elsewhere: never translated"
		)
	}),
	placeholder_text: check("placeholder_text", {
		basis: "heuristic",
		label: "Placeholder text",
		severity: "normal",
		params: PlaceholderTextParams,
		condition: (params) =>
			[
				...(params.markers.length ? [`${codes(params.markers)} (as written)`] : []),
				...(params.phrases.length ? [`${quoted(params.phrases)} (any case)`] : [])
			].join(", ") || "Nothing: no markers or phrases are listed"
	}),
	source_whitespace: check("source_whitespace", {
		basis: "heuristic",
		label: "Source whitespace",
		severity: "low",
		params: NoCheckParams,
		condition: fixed(
			"Whitespace at either end of a gathered source, or doubled spaces inside it"
		)
	}),
	source_markup: check("source_markup", {
		basis: "unreal",
		label: "Unbalanced source markup",
		severity: "normal",
		params: NoCheckParams,
		condition: fixed(
			"Unclosed rich-text tags, `</Name>` closings or unpaired format braces in the source"
		)
	}),
	number_only_text: check("number_only_text", {
		basis: "heuristic",
		label: "Number-only text",
		severity: "low",
		params: NoCheckParams,
		condition: fixed(
			"Localizable text with digits and no letters or arguments, which could be culture invariant"
		)
	}),
	string_table_key_collision: check("string_table_key_collision", {
		basis: "unreal",
		label: "String Table key collision",
		severity: "normal",
		params: NoCheckParams,
		condition: fixed("One namespace and key declared by more than one String Table")
	})
} as const satisfies {
	readonly [Id in BuiltInCheckId]: LocalizationCheckDescriptor<Id, object, unknown>;
};
/**
 * Built-in check definitions, defaults, parameter schemas, evidence basis and recovery
 * guidance. Hosts can disable, reconfigure, scope or supplement checks; the catalogue is
 * policy, not a parser constraint.
 */
export type LocalizationCheckCatalogue = typeof localizationCheckCatalogue;

/** Each built-in check's resolved parameters. */
export type LocalizationCheckParams = {
	readonly [Id in BuiltInCheckId]: LocalizationCheckCatalogue[Id]["defaults"];
};

// SAFETY: one entry per `BuiltInCheckId`, each the catalogue's defaults for that ID.
// Verified by: localization-check-catalogue.test.ts —
// "describes every built-in check once, under its own ID".
const defaults = Object.fromEntries(
	BuiltInCheckId.literals.map((id) => [id, localizationCheckCatalogue[id].defaults])
) as LocalizationCheckParams;
/** Every built-in check's default parameters. */
export const localizationCheckDefaults: LocalizationCheckParams = defaults;

/** Rule kinds a project writes in its rule file, with their workspace label and severity. */
export const projectRuleKinds = {
	character_budget: { label: "Character limits", severity: "normal" },
	terminology: { label: "Terminology", severity: "normal" }
} as const satisfies Record<string, { label: string; severity: CheckSeverity }>;

const RULE_ID_PREFIX = "localization.";

/** The rule ID a built-in check's findings and review marks record: `localization.<id>`. */
export function localizationRuleId(id: BuiltInCheckId): TextQualityRuleId {
	return TextQualityRuleId.make(`${RULE_ID_PREFIX}${id}`);
}

/** The built-in check a rule ID names, or undefined for a project rule or an unknown check. */
export function parseLocalizationRuleId(ruleId: string): BuiltInCheckId | undefined {
	if (!ruleId.startsWith(RULE_ID_PREFIX)) return undefined;
	const id = ruleId.slice(RULE_ID_PREFIX.length);
	return Schema.is(BuiltInCheckId)(id) ? id : undefined;
}
