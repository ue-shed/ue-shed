---
"@ue-shed/uasset": patch
"@ue-shed/uasset-win32-x64": patch
"@ue-shed/game-text": patch
---

Build cold Game Text indexes faster with the same results. The native writer encodes a cold
batch's new layers concurrently, the full join orders units and lines with precomputed collation
keys and builds place keys in parallel, and joins report `join_*` stage seconds. Cold package
imports for the native writer skip preparing sorted string runs it never reads, and start fewer
workers, sized to the packages read, while the reader is still extracting.
