# `@ue-shed/plugin-distribution`

Headless installation, verification, immutable caching, dependency resolution, and scoped leasing for
UE Shed Unreal plugin distributions. The package does not depend on Workbench, Electron, a project
layout, or a particular release transport, and it never mutates an Unreal project.

## Install an exact release

Compose one `PluginReleaseSource`, one caller-owned `PluginStore`, and the
`pluginDistributionLayer`. Installation is scoped because the returned cache version remains leased
until the surrounding Effect scope closes.

```ts
import {
	PluginDistribution,
	githubReleaseSourceLayer,
	pluginDistributionLayer,
	pluginStoreLayer
} from "@ue-shed/plugin-distribution";
import { Effect, Layer } from "effect";

const dependencies = Layer.merge(
	githubReleaseSourceLayer({ owner: "ue-shed", repository: "ue-shed" }),
	pluginStoreLayer({ cacheRoot: "C:/host-owned-cache/ue-shed-plugins" })
);
const live = pluginDistributionLayer().pipe(Layer.provide(dependencies));

const program = Effect.scoped(
	Effect.flatMap(PluginDistribution, (distribution) =>
		distribution.install({
			expectedArtifactSha256: "sha256:<pinned artifact digest>",
			expectedManifestSha256: "sha256:<pinned manifest digest>",
			networkPolicy: "online",
			pluginIds: ["UEShedCameras"],
			releaseVersion: "0.3.1",
			unrealVersion: "5.7"
		})
	)
).pipe(Effect.provide(live));
```

`resolvedPluginIds` is deterministic and dependency-first. `descriptorPaths` contains absolute
verified `.uplugin` paths suitable for `@ue-shed/engine` supervised launch requests. Runtime
capability negotiation remains the responsibility of `@ue-shed/engine` and
`@ue-shed/unreal-connection` after Unreal starts.

Set `networkPolicy` to `cache-only` for offline operation. A verified entry is reused without source
access; a missing entry fails with `OfflineCacheMiss`. `prune` is explicit and refuses an active
lease. Cache versions are never overwritten or repaired in place.

The install scope is the lease lifetime. Keep that scope open until the supervised Unreal
session has stopped; releasing it removes the cross-process lease record. The immutable cached
release remains until the host explicitly calls `prune(releaseVersion)`.

## CLI

Host-cache operations are grouped by destination:

```text
ue-shed plugins cache install
ue-shed plugins cache list
ue-shed plugins cache verify
ue-shed plugins cache prune
```

`ue-shed plugins install` remains the distinct project-scoped command that writes to
`<Project>/Plugins`.

## Public boundary

- Services: `PluginDistribution`, `PluginReleaseSource`, and `PluginStore`.
- Layers: `pluginDistributionLayer`, `pluginStoreLayer`, `localPluginReleaseSourceLayer`,
  `httpPluginReleaseSourceLayer`, and `githubReleaseSourceLayer`.
- Contracts: `PluginInstallRequest`, `PluginInstallResult`, `PluginInstallProgress`, `PluginLease`,
  `CachedPluginRelease`, and the plugin bundle manifest
  schemas.
- Shared primitives: `verifyPluginArtifact`, `extractPluginArchive`, dependency resolution, and
  asset-name helpers.

Progress is a discriminated sequence of `resolving`, `downloading`, `verifying`, `extracting`,
`publishing`, and `ready` events. Pass `onProgress` and an `AbortSignal` as install options.
Expected failures are exported tagged schema classes, including unavailable/offline releases,
manifest and compatibility failures, digest mismatches, unsafe archives, corrupt/conflicting cache
entries, cancellation, active leases, transport/storage failures, and internal invariants.

## Release assets

The GitHub adapter selects exact `v<version>` releases and the Map Review assets:

- `ue-shed-plugins-map-review-<version>.manifest.json`
- `ue-shed-plugins-map-review-<version>.tar.gz`

The manifest pins the archive size and SHA-256 digest. Hosts should additionally pin both manifest
and artifact digests. No `latest`, version range, release-page scraping, or mutable catalog lookup is
part of the install contract.
