// Named exports only. Modules not listed in an entry point are private to the package.

export {
	textIdRepairSupport,
	textIdRepairEditLabel,
	textIdConflictGroups,
	newTextIdKey,
	textIdRepairChanges,
	textIdNamespace,
	textIdRepairInstructions
} from "./id-repair.js";

export {
	compareLocalizationFindings,
	compareReportedLocalizationFindings,
	enabledLocalizationChecks
} from "./localization-checks.js";

export {
	DEFAULT_GATE_FAILURES,
	LocalizationGateChange,
	LocalizationGateCheck,
	LocalizationGateItem,
	LocalizationGateResult,
	LocalizationGateTarget,
	MAX_GATE_ITEMS,
	localizationGateFailures,
	localizationGateResult,
	localizationGateComparison,
	localizationGateTarget,
	localizationGateUnreadEvidence,
	localizationGateUnreadPackages,
	localizationGatePartialPackages,
	type LocalizationGatePartialRead,
	indexedLocalizationGateTarget,
	LOCALIZATION_GATE_FIELDS,
	type LocalizationGateLine
} from "./localization-gate.js";

export {
	type PreparedTextQualityRule,
	matchesTextRole,
	matchesTextRoleMatcher,
	prepareTextQualityRules
} from "./quality.js";

export {
	type TextFacts,
	matchesTextFilter,
	needsWork,
	textProblemCounts,
	textProblems,
	translationStates
} from "./text-problems.js";

export { TEXT_PROBLEMS, TEXT_PROBLEM_RULES, type TextProblemRule } from "./text-problem-rules.js";

export {
	MAX_TEXT_ROW_FINDINGS,
	TextFindingsSelection,
	TextFindingsStatus,
	TextRowFindings,
	TextRowProblems,
	TextRuleId
} from "./text-problem-schema.js";

export { unrealPluralForms } from "./unreal-plural-forms.js";

export {
	UnrealArgument,
	UnrealFormatIssue,
	UnrealFormatPattern,
	UnrealModifier,
	UnrealModifierIdentity,
	UnrealModifierName,
	UnrealRichTextCounts,
	UnrealWhitespace,
	parseUnrealFormatPattern,
	unrealRichTextCounts,
	unrealRichTextValid,
	unrealUnsafeWhitespace,
	unrealWhitespace
} from "./unreal-text-syntax.js";

export {
	CheckBasis,
	InconsistentTranslationParams,
	LengthOutlierParams,
	type LocalizationCheckCatalogue,
	type LocalizationCheckDescriptor,
	type LocalizationCheckParams,
	NoCheckParams,
	OptionalArgumentParams,
	PlaceholderTextParams,
	PlaceholderTranslationParams,
	RichTextTagParams,
	SegmentSeparatorParams,
	localizationCheckCatalogue,
	localizationCheckDefaults,
	localizationRuleId,
	parseLocalizationRuleId,
	projectRuleKinds
} from "./localization-check-catalogue.js";

export { LocalizationCheckScope, localizationCheckInScope } from "./localization-check-scope.js";

export { customLocalizationChecks } from "./game-text-rules.js";
