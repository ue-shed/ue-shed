---
"@ue-shed/protocol": minor
"@ue-shed/unreal-assets": minor
"@ue-shed/uasset": minor
"@ue-shed/uasset-win32-x64": minor
---

A one-file edit no longer rewrites the whole Project Index. A small refresh writes a delta of the
entries it changed over the committed snapshot, and compacts into a new snapshot once the delta
grows past 16,384 entries or 5% of the index. A refresh target can name the files a watcher saw
change (`changedPaths`, uasset-io v1.26): the refresh then looks only at those files and their
sidecars instead of walking the project, with the same result, and walks anyway when the paths
alone could miss a change. A complete summary carries `inventoryDigest`, a SHA-256 of every
inventory fact, so a host can tell whether the inventory changed without paging through it.
Refreshes run in a worker session of their own that stays warm between edits. The cache moves to
`catalogs-v9`; the first refresh rebuilds it.
