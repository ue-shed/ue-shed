# `@ue-shed/unreal-assets`

The process and compatibility boundary for read-only inspection of saved Unreal asset packages. It
discovers a compatible `uasset` executable, validates its versioned CLI JSON output, and returns
normalized package evidence with explicit partial and unsupported results.

```sh
npm install @ue-shed/unreal-assets@0.1.0-rc.4 @ue-shed/uasset@0.1.0-rc.4
```

Node.js 22.14 or newer is required. The package exposes one stable entry point:

```ts
import {
	AssetReader,
	AssetReaderLive,
	discoverSavedAssets,
	readSavedAsset,
	readSavedWorld,
	readSavedTable,
	scanSavedProject
} from "@ue-shed/unreal-assets";
```

## Reading one saved map

`readSavedWorld` invokes the map-targeted `uasset saved-world` operation. Unlike a project scan, it
reads a conventional level's single `.umap` or, for World Partition, only the selected map's
`__ExternalActors__` subtree. The returned catalog carries saved-package authority, actor
package/object identity, class and label evidence, plus a position-resolution status. It can be
partial when unrelated exports fail to decode while actor positions remain usable.

```ts
const world =
	yield *
	readSavedWorld({
		mapPath: "Content/Maps/L_Example.umap",
		projectRoot
	});

const positionedActors = world.actors.filter((actor) => actor.position.status === "resolved");
```

This is saved disk state, not a live Observatory snapshot: bounds, Focus in Unreal, Follow, and
camera framing still require a connected editor authority. `maximumAssets` is a pre-decode safety
limit (100,000 by default in the native reader); exceeding it returns `AssetReaderError` with
`kind: "resource_limit"`.

## Scanning a whole project

For routine project opening and repeated candidate queries, prefer the headless `ProjectIndex` over
a whole-project scan. Its refresh operation performs one Content traversal and publishes a committed
Generation to a disposable Catalog; maps and header-evidence queries return stable pages capped at
1,024 items. Callers configure the cache root, but never depend on SQLite tables or filenames.

```ts
const events = refreshProjectIndex({ projectRoot });
const page =
	yield *
	queryProjectIndex(
		ProjectIndexQuery.cases.ExactClasses.make({
			expectedGeneration,
			limit: 100,
			projectId,
			values: ["/Script/Engine.Texture2D"]
		})
	);
```

Queries do not silently refresh. If the expected Generation is stale, refresh and restart paging;
if the disposable Catalog is corrupt or incompatible, use `rebuildProjectIndex`. `scanSavedProject`
remains the explicit compatibility API for callers that genuinely need a generic scan.

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

Pass `inventory: true` when a caller needs a persisted project signature. The same native scan then
streams the path, size, and modified time of every package and `.uexp`, `.ubulk`, or `.uptnl`
sidecar beneath the selected roots. This inventory is independent of class filters, so a client can
derive maps and validate its own cached projections without a second Node filesystem walk.

`resolveScanTarget` turns any user-supplied path into the `projectRoot` and `paths` pair a scan
needs, so callers accepting a path from a person do not each reimplement the walk:

```ts
// A project root or .uproject scans all of Content; anything else scopes to itself.
const target = yield * resolveScanTarget("Fixture/Content/Characters");
yield * scanSavedProject({ ...target, projectRoot: target.projectRoot });
```

It walks up to the owning `.uproject` and fails when there is none, because object paths are only
meaningful relative to a project root.

Its authoring payload is derived from the same language-neutral schema and snapshot contract emitted
by `UEShedAuthoring`; it is not a second package-reader-specific authoring model.

This package owns process execution, schema-version negotiation, limits, and diagnostics. It does not
own DataTable authoring policy, live editor state, mutation, or Save.

`readSavedTable` sends one `uasset-io` protocol request and validates every streamed result against
the shared runtime contract. `readSavedTable` and `readSavedAsset` share one lazily started native
protocol session for the lifetime of their `AssetReader` layer. Calls are serialized through that
bounded worker; interruption terminates it, and closing the layer closes the process. Project scans
remain explicit batched operations in fresh workers. The executable keeps the human `authoring`
command for compatibility.
Callers can pass an explicit executable, set
`UE_SHED_UASSET_EXECUTABLE`, or provide `uasset` on `PATH`. The UE Shed source-checkout launchers
incrementally build `crates/uasset-io` and configure its executable automatically; this package
does not depend on a monorepo-relative path. Expected partial outcomes are typed terminal protocol
events; the legacy human command retains exit code 6 for compatibility.

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
