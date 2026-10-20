---
"@ue-shed/uasset": patch
"@ue-shed/uasset-inspection-wasm": patch
"@ue-shed/game-text": patch
---

Read saved Blueprint graph pin text on UE 4.27 and UE 5.6–5.8, retaining Unreal identities and
addressable pin locations. Report skipped or rejected graph pin streams as partial coverage even
when the package gather table omits their text. Match native subobject paths during saved repair
verification. Re-extract cached package text on the next refresh so existing scans gain pin text.
Join compiled Blueprint literals to matching saved pin identities within each package, preserving
both occurrences and keeping different sources or unread pins separate.
