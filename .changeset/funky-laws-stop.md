---
"@ue-shed/protocol": minor
"@ue-shed/unreal-connection": minor
---

Add the independently negotiated `editor.asset-open.v1` capability in UEShedCoreEditor and
`openUnrealAsset({ endpoint, objectPath, bringToFront })` for trusted hosts. The separate
`unreal-editor-asset-open` 1.0 contract reports accepted opens as `ok`, and missing assets, load
failures and editor refusals as `unavailable` with recovery guidance. Locate continues to reveal
Content Browser assets without opening them. Core's existing Remote Control class permission covers
the new function. Hosts retain action choice and focus policy.
