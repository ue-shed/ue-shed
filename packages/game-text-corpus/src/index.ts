// Named exports only. Modules not listed here are private to the package.

export {
	type GameTextCorpusComparison,
	type GameTextCorpusDifference,
	GameTextCorpusError,
	compareGameTextCorpus,
	gameTextCorpusIndexLayer
} from "./compare.js";

export {
	CorpusExpectations,
	CorpusFinding,
	CorpusFindingFix,
	CorpusSourceKind,
	CorpusSubject,
	CorpusTranslationStages,
	corpusCultures,
	corpusExpectationsName,
	corpusNotExposedYet,
	corpusPlanName,
	decodeCorpusExpectations,
	diffCorpus,
	findingCounts,
	sameCorpusSubject,
	subjectKey
} from "./contract.js";

export {
	type CorpusKnownDefect,
	type CorpusPinnedSummary,
	corpusDefectsFor,
	corpusKnownDefects,
	formatCorpusComparisonSummary,
	triageCorpusDifferences
} from "./defects.js";

export { corpusLocalization, gatheredNamespace, manifestLocation } from "./localization.js";

export {
	type CorpusPlan,
	type PlannedCulture,
	type PlannedPackage,
	type PlannedText,
	CorpusPlanSchema,
	decodeCorpusPlan,
	probeSubject
} from "./plan.js";
