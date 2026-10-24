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
