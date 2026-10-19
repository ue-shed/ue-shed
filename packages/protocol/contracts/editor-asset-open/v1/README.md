# Editor asset open 1.0

`editor.asset-open.v1` is independently negotiated from `editor.asset-navigation.v1` (locate).
Call `OpenAsset(ObjectPath, BringToFront, ResultJson)` on the manifest's `assetNavigationObjectPath`.
The provider is `UEShedCoreEditor` in the Core plugin; the runtime Core module does not advertise it.

`ObjectPath` must identify a top-level asset in a mounted content root, for example
`/Game/Folder/Asset.Asset`, `/Engine/...`, or a plugin's content root. Package-only paths,
subobjects, malformed paths and names exceeding Unreal's FName limit are unavailable. The plugin
looks up the asset in the Asset Registry, loads it, asks `UAssetEditorSubsystem` whether it can
be edited, and requests its editor. It does not synchronize Content Browser selection.

`result.schema.json` is the language-neutral result contract. `ok` means the subsystem accepted
the request, including an already-open editor; it does not promise a new window or OS foreground
activation. `BringToFront` requests focus of an existing asset editor. False avoids that explicit
focus request; newly opened editors follow Unreal's normal focus behavior.

`unavailable` includes a stable reason, human-readable message, recovery step, and `retrySafe`.
`editor_refused` includes assets whose type does not support editing or whose editor rejects the
request. Missing assets and failed loads remain unavailable values. Missing capabilities and
transport/schema failures are typed errors in the TypeScript client. The host owns presentation,
user intent and any retry decision; opening an asset can invoke its type's normal Unreal behavior
(including opening a map), so the client never automatically retries the open call.

Open uses its own contract instead of reusing locate: `ok` describes an accepted asset-editor
request, while locate's `located` describes Content Browser navigation, and the refusal reasons
differ. Locate's contract and behavior are unchanged.
