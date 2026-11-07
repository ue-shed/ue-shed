// Named exports only. Modules not listed in an entry point are private to the package.
export { rule, expr } from "./rules/builder.js";
export { exampleRules } from "./rules/catalogue.js";
export { effectiveRuleDocument, canonicalRuleDocument } from "./rules/effective.js";
export { LocalizationWordCount, localizationWordCount } from "./localization-words.js";
export { CustomLocalizationCheck, CompleteRule, completeRulesOf, customRulesOf, ruleProblemError, ruleLabelsOf, GameTextRuleDocument, GameTextRuleDocumentError, BuiltInCheckEntry, canonicalGameTextRuleDocumentJson, GameTextRuleEntry, decodeGameTextRuleDocument, isBuiltInCheckEntry, localizationRulesOf, ruleEntryId, sourceRulesOf, GameTextSourceQualityReport, LocalizationProjectRule, decodeGameTextRuleDocumentJson, resolveLocalizationChecks } from "./game-text-rules.js";
export { GAME_TEXT_RULES_RELATIVE_PATH, STARTER_CHECKS, STARTER_CHECK_RULES, STARTER_GAME_TEXT_RULES } from "./starter-rules.js";
export { TEXT_AUDIENCE_MATCHER_VERSION, TEXT_AUDIENCE_POLICY, TEXT_OUT_OF_SCOPE_REASONS, TextGatherScope, classifySavedTextAudience, classifyTextAudience, decodeTextAudience, encodeTextAudience, isEditorOnlyText, isEditorOnlyTextCode, lineTextAudience, matchTextAudiencePolicy, occurrenceTextAudience, savedTextAudienceSubject, textAudienceBit, textAudienceFields, textAudienceOfMask, textAudienceSubject } from "./text-audience.js";
export { TEXT_ORIGIN_KINDS, emptyTextOriginCounts, manifestFileKeys, manifestOrigins, manifestPathOrigin, matchesTextFiles, matchesTextKinds, matchesTextPathPrefix, normalizeTextPath, projectRelativeTextFiles, textFileKey, textFileScope, textFileScopeSummary, textLocationOrigin, unitFileKeys, unitMatchesTextWhere, unitOrigins, unitPaths } from "./text-origin.js";
