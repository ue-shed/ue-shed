---
"@ue-shed/game-text": patch
"@ue-shed/protocol": patch
---

Game Text imports localization files through one native path, cold or warm:

- A refresh reads every changed file of a target in one native engine request, instead of one
  request and one publication per file. A warm refresh after every file changed now costs about
  what a cold import does. Files whose stat matches their hint still need no read.
- One file that fails to read or parse no longer stops the others: the engine publishes every file
  that imported and returns a typed failure for each other file, which becomes that file's
  diagnostic as before.
- The engine contract's `import_localization` request drops `cold` (the engine decides per file),
  each file result is a tagged union (`outcome: "imported"` with `file`, or `outcome: "failed"`
  with `error`), and the generated contract exports `localizationImport` (`version`,
  `maximumFiles`).
- The engine owns the content key and returns it per file; the host keeps the returned key in its
  stat hints. Stat hints move to a new version, so the first refresh after updating reads every
  file once (and reuses each retained layer without parsing).
- `importLocalizationTarget` reports its import profile (`LocalizationImportProfile`: files, stat
  hits, imported, failed, native calls, worker count, parse and publish time) for warm imports too.
