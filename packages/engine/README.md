# `@ue-shed/engine`

Headless Unreal Engine installation discovery, project launch, editor readiness, Play In Editor,
and editor-world control. The package locates an engine from an explicit root or a `.uproject`
association, launches without a shell, and negotiates separately advertised `UEShedCore`
capabilities over `@ue-shed/unreal-connection`.

```sh
npm install --save-exact @ue-shed/engine @ue-shed/unreal-connection @ue-shed/protocol effect
```

Plugin-enabled launches accept explicit plugin IDs and descriptor paths. Building, downloading, or
installing plugins remains a supplied host adapter rather than a source-checkout assumption. The
live installation adapter discovers standard Epic Games Launcher installs and registered custom
build associations on Windows; non-Windows and unregistered custom installs use
`explicitEngineRoot`.

`EditorConnection` probes or waits for a compatible `UEShedCore` capability manifest.
`EditorPlaySession` controls PIE/Simulate, and `EditorWorldControl` safely opens an editor map.
`EditorWindowActivation` activates the connected editor's main window through UE Shed Core,
restores it when minimized, and reports whether foreground activation actually succeeded.
Arbitrary OS-process-to-endpoint correlation is not claimed in this release.

```ts
const activationLayer = EditorWindowActivationLive.pipe(
	Layer.provide(EditorForegroundPermissionLive),
	Layer.provide(RemoteControlClientLive)
);
const result = await Effect.runPromise(
	Effect.flatMap(EditorWindowActivation, (window) => window.activate(endpoint)).pipe(
		Effect.provide(activationLayer)
	)
);
```

Invoke this from an explicit user action. The Windows adapter uses the matching optional
`@ue-shed/engine-win32-x64` helper to grant foreground permission to the connected local process.
Other hosts can supply `EditorForegroundPermission` themselves. The endpoint's advertised Core
process identity selects the target; no window-title or first-Unreal-process heuristic is used.
`activated` is verified, `blocked` preserves OS refusal, and modal dialogs remain in control.
No editor launch or map/camera mutation is implied. See the shared
[Core window contract](../protocol/contracts/core/v1/WINDOW-ACTIVATION.md).

`SupervisedEditorSession` is a separate caller-owned launch path for bounded one-shot work. It
validates explicit project and plugin descriptors before launch, owns a process tree inside
an Effect scope, and reports readiness only after the expected Remote Control capability manifest
answers. POSIX uses a detached process group; Windows uses a private kill-on-close Job Object via
the optional `@ue-shed/engine-win32-x64` package. Scope release, failure, or cancellation terminates
only that owned process tree. The
existing `UnrealProjectLauncher` remains detached for interactive use.

## License

MIT. Unreal Engine is a trademark of Epic Games, Inc. This project is not affiliated with or
endorsed by Epic Games.
