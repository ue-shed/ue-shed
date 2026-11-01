---
"@ue-shed/uasset": patch
"@ue-shed/uasset-win32-x64": patch
"@ue-shed/uasset-inspection-wasm": patch
"@ue-shed/game-text": patch
---

Decode additional source-verified saved property layouts, including legacy enum arrays, per-platform
values, skeletal mesh sampling tables, field paths, delegate bindings, gameplay tag containers,
material input connections and constants, fixed-width math aliases (Vector3f, Vector4f, IntVector2,
Box2f), optional property states, stock Universal Object Locator fragments, and Niagara maps,
variable records, VM function bindings and shader parameter records, Landscape layer maps and physics
constraint instances. Named and ordered formatted
text with text arguments, literal pipes and escaped punctuation also decodes in properties and
containers. Generic inspection exposes the newly typed values and coverage diagnostics
report fewer raw values.
Unsupported versions, locale-dependent formatting and rejected layouts retain their saved raw evidence.
