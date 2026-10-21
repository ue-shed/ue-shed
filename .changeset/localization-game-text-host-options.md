---
"@ue-shed/localization": minor
"@ue-shed/game-text": minor
---

Localization runs and Game Text carry-over are usable from a host's own code.

- `makeLocalizationOperationsLayer({ auditLimits })` sets the bounds of the before/after write
  audit of a commandlet run. The defaults, `defaultLocalizationAuditLimits` (100,000 entries,
  512 MiB per file, 2 GiB in total), are unchanged; raise them for projects whose audited files are
  larger. `LocalizationOperationsLive` keeps the defaults.
- `makeLocalizationOperationsTestLayer` provides a complete operations implementation for tests.
- `localizationCarryChanges(before, after)` from `@ue-shed/game-text/corpus` turns the keys a gather
  changed into change-set entries for the new keys, as `ue-shed loc run --carry` does.
- `GameTextIdRepairsApi` from `@ue-shed/game-text/workspace` names the ID repair workflow type.
