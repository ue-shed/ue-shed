---
"@ue-shed/unreal-assets": patch
"@ue-shed/uasset-inspection-wasm": patch
---

Reduce native parser allocation costs by borrowing struct names, formatting diagnostic paths only
on failure, and reading sized arrays without cloning generated layouts. Reduce owned inspection
memory for assets without Skeleton poses while preserving inspection JSON and analyzer behavior.
