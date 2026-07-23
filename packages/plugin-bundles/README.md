# `@ue-shed/plugin-bundles`

Versioned manifest contracts and validation for source-compatible Unreal plugin bundles.

`PluginBundleManifest` is the boundary contract used by release tooling and the CLI installer. A
manifest records the release version, supported Unreal range, plugin descriptor graph, artifact
identity, and source/candidate provenance. The manifest's `artifact.sha256` and provenance
`candidateManifest.sha256` fields use the canonical `sha256:<64 lowercase hex>` representation.

`verifyPluginBundleArtifactChecksum` accepts either that canonical form or raw 64-character
lowercase hex for the digest returned by a file hashing API, then compares the canonical values
before extraction. This keeps release manifests deterministic while allowing common Node and shell
checksum tools at the installer boundary.

`validatePluginBundleManifest` decodes unknown input with Effect Schema and then rejects duplicate
or missing dependencies, cycles, invalid descriptor paths, incompatible Unreal versions, and
candidate provenance drift. Failures are `PluginBundleManifestValidationError` values with a stable
code and recovery guidance.
