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
	type LocalizationCheckLists,
	type LocalizationLineCheckContext,
	type LocalizationLineCheckOutput,
	type LocalizationTranslationVariants,
	checkLocalizationLine,
	checkLocalizationTarget,
	compareLocalizationFindings,
	compareReportedLocalizationFindings,
	enabledLocalizationChecks,
	invariantTextPlace,
	localizationConflictingSource,
	localizationCultureInvariantUnits,
	localizationDuplicateCandidate,
	localizationDuplicatePlaces,
	localizationDuplicateSources,
	localizationLocalizableProperties,
	localizationPropertiesWhereLocalizable,
	localizationPropertyKey,
	localizationRuleContext,
	localizationSourceCulture,
	localizationStringTables,
	localizationTranslationVariants,
	reportableInvariantText
} from "./localization-checks.js";

export {
	DEFAULT_GATE_FAILURES,
	LocalizationGateCheck,
	LocalizationGateItem,
	LocalizationGateResult,
	LocalizationGateTarget,
	MAX_GATE_ITEMS,
	localizationGateFailures,
	localizationGateResult,
	localizationGateTarget,
	localizationGateUnreadEvidence,
	localizationGateUnreadPackages,
	indexedLocalizationGateTarget,
	LOCALIZATION_GATE_FIELDS,
	type LocalizationGateLine
} from "./localization-gate.js";

export {
	type PreparedTextQualityRule,
	type TextQualityOccurrence,
	evaluateTextQuality,
	matchesTextRole,
	matchesTextRoleMatcher,
	prepareTextQualityRules,
	termMatches,
	textQualityUnitFindings
} from "./quality.js";

export {
	type TextFacts,
	matchesTextFilter,
	needsWork,
	textFindings,
	textProblemCounts,
	textProblems,
	translationStates
} from "./text-problems.js";

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

export {
	type CustomCheckContext,
	customLocalizationChecks,
	detectCustomCheck,
	localizationLineCustomFindings
} from "./localization-custom-checks.js";
