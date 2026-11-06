---
"@ue-shed/game-text": minor
"@ue-shed/protocol": minor
---

A Game Text target reports its generation, and the engine answers what changed since an earlier
one, so hosts no longer need their own package tracker or inventory hash:

- `generation` is the target's joined key, an opaque string. It changes whenever something the
  target shows changes (packages, imported localization files, the review file, code or policy),
  stays equal across refreshes that change nothing, is safe to persist and compare across
  processes, and also changes after the store is compacted. It is on `GameTextIndexRefreshResult`,
  `GameTextTargetIndex`, the workspace's completed `configuredRefresh` result and a ready
  `localizationTarget` result.
- Renamed: `GameTextProjectIndex.generation` and the old `GameTextTargetIndex.generation`, which
  held the store's dictionary epoch (renewed only when the store is created again or compacted,
  not when inputs change), are now `storeEpoch`; `GameTextIndexQuery.open` takes `storeEpoch`
  instead of `generation`.
- `NativeTextQuery.changedSince` and the workspace's `changedSince` (with an optional `target`)
  list what changed since a generation: `lines` by line ID, with namespace and key, or `packages`
  by path, including packages without text. The answer is `same`, `too_old` (`compacted`,
  `format` or `unknown`; the host decides what to do instead) or `changes`, with every change's
  counts and a page of up to 1,000 items in ID order and the next page's cursor. The engine diffs
  once per reader and pages the cached result.
- The engine contract adds the `changed_since` request (`ChangedSinceRequest`,
  `ChangedSinceAnswer`, `ChangeItem`, `ChangeCounts`, `TooOldReason`).
