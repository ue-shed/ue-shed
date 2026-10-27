---
"@ue-shed/unreal-assets": minor
"@ue-shed/game-text": patch
---

The asset reader now splits a package path list too large for one 4 MiB request itself. Scans,
text and texture projections and staged package-text reads send the list in consecutive batches,
one reader process at a time, so a project with tens of thousands of candidate paths no longer
fails. A scan returns one merged result. A projection streams the batches in order and closes with
one merged summary. Progress counts keep growing across batches, and `maximumAssets` bounds the
whole operation. Cancelling stops the running batch and starts no more, and a failed batch fails
the whole operation. Staged reads are cut only where the staging group changes. A path list that
fits one request still runs exactly as before. Each operation's span records its batch count as
`ue_shed.reader.batches`.

Breaking: `AssetReaderError` has a new kind, `request_too_large`, with `nextStep: "fix_input"`.
It replaces the `contract` error that an oversized request used to raise, and its message no
longer names `batchProtocolPaths`. After batching, the error only comes from a single path or
option that is too large on its own. A staged read whose staging group cannot fit one request
also fails this way.

Breaking: when no executable is configured, `assetReaderLayer` and `AssetReaderLive` now run the
`uasset.exe` from the installed `@ue-shed/uasset-win32-x64` package before trying `uasset` on PATH.
`getAssetReaderSource()` reports this as the new value `"package"`. `UE_SHED_UASSET_EXECUTABLE`
still takes precedence for `AssetReaderLive`.

Projection streams now report their protocol telemetry (the protocol observer's
`worker_completed` event, boundary bytes and reader metrics) after their worker finishes. Before
this change it was recorded when the stream was created, so it held zero counts.

The Game Text index source passes its whole selection to the reader in one call. It now checks
every package's bundle signature once before and once after the whole read, rather than around
each batch.
