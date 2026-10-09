---
"@ue-shed/game-text": minor
---

Check the text in a change's files before it is submitted. `localizationGateTarget` judges every
line whose text lives in a list of changed files: a key change that would lose translations, one
key with two texts, and translated text that changed fail by default; untranslated changes, text
not gathered yet, text without a reliable key, removed text and changed source files warn.
`localizationGateFailures` applies a project's `failOn` and `warnOn`, and `LocalizationGateResult`
is the verdict across targets. The CLI exposes it as `ue-shed loc gate`.
