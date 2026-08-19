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
Arbitrary OS-process-to-endpoint correlation is not claimed in this release.

`SupervisedEditorSession` is a separate caller-owned launch path for bounded one-shot work. It
validates explicit project and plugin descriptors before launch, owns a POSIX process group inside
an Effect scope, and reports readiness only after the expected Remote Control capability manifest
answers. Scope release, failure, or cancellation terminates only that owned process group. The
existing `UnrealProjectLauncher` remains detached for interactive use.

The live supervised adapter deliberately returns `process_tree_supervision_unavailable` on Windows.
`taskkill /T` cannot prevent a descendant from escaping before teardown. Truthful Windows support
requires a native launcher to create Unreal suspended, assign it to a caller-owned Job Object with
kill-on-close enabled, and only then resume it.

## License

MIT. Unreal Engine is a trademark of Epic Games, Inc. This project is not affiliated with or
endorsed by Epic Games.
