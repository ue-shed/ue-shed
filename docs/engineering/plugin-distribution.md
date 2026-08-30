# Unreal plugin distribution

`@ue-shed/plugin-distribution` is the public, headless boundary for portable source bundles and
precompiled Unreal Editor plugin variants. Discovering an external descriptor with `-PLUGIN` does
not compile it. An unattended host therefore requests a binary built for its exact engine identity;
building and acquiring are separate operations.

## Ownership boundary

UE Shed owns portable source releases, versioned artifact contracts, the supervised generic
builder, exact compatibility selection, verification, immutable caching, scoped leasing, and
transport seams. A downstream organization owns its proprietary engine, build workers, compiler
installation, signing, hosting, access policy, and retention policy. Neither manifests nor adapters
contain organization-specific paths, credentials, schemas, or registry assumptions.

## Versioned artifacts

Schema version 1 remains the accepted legacy source contract. Schema version 2 remains readable for
existing source and compiled artifacts. Schema version 3 is the release-attested strict union:

- `source` records an Unreal version range and a portable source archive;
- `compiled` records exact Unreal version, engine `BuildId`, platform, architecture,
  `UnrealEditor`, `Development`, compiler/toolchain provenance, the requested and dependency-first
  resolved graph, descriptor versions, source pins, repository commit, build invocation digest,
  and archive/manifest digests.

Both v3 variants bind the exact npm package tarballs and shared wire-contract versions from the
release candidate. A compiled v3 manifest additionally lists each built module and exact engine
`BuildId`, plus a digest for every descriptor, module manifest, native binary, and debug-symbol file
in the archive. Installation compares those file attestations while extracting, before publishing
the immutable cache entry.

Unknown schema versions and excess or contradictory source/binary fields are rejected at the
boundary. Unreal `5.7` alone is never treated as binary compatibility. Extraction also reads each
plugin's `.modules` file and requires its `BuildId` to equal the outer compatibility identity.

## Selection and immutable cache

Callers request either `{ kind: "source" }` or a complete compiled identity. A compiled miss returns
`CompatiblePluginBuildUnavailable`; it never falls back to source. A source request never returns a
binary. Both modes preserve optional exact manifest and archive digest pins and `cache-only` use.

Validated artifacts use a `pv2-<sha256>` identity derived from release, compatibility identity, and
pinned manifest/archive identity:

```text
<cache>/
  variants/<release>/<pv2-identity>/
    .ue-shed-distribution.json
    plugins.manifest.json
    plugins.tar.gz
    content/Plugins/<Plugin>/<Plugin>.uplugin
  leases/<release>/<pv2-identity>/<lease-id>.json
  locks/<release>/<pv2-identity>.lock
```

Source and multiple stock/custom engine variants can coexist for one release. Verify, lease, and
prune target the exact variant. Existing `releases/<release>` source-only cache entries remain
readable and verifiable; new acquisitions use `variants/`. A release-only verify or prune remains
accepted only when it identifies one unambiguous cached variant. Entries are never silently
repaired, replaced, or mutated.

## Build a downstream engine variant

First acquire and pin the exact portable source manifest and archive. On a trusted Windows build
host with the explicit engine and compiler installed, invoke the builder separately:

```powershell
ue-shed plugins build `
  --engine C:\Engines\UE_5.7-Custom `
  --source-manifest C:\input\plugins.manifest.json `
  --source-artifact C:\input\ue-shed-plugins-<version>.tar.gz `
  --source-manifest-digest sha256:<manifest> `
  --source-artifact-digest sha256:<archive> `
  --output C:\build-output\ue-shed-plugins `
  --plugin UEShedCameras `
  --unreal 5.7.4 --build-id <exact-build-id> `
  --platform Win64 --architecture x64 `
  --compiler MSVC --compiler-version <version> `
  --toolchain "Visual Studio" --toolchain-version <version>
```

The output root is caller-owned and must be outside the engine. On Windows, keep it short enough for
UBT's action path limit. The builder stages the complete dependency graph, invokes UE 5.7
AutomationTool's `BuildPlugin` command, supervises the complete process tree, redistributes validated
products to the original descriptors, and atomically publishes only after re-extracting the final
archive. Cancellation or failure removes the private stage and publishes nothing.

The manifest's semantic metadata and tar/gzip layout are canonical. Compiler output is not claimed
to be byte reproducible. Sign the resulting immutable pair according to downstream policy, then
serve the exact bytes from a local directory, immutable HTTP endpoint, GitHub Release, or an
internal adapter implementing `PluginReleaseSource`. Asset naming and registry layout stay in that
adapter; domain logic does not know the registry.

Acquire the hosted variant explicitly:

```powershell
ue-shed plugins cache install `
  --cache C:\host-cache\ue-shed `
  --source https://artifacts.example.invalid/immutable/<release>/ `
  --release <version> --kind compiled `
  --unreal 5.7.4 --build-id <exact-build-id> `
  --platform Win64 --architecture x64 `
  --plugin UEShedCameras `
  --manifest-digest sha256:<manifest> `
  --artifact-digest sha256:<archive>
```

Keep the returned lease scope open until `@ue-shed/engine` has stopped using the dependency-first
absolute descriptor paths.

## Release integrity and 0.4.0

`0.4.0` is source-only. Its consumers can continue using the schema-v1 contract and legacy cache;
there is no published GitHub plugin asset to retrofit, and the release must not be mutated. Binary
requests require a later release with a real compiled manifest.

Public release gates reject `ref: "local"`, zero candidate-manifest digests, non-full commits,
package/plugin version disagreement, missing declared assets, and archive digest disagreement.
Local experimental output with those placeholders is useful only as local evidence and must never
be signed or hosted as a release.
