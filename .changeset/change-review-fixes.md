---
"@ue-shed/game-text": patch
"@ue-shed/map-history": patch
"@ue-shed/cli": patch
---

The workspace's `compareChange` gives no verdict over a change with a package or code file it could not read, as `loc gate` does: it answers `failed` with `unreadable_package` and the files, rather than a verdict that never saw them. Both share `unreadableChangePaths`. A change's points read `.hxx` sources, as the index's join policy does. Map History prints a change's revisions to disk as they arrive rather than holding a side's files in memory, and keeps each Perforce server's revisions in their own cache folder, so two servers with the same depot path and revision never share bytes; a base localization revision is named by the file it was read from as well.
