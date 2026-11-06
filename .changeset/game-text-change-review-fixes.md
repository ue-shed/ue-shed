---
"@ue-shed/game-text": patch
"@ue-shed/protocol": patch
---

Game Text's change answers report what they missed before:

- `changedSince` lists a line as `changed` when its set of saved places differs: an occurrence
  moved to another object of the same package, or one added to or removed from an existing unit.
- `diskChanges` compares the disk with the packages the view's own joined layer read, not with the
  shards the store has published since. After a project-only refresh or another target's scan, the
  view keeps reporting the difference until it is joined again.
- `diskChanges` matches a package whose file name contains a literal reserved scalar (U+F0000 to
  U+F0800) with its indexed package, in walks and named-path checks, instead of listing it as both
  added and removed. Item paths and cursors are the files' own names, the same text `changedSince`
  uses for a package, and items are ordered as `changedSince` orders IDs (WTF-8 bytes).
- `watchDiskChanges` follows a target folder that doesn't exist yet, such as
  `Config/UEShed/Localization` before the first review is saved, from its nearest existing ancestor,
  so creating the folder and its review file triggers a check. `DiskWatcher.watch` now takes the
  project root and a project-relative folder, so a custom watcher can do the same.
