---
"@ue-shed/protocol": minor
"@ue-shed/unreal-assets": minor
"@ue-shed/uasset": minor
---

The Project Index records each package's dependencies as Unreal's Asset Registry does: hard,
game and build edges read from the package header, with the same engine-package, self-reference
and external-actor rules. Two new queries walk them. `Dependencies` returns what packages need,
and `Dependents` returns what uses them, optionally filtered by export class. Both are transitive
on request and can be limited to game or hard edges. `projectIndexDependencyClosures` splits one
page into per-root closures.

A refresh can now report which paths changed or disappeared since the previous generation
(`changes: true`). `plugins: true` builds a separate catalog that also indexes content plugins, so
a dependency on plugin content resolves. These need uasset-io v1.23. The catalog format moves to
`catalogs-v7`, so the first refresh after upgrading rebuilds the index.
