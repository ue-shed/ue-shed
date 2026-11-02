---
"@ue-shed/uasset": patch
"@ue-shed/uasset-win32-x64": patch
"@ue-shed/uasset-inspection-wasm": patch
"@ue-shed/game-text": patch
---

Faster reading and Game Text scans, with identical results. The reader reuses a property layout it
has already checked when the next export of the same class has the same bytes, and does less lookup
work per property; the WASM inspector is about 45% faster. Game Text builds its shared strings and
query indexes with less copying and in parallel, and skips work that can't produce text. A first
scan of a large UE 4.27 project went from about 36 s to 32 s, and of a UE 5.7 project from 3.4 s to
3.1 s.
