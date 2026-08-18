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

## License

MIT. Unreal Engine is a trademark of Epic Games, Inc. This project is not affiliated with or
endorsed by Epic Games.
