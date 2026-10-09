---
"@ue-shed/protocol": minor
"@ue-shed/engine": minor
---

Keep a local Unreal editor responsive while a UE Shed host is in the foreground. The Core v1
foreground responsiveness contract (`EditorForegroundLeaseRequest`, `EditorForegroundLeaseResult`,
`EditorForegroundStateRequest`, `EditorForegroundStateResult`) and the manifest's
`foregroundResponsivenessObjectPath` describe UE Shed Core's Windows-only
`editor.foreground-responsiveness.v1` lease. `EditorForegroundResponsiveness.hold` holds a lease as a
scoped resource: it refuses a non-loopback endpoint before sending anything, renews at a third of
the TTL, re-acquires after a lost lease or an editor restart, degrades quietly to Unreal's normal
policy, and releases when the scope closes. `isLoopbackEndpoint` is the shared local-only rule.
