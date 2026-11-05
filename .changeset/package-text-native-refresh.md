---
"@ue-shed/game-text": minor
"@ue-shed/protocol": minor
"@ue-shed/unreal-assets": minor
---

A Game Text rescan of an existing index now updates it in place however many package shards
changed: it reads and converts only the changed packages, and the native writer keeps every
unchanged record. A change that touched more than 8 of the 256 shards used to decode every changed
shard in JavaScript and re-encode each record. All changed shards still publish atomically. Only a
first scan, or an index in an older package format or audience policy, reads and writes the
changed shards again.

Progress reports reads apart from reuse. `package_read` ("Reading changed packages") replaces
`packages` and counts the packages read of those to read, with `unchanged` giving the packages kept
from the index without reading them. `package_update` ("Updating package text") covers the
in-place update; `package_publish` stays for a shard set written again.

uasset-io 1.22 adds `compare_packages`, which compares a refresh's changed shards with the index
in the native writer, so unchanged entries no longer cross into JavaScript. `publish_packages`
accepts `rowsFile`, the rows as a file of little-endian 32-bit integers, and an input without
`previousKey` for a shard the index doesn't hold yet. The native writer interns each string
domain once across a request, so a change to every shard fits the dictionary's 256 segments.
