---
"@ue-shed/unreal-assets": minor
"@ue-shed/blueprints": minor
"@ue-shed/map-history": minor
"@ue-shed/project-custodian": minor
"@ue-shed/uasset-inspection-wasm": minor
---

Saved-asset limits and pure helpers are public, so hosts no longer copy them.

- `@ue-shed/unreal-assets` exports `DEFAULT_TIMEOUT_MS`, `DEFAULT_CATALOG_TIMEOUT_MS` and
  `SAVED_REVIEW_MAX_CHANGES`. `./investigation-files` exports `INVESTIGATION_PRESET_MAX_BYTES` and
  `INVESTIGATION_EXPORT_MAX_BYTES`.
- `searchBlueprint` accepts `maximumHits`; the default stays `MAX_BLUEPRINT_SEARCH_HITS`.
- `@ue-shed/map-history/diff` is a browser-safe entry for `diffSavedWorldSnapshots`,
  `actorIdentityOf`, `actorIdentityKey` and `savedWorldTransformsEqual`.
- `@ue-shed/project-custodian` exports `resolvePolicyDocument`, `PolicyResolution` and
  `ProjectTargetDefinition`, so a host can validate a policy before writing it.
- `@ue-shed/uasset-inspection-wasm` declares the `DEFAULT_LIMITS` it already exported at runtime.
