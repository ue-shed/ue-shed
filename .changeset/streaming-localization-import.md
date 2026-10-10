---
"@ue-shed/game-text": minor
"@ue-shed/localization": patch
---

Import Unreal manifest, archive and PO files into Game Text snapshots by streaming, keyed by
content hash, with a file-stat check that skips unchanged files without opening them. The PO
parser exposes block decoding for streaming callers and takes a faster path for unescaped fields.
