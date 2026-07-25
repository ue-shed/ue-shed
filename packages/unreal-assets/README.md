# `@ue-shed/unreal-assets`

The process and compatibility boundary for read-only inspection of saved Unreal asset packages. It
discovers a compatible `uasset` executable, validates its versioned CLI JSON output, and returns
normalized package evidence with explicit partial and unsupported results.

```sh
npm install @ue-shed/unreal-assets@0.1.0-rc.3 @ue-shed/uasset@0.1.0-rc.3
```

Node.js 22.14 or newer is required. The package exposes one stable entry point:

```ts
import {
	AssetReader,
	AssetReaderLive,
	discoverSavedAssets,
	readSavedAsset,
	readSavedTable,
	scanSavedProject
} from "@ue-shed/unreal-assets";
```

## Scanning a whole project

`scanSavedProject` invokes `uasset scan <project-root>` once and streams newline-delimited results
back, so a project-wide scan costs one process instead of one per package. Prefer it over
`discoverSavedAssets` plus `readSavedAsset` per path.

`classes`, `classPrefixes`, and `names` are selection rules the reader evaluates against each
package **header**, so packages that cannot hold what you are looking for are never fully read or
decoded. A package is selected when it matches any rule; with no rules every package is selected.
`names` matches the package name table, which selects by serialized property type — a package
holding any `FText` names `TextProperty` in its header.

```ts
// Every Texture2D in the project.
scanSavedProject({ classes: ["Texture2D"], projectRoot });

// Everything under one folder, plus one specific package.
scanSavedProject({
	paths: ["Content/Characters", "Content/UI/T_Icon.uasset"],
	projectRoot
});
```

`paths` narrows enumeration to directories or individual `.uasset` files, relative to the project
root or absolute, and must resolve inside it. It defaults to `Content`. `maximumAssets` refuses a
scan during enumeration, before any package is decoded, and surfaces as an `AssetReaderError` of
kind `resource_limit`.

Its authoring payload is derived from the same language-neutral schema and snapshot contract emitted
by `UEShedAuthoring`; it is not a second package-reader-specific authoring model.

This package owns process execution, schema-version negotiation, limits, and diagnostics. It does not
own DataTable authoring policy, live editor state, mutation, or Save.

`readSavedTable` invokes `uasset authoring <asset> --format json` and validates every result against
the shared runtime contract. Callers can pass an explicit executable, set
`UE_SHED_UASSET_EXECUTABLE`, or provide `uasset` on `PATH`. The UE Shed source-checkout launchers
incrementally build `crates/uasset-parser` and configure its executable automatically; this package
does not depend on a monorepo-relative path. Exit code 6 is a successful partial result, not a process
failure.

The reader currently normalizes DataTables and the parser's supported saved-asset inspection models.
Unsupported classes, parser versions, malformed output, process failures, and configured limits are
represented explicitly by the exported schemas or `AssetReaderError`; untrusted parser output is
always validated. This library does not mutate or save packages.

`@ue-shed/uasset` is the separately published executable launcher. The library never downloads a
binary and never falls back to a source checkout. Use `assetReaderLayer` to configure an explicit
executable when embedding another compatible producer.

## License

MIT. Unreal Engine is a trademark of Epic Games, Inc. This project is not affiliated with or
endorsed by Epic Games.
