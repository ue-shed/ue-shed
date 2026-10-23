// Named exports only. Modules not listed in an entry point are private to the package.

export type { Expr, Rule, RuleDocumentV4 } from "./rules/schema.js";
export { rule, expr } from "./rules/builder.js";
export { exampleRules } from "./rules/catalogue.js";
export { translateRuleDocument, canonicalRuleDocument } from "./rules/translate.js";

export { LocalizationWordCount, localizationWordCount } from "./localization-words.js";

export {
	CustomLocalizationCheck,
	GameTextRuleDocument,
	GameTextRuleDocumentError,
	GameTextSourceQualityReport,
	LocalizationCheckPreset,
	LocalizationCheckSettings,
	LocalizationProjectRule,
	type ResolvedLocalizationCheck,
	type ResolvedLocalizationChecks,
	TextQualityRuleDocumentV2,
	TextQualityRuleDocumentV3,
	decodeGameTextRuleDocumentJson,
	migrateGameTextRuleDocument,
	resolveLocalizationChecks
} from "./game-text-rules.js";

export { GAME_TEXT_RULES_RELATIVE_PATH, STARTER_GAME_TEXT_RULES } from "./starter-rules.js";

export {
	type SavedTextAudienceInput,
	TEXT_AUDIENCE_MATCHER_VERSION,
	TEXT_AUDIENCE_POLICY,
	TEXT_OUT_OF_SCOPE_REASONS,
	type TextAudienceClassification,
	type TextAudienceEvidence,
	type TextAudienceMatch,
	type TextAudienceRule,
	type TextAudienceRuleId,
	type TextAudienceSubject,
	TextGatherScope,
	classifySavedTextAudience,
	classifyTextAudience,
	decodeTextAudience,
	encodeTextAudience,
	isEditorOnlyText,
	isEditorOnlyTextCode,
	lineTextAudience,
	matchTextAudiencePolicy,
	occurrenceTextAudience,
	savedTextAudienceSubject,
	textAudienceBit,
	textAudienceFields,
	textAudienceOfMask,
	textAudienceSubject
} from "./text-audience.js";

export {
	TEXT_ORIGIN_KINDS,
	type TextFileScope,
	emptyTextOriginCounts,
	manifestFileKeys,
	manifestOrigins,
	manifestPathOrigin,
	matchesTextFiles,
	matchesTextKinds,
	matchesTextPathPrefix,
	normalizeTextPath,
	projectRelativeTextFiles,
	textFileKey,
	textFileScope,
	textFileScopeSummary,
	textLocationOrigin,
	unitFileKeys,
	unitMatchesTextWhere,
	unitOrigins,
	unitPaths
} from "./text-origin.js";
