---
"@ue-shed/plugin-distribution": patch
---

The `editor-host` plugin bundle now includes `UEShedGameText`, so hosts that install it can fix text
keys in DataAssets, Blueprint defaults, widgets, graph pins and String Tables through Unreal. Its
manifest records the `ue-shed-game-text-actions` 1.0 contract. The npm packages are republished for
suite alignment only; none has a code change.

0.17.1 also corrects the 0.17.0 migration guide and changelogs, which still described the removed
TypeScript builder export and `searchWorker` option, and fixes their migration-guide links.
