---
"@ue-shed/unreal-connection": minor
---

Show in Unreal and asset opening work on UE 4.27. The 4.27 Game Text plugin bundle now builds
`UEShedCoreEditor` with asset navigation and window activation only (play sessions, world control
and foreground responsiveness stay UE5 only), so a 4.27 editor advertises
`editor.asset-navigation.v1`, `editor.asset-open.v1` and `editor.window-activation.v1`. Core
advertises each `UEShedCoreEditor` capability only when its class is built; UE5 manifests are
unchanged. Class paths and Remote Control allowlists are the same on every engine.
