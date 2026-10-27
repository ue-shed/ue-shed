---
"@ue-shed/game-text": minor
---

Breaking: remove the deprecated root `@ue-shed/game-text` and `@ue-shed/game-text/browser`
aggregates and the package's `main` and `types` fallbacks. Use browser-safe `/schema` for contracts,
`/rules` for rule documents, `/checks` for checks and filter helpers, and `/labels` for presentation.
Node hosts use `/corpus` for queries and reports, `/index` for scanning and native index composition,
and `/workspace` for selected-project workflows and operations.

Replace `WorkbenchOperationRequest`, `WorkbenchOperationFailure`, `WorkbenchOperationPlan`,
`WorkbenchOperationPlanResult`, `WorkbenchOperationReceipt`, `WorkbenchOperationResult`,
`WorkbenchOperationProgress`, `WorkbenchOperationState`, `WorkbenchOperationId`,
`WorkbenchOperationTarget`, `WorkbenchOperationFilesRequest` and `WorkbenchOperationFilesResult`
with the corresponding `GameTextOperation*` names from `/schema`. Replace `ScanTextCorpusOptions`
with `TextCorpusScanOptions`, `TextCorpusServiceShape` with `TextCorpusServiceApi`, and
`TextCorpusServiceTestShape` with `TextCorpusServiceTestApi`, all from `/index`.

Replace `TextReviewLens` with `TextFilter` clauses from `/schema`:
`finding` names rule IDs and `fact` names review signals. Replace `TextFinding`,
`TextCountedFindings`, `textFindings`, `textCountedFindings` and row `countedFindings` with the
row's `findings` rule IDs (`TextRowFindings` from `/checks`). Omit
`GameTextIndexStepsOptions.qualityWorker`; quality runs in the native engine.

Replace `gameTextCsv` with the opened query's `NativeTextQuery.writeCorpusCsv`, and
`localizationLinesCsv` with `NativeTextQuery.writeLocalizationLinesCsv`. Replace
`prepareLocalizationFile` with native index imports through `GameTextIndexSteps.importTarget`
from `/index`. Saved investigation presets with a `lens` still open with the same selection: `investigationRequest` reads the lens as its filter clause.
