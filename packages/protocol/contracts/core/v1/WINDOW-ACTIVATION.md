# Editor window activation

`UEShedCoreEditor` advertises `editor.window-activation.v1` and a
`windowActivationObjectPath` in the Core capability manifest. Invoke `ActivateEditorWindow`
there with `RequestJson` matching `window-activation-request.schema.json`; decode `ResultJson`
with `window-activation-result.schema.json`.

Use the manifest's process identity as `expectedProcessId`. The companion rejects stale identities.
It targets its main editor window, or the active modal dialog that must be handled first. It does
not select actors, move cameras, open maps, dismiss dialogs, save packages, or launch an editor.

On Windows, activation restores a minimized main window and calls `SetForegroundWindow`, then
checks the actual foreground window. A denied request returns `blocked`; a missing window returns
`unavailable`. Unsupported platforms return `unsupported`. An actor-navigation success is not a
window-activation success.

For a local endpoint, a foreground client can first grant permission to this one process using
`AllowSetForegroundWindow`. The engine package supplies this through its optional Windows native
helper. It never grants `ASFW_ANY`, attaches input queues, simulates keyboard input, changes focus
lock settings, or performs automatic focus retries. Remote endpoints do not receive local grants.
Call only for an explicit user handoff; observation and background follow ticks must not activate.
