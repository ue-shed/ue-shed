---
"@ue-shed/engine": patch
---

Validate Remote Control and its required engine-plugin dependencies before launching a live
editor connection. Report missing DLLs, missing module manifests and mismatched build identities
with recovery guidance before Unreal opens its missing-modules dialog. Plain editor launches
do not require Remote Control.
