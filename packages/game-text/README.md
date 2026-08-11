# `@ue-shed/game-text`

Headless saved-package corpus discovery and search for player-facing Unreal Engine text. The
package keeps Unreal namespace/key identity distinct from occurrence identity, reports scan
coverage, and returns bounded search and focus results. Saved packages are evidence only; this
package does not mutate assets.

## Install

Pin the package and the host's Effect runtime exactly:

```sh
npm install --save-exact @ue-shed/game-text effect@4.0.0-beta.98
```

`@ue-shed/unreal-assets` is a normal package dependency. It remains a separate artifact and is not
bundled into Game Text. A saved-asset reader executable is also required at runtime, but it is not a
JavaScript dependency of this package. Install the default launcher separately:

```sh
npm install --save-exact @ue-shed/uasset
```

Alternatively, configure `assetReaderLayer({ executable })` with another compatible `uasset-io`
producer. The reader library never downloads an executable or falls back to a source checkout.

## Host usage

Compose `TextCorpusServiceLive` with one scoped `AssetReader` layer in the trusted Node host. Keep
the resulting corpus and `textCorpusQuery(corpus)` model in that host, and send only bounded summary,
search, and focus results over the host's validated transport.

Use `scanFromProjectIndex` when the host already maintains a saved-project header index. Otherwise,
`scan` performs its own bounded project scan. Both paths preserve coverage and typed recovery
guidance.

The `@ue-shed/game-text/browser` entry point contains only schemas and pure query helpers. It does
not expose filesystem, process, Electron, Perforce, or Unreal authority.

See [ADOPTING.md](ADOPTING.md) and [adoption.manifest.json](adoption.manifest.json) when integrating
Game Text into an established trusted host.

## Capabilities

- Required: a project root containing saved packages and a configured saved-asset reader.
- Optional: a separate host capability may locate a selected occurrence in Unreal.
- Not required: Workbench, Perforce, a running editor, or any UE Shed Unreal plugin.
