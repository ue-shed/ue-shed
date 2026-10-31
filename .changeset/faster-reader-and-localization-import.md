---
"@ue-shed/uasset-inspection-wasm": minor
"@ue-shed/uasset-win32-x64": patch
"@ue-shed/uasset": patch
"@ue-shed/game-text": patch
---

The WASM runtime adds `runtime.openPackage(path, bytes)`, a handle that parses a package once and
serves `inspect`, `extractText`, `extractTextures`, `extractAuthoringTable`, `extractLevelSequences`,
`extractBlueprints` and `extractAnimations` from it with the same results as the per-call methods;
`free()` releases it. Inspecting through one handle is 13–33% faster.

The native reader decodes property streams faster and with about 40% less peak heap, and native text
extraction decodes only properties that can hold text. Text, places and text-capable gaps are
unchanged; coverage gaps that cannot hold text are no longer reported, and some exports that failed to
decode now decode. Game Text cold builds are about 40% faster: the reader allocates with mimalloc,
reuses its compression contexts, and parses localization manifests and archives in one pass with
byte-identical columns and diagnostics.
