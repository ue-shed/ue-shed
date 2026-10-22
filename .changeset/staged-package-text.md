---
"@ue-shed/protocol": minor
"@ue-shed/unreal-assets": minor
"@ue-shed/uasset": minor
"@ue-shed/uasset-win32-x64": minor
"@ue-shed/game-text": minor
---

Package text can skip the host's event stream. uasset-io 1.19 adds `staging` to
`extract_text_packages`: the reader writes each package's record line to a group file and streams a
small `staged_text_package` result instead, in completion order, so one large package no longer
holds back the rest. `AssetReader.stageProjectTextPackages` and `GameTextIndexSource.stage` expose
it, and cold Game Text imports use it when the reader supports it: each import worker reads and
validates its own group, and the main thread never parses package text. The reader creates each
group file exclusively, so a large read split into several requests stages each request in its own
directory and every staged event names the file holding its record; `batchStagedProtocolPaths`
sizes those requests including their group numbers. Projection reads now
default to up to eight workers (at least four) when a request sets no `limits.concurrency`.

Staged snapshot files are written uncompressed, unsynced and in batched writes, since the writer
reads them once in the same session; `writeSnapshotFile` takes `{ durable: false }` for this.
A native writer publishes staged cold layers from their files (`SharedIndexWriter.publishColdFiles`)
without the host opening each one.
