# Live scenario execution v1 fixtures

These JSON fixtures freeze the language-neutral control-plane values shared by
`@ue-shed/scenarios` and the optional `UEShedScenarios` Unreal plugin. The Effect schemas in
`packages/scenarios/src/live.ts` own validation; conformance tests decode and re-encode every
fixture without loss.

Version 1 supports only the deterministic Movement Gym PIE slice, `pre_evaluation` input,
Move/Jump/Interact, one blocking `landing_ready` wait, one `cache_open` probe, and bounded evidence.
