---
"@ue-shed/protocol": patch
"@ue-shed/uasset": patch
"@ue-shed/unreal-assets": patch
"@ue-shed/game-text": patch
---

Report a package moved or copied outside Unreal at its file's location. Its summary keeps the
package name it was saved under, so the Game Text corpus and index stored object paths in the old
folder, and opening a moved DataTable in Unreal failed with "Unreal's Asset Registry has no …".
uasset-io 1.17 package text records carry the summary's `packageName`; when it differs from the
name the file's location gives, the package's own object, class and Blueprint class paths move to
the file's package, as Unreal resolves them, and the record keeps `packageName` as evidence. Paths
into other packages stay as saved. Package text shards move to `package-text-v8`, so existing
indexes read their packages again.
