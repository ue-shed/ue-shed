---
"@ue-shed/localization": minor
---

`applyLocalizationChangeSet` takes an optional `prepareWrites` hook. It is called with every PO
file the write will replace, from the freshly read evidence, before the first one is written, so
a host can check them all out; a failure writes nothing.
