---
"@ue-shed/uasset": minor
"@ue-shed/uasset-win32-x64": minor
"@ue-shed/uasset-inspection-wasm": minor
"@ue-shed/game-text": minor
---

The asset reader decodes far more of a saved package's properties instead of keeping them as raw
bytes. On a large UE 4.27 project the values left raw fell from 654,042 to 1,019, and on a UE 5.7
project from 82,023 to 261. Newly decoded:

- enum arrays in UE 4.27-era packages, and per-platform values (`PerPlatformFloat`, `Int`, `Bool`,
  `FrameRate`);
- skeletal mesh sampling tables, field paths, delegate bindings and gameplay tag containers;
- material input connections and constants, and the `Vector3f`, `Vector4f`, `IntVector2` and
  `Box2f` math types;
- optional properties and Universal Object Locators;
- Niagara maps, variable records, VM function bindings and shader parameters;
- Landscape layer maps and physics constraint instances;
- formatted text (`FText::Format` with named or ordered text arguments).

Each layout follows the engine's own serializer for the versions it accepts. Anything else, such as
text formatted with numbers, which depends on the locale, keeps its raw bytes as before, so coverage
diagnostics report only what is still raw.
