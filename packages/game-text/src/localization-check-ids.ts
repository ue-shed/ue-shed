import { Schema } from "effect";

export const LocalizationCheckId = Schema.Literals([
	"format_arguments",
	"argument_modifiers",
	"rich_text",
	"po_escape_safety",
	"whitespace",
	"empty_translation",
	"missing_translator_notes",
	"duplicate_source"
]);
export type LocalizationCheckId = typeof LocalizationCheckId.Type;
