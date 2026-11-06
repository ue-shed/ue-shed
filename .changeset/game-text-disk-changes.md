---
"@ue-shed/game-text": minor
"@ue-shed/protocol": minor
"@ue-shed/localization": minor
"@ue-shed/unreal-assets": patch
---

Game Text answers what on disk differs from its index, read-only, so a host can show "N saved
packages changed since the last scan" without its own snapshot of the tree or a Project Index
refresh:

- `GameTextIndexSteps.diskChanges` and the workspace's `diskChanges` take a project root, an
  optional localization `target`, optional project-relative `paths` (at most 4,096) and a page
  (`after`, `limit` up to 1,000). Without `paths`, the reader walks `Content` as the Project Index
  does and compares every package's bundle signature with the indexed one; with `paths`, it checks
  only those, and a sidecar checks its package. With `target`, the target's manifest, archives,
  POs and review file are compared by size and modification time. The answer is `not_indexed`, or
  `ready` with counts (`packages` and `localization`, each `added`, `changed`, `removed`) and a page
  of items in path order with the next page's cursor. Nothing is written.
- `watchDiskChanges` (on the steps and, as a host-only method, on the workspace) returns a `Stream`
  of `{ status: "not_indexed" }` or `{ status: "ready", changed, files, counts, checking }`: one full
  check, then `Content` and the target's folders are watched with `fs.watch` through the new
  `DiskWatcher` service (`DiskWatcherNodeLive`). Bursts settle for 300 ms by default (`settle`);
  named files are rechecked by path, and folder events, watcher errors and published scans run a
  full walk.
- The engine contract adds the `disk_changes` builder request (`DiskChangesRequest`,
  `DiskChangesAnswer`, `DiskChangeItem`, `DiskChangeCounts`, `DiskChangeKind`) and
  `JoinedReviewFile`; the uasset-io request and event schemas add the action and its outcome
  (`diskChanges`), sent with contract minor 16.
- A localization target's join records its review file's path, size and modification time
  (`reviewFile`), keyed like file provenances, so a target with a review file gets a new
  generation once. `LocalizationReviewSnapshot` has the file's `provenance` when it exists.
