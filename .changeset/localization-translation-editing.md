---
"@ue-shed/localization": minor
"@ue-shed/game-text": minor
---

Write reviewed translation change sets into PO files. Changes are revalidated against fresh
evidence: the source must match the manifest, and the replaced translation must match what ships
next. Only the edited `msgstr` values change, through an atomic, hash-guarded replace. Game Text
adds browser-safe edit request and result schemas for hosts that stage edits.
