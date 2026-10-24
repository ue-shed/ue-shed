import { Schema } from "effect";

/**
 * Built-in localization checks: a line's shipped translation against its source, per culture, plus
 * translator notes and shared source text. IDs are stable: review files record them as
 * `localization.<id>`. New checks are appended.
 */
export const LocalizationCheckId = Schema.Literals([
	"format_arguments",
	"argument_modifiers",
	"rich_text",
	"po_escape_safety",
	"whitespace",
	"empty_translation",
	"missing_translator_notes",
	"duplicate_source",
	"format_argument_renamed",
	"rich_text_tags",
	"rich_text_tag_case",
	"line_breaks",
	"segment_separator",
	"length_outlier",
	"outdated_translation",
	"inconsistent_translation",
	"rich_text_tags_added",
	"source_line_endings_changed",
	"placeholder_translation"
]);
export type LocalizationCheckId = typeof LocalizationCheckId.Type;

/**
 * Built-in checks of the source text itself. They report once per line, under the line's source
 * culture, as `missing_translator_notes` does.
 */
export const SourceCheckId = Schema.Literals([
	"culture_invariant_text",
	"placeholder_text",
	"source_whitespace",
	"source_markup",
	"number_only_text",
	"string_table_key_collision",
	"shared",
	"long"
]);
export type SourceCheckId = typeof SourceCheckId.Type;

/** Every built-in check: what `checks`, `disabledChecks` and `disabledLocalizationChecks` name. */
export const BuiltInCheckId = Schema.Literals([
	...LocalizationCheckId.literals,
	...SourceCheckId.literals
]);
export type BuiltInCheckId = typeof BuiltInCheckId.Type;

/**
 * How much a finding matters before the game ships. `blocking`: players see text that is wrong or
 * untranslated. `normal`: likely a bug, review it. `low`: housekeeping that rarely reaches players.
 */
export const CheckSeverity = Schema.Literals(["blocking", "normal", "low"]);
export type CheckSeverity = typeof CheckSeverity.Type;
