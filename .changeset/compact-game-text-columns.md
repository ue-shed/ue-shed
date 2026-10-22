---
"@ue-shed/uasset": minor
"@ue-shed/uasset-win32-x64": minor
"@ue-shed/game-text": minor
---

Game Text caches are smaller. Integer and string-ID columns in `UESHT004` snapshots can use two new
section codecs: zstd over the values' bytes grouped by significance, or over the differences of a
non-decreasing column. The native writer picks per column by compressing a sample, and encodes a
layer's sections in parallel; TypeScript readers decode both. Because older readers cannot, the
cache namespace moves to `game-text-v2` and existing caches rebuild once. On a local UE 5.7
project (~11k packages) the Game Text cache shrinks from 19.4 MB to 8.3 MB.
