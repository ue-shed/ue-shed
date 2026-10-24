---
"@ue-shed/game-text": minor
"@ue-shed/protocol": minor
---

Game Text's `duplicate_source`, `inconsistent_translation` and `culture_invariant_text` checks
run in the native rule engine as v4 rules, with the same findings. `loc check` reads findings and
lines in pages, so it runs on projects whose corpus or join is too large to hydrate. The rule
contract gains group and corpus aggregates, `maxOf` and `regexReplace`. Remove the TypeScript group
helpers that evaluated these checks: `localizationDuplicateSources`,
`localizationDuplicateCandidate`, `localizationDuplicatePlaces`, `localizationTranslationVariants`,
`invariantTextPlace`, `reportableInvariantText`, `localizationLocalizableProperties`,
`localizationPropertiesWhereLocalizable`, `localizationPropertyKey`,
`localizationCultureInvariantUnits`, `localizationConflictingSource`, `localizationSourceCulture`,
`localizationRuleContext` and their types.

Browse's `shared` and `long` review signals are also checks, `SourceCheckId`s with their own
finding shapes and workspace filters. They are opt-in: the starter file doesn't list them.

The Game Text rules file restarts at `schemaVersion: 1`, and versions 1–3 no longer load. A file is
one `rules` list: built-in checks by `kind` with optional `enabled`, `severity`, `scope` and
`params`, and project rules (source, localization and custom) as before, now in that list. Nothing
runs that the file doesn't list, and without a file nothing runs; `STARTER_CHECKS` and
`STARTER_CHECK_RULES` give today's default checks. `applyRuleOverlay` applies a host's
`GameTextRuleOverlay`, and `effectiveRuleDocument` returns the engine's rule program. Remove
`migrateGameTextRuleDocument`, `translateRuleDocument`, `TextQualityRuleDocument` and its decoders
and error, `TextQualityRuleDocumentV2`, `TextQualityRuleDocumentV3`, `LocalizationCheckPreset`
and `LocalizationCheckSettings`. Reports' `ruleDocumentVersion` is `1`.
