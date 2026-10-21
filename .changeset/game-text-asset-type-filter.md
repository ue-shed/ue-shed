---
"@ue-shed/protocol": minor
"@ue-shed/uasset": minor
"@ue-shed/game-text": minor
---

Filter Game Text by asset type. uasset-io 1.17 package text records carry `assetClass`, the class of
the package's main asset chosen as Unreal's loader does (the export flagged as an asset and named
after the file, else the first one); an actor saved in its own package reports its world's class.
The index stores it per package under the same `package-text-v8` format, so caches rebuild once for
this and the moved-package fix. Search requests take an `asset_type` clause of class paths such as
`/Script/Engine.DataTable` or `/Script/UMGEditor.WidgetBlueprint`: `is` matches text with any saved
place of a selected type, `is_not` text with none. `facets: { assetTypes: true }` counts lines per
type over the request without its own clause, labelled by the new `textAssetTypeLabel` ("Data
table", "Widget blueprint", "Level"). The native engine, both views, paging totals, counts and
exports agree with the TypeScript references. The Workbench filter menu lists asset types.
