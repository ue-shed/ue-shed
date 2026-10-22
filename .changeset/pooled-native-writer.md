---
"@ue-shed/game-text": patch
---

Native Game Text build sessions reuse writer processes. `nativeIndexBuilderLayer` keeps up to four
`uasset` writer processes, each exiting after 30 seconds unused, so a rescan's back-to-back
sessions no longer start a process each. A process serves another session only after its `end`
succeeded, which releases the native writer lease and its file lock; a failed command, a failed
`end` or an interruption discards it.
