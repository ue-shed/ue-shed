---
"@ue-shed/uasset": patch
"@ue-shed/uasset-win32-x64": patch
"@ue-shed/uasset-inspection-wasm": patch
"@ue-shed/game-text": patch
---

Decode additional source-verified saved property layouts, including legacy enum arrays, per-platform
values, skeletal mesh sampling tables, field paths, delegate bindings, gameplay tag containers,
material input connections and constants, float-width Vector3f values, and Niagara maps and shader
parameter records. Simple named and ordered formatted text with text arguments also decodes in
properties and containers. Generic inspection exposes the newly typed values and coverage diagnostics
report fewer raw values.
Unsupported versions, locale-dependent formatting and rejected layouts retain their saved raw evidence.
