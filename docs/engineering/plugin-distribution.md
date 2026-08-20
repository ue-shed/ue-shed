# Unreal plugin distribution

`@ue-shed/plugin-distribution` is the public host-neutral boundary for acquiring immutable UE Shed
Unreal plugin artifacts. It composes a transport-specific `PluginReleaseSource` with a caller-owned
filesystem `PluginStore`; `PluginDistribution` owns manifest validation, dependency resolution,
single-flight acquisition, scoped leases, and explicit pruning.

## Immutable contract

A request selects one exact SemVer release, one or more `UEShed*` plugin IDs, optional expected
manifest/artifact SHA-256 digests, an optional Unreal version, and either online or cache-only policy.
The service returns dependency-first resolved plugins and absolute `.uplugin` descriptor paths. It
does not mutate a `.uproject` or install under `<Project>/Plugins`.

The cache layout is implementation-owned below the configured root:

```text
<cache>/
  releases/<exact-version>/
    .ue-shed-distribution.json
    plugins.manifest.json
    plugins.tar.gz
    content/Plugins/<Plugin>/<Plugin>.uplugin
  leases/<exact-version>/<lease-id>.json
  locks/<exact-version>.lock
```

Every hit revalidates the manifest, archive digest/size, extracted file digests, path containment,
and entry types. Publication extracts to a random sibling stage and atomically renames it into the
version path. Existing versions are never overwritten. A lease record is acquired in the caller's
Effect scope and prevents explicit prune until finalization removes it.

## Map Review release assets

The next synchronized suite release should attach these exact assets to GitHub Release tag
`v<version>`:

- `ue-shed-plugins-map-review-<version>.manifest.json`
- `ue-shed-plugins-map-review-<version>.tar.gz`

The bundle contains `UEShedCore`, `UEShedCameras`, and their source-compatible files. The manifest
names and checksums the tarball and remains tied to the candidate manifest and source commit. Do not
reconstruct or replace `0.3.0` assets; build these names only for a future reviewed release.
