---
"@ue-shed/uasset": patch
"@ue-shed/uasset-win32-x64": patch
"@ue-shed/uasset-inspection-wasm": patch
---

Read large saved Blueprints and Niagara packages faster with identical output. A Blueprint's
graph membership is decoded once per owning export instead of once per graph and node (a 32 MB
Blueprint went from 4.6 s to 0.35 s), fixed-size numeric array elements no longer allocate an
error breadcrumb each, and text projection skips numeric leaves.
