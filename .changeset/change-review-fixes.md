---
"@ue-shed/game-text": patch
"@ue-shed/map-history": patch
"@ue-shed/cli": patch
---

The workspace's `compareChange` gives no verdict over a change with a package or code file it could not read, as `loc gate` does: it answers `failed` with `unreadable_package` and the files, rather than a verdict that never saw them. Both share `unreadableChangePaths`. A change's points read `.hxx` sources, as the index's join policy does. Map History prints a change's revisions to disk as they arrive rather than holding a side's files in memory, and keeps each Perforce server's revisions in their own cache folder, so two servers with the same depot path and revision never share bytes; a base localization revision is named by the file it was read from as well.

The engine's change comparison finds a package text's translations under its namespace without the package marker, as Unreal gathers it, so editing a translated line in an asset is reported. A text edited while its Blueprint function renumbered is judged as an edit of its key's text rather than passing as a move. A code file whose String Table text needs another file (a table registered elsewhere on 4.27) or a CSV that did not import reads as partial, and a file importing a CSV is scanned again rather than reused, since the CSV is read from the project as it is now. Code text scanning imports large String Table CSVs in linear time, reads no engine CSV without an engine root, leaves Unreal Header Tool output out of a revision's files as the full scan does on 5.x, and does not keep an engine wrapper prepass that could not read a header.
