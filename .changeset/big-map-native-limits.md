---
"@ue-shed/protocol": minor
"@ue-shed/observatory": minor
"@ue-shed/world": patch
"@ue-shed/cameras": patch
---

Big maps no longer lose data without saying so, and the limits that cut them can be raised.

- The observatory's actor catalog stops at 16,384 actors as before, but now reports how many it
  left out: `WorldActorCatalog.omittedActors`, filled from the plugin's new `omittedActors` field on
  snapshots and catalog streams. A host used to see a complete-looking list on bigger maps.
- World preparation counts actor descriptors and loaded actors up to 4,000,000. It used to refuse
  worlds with more than 100,000.
- Camera render requests may be up to 4 MiB. Bigger requests (long paths or many tiles) used to fail
  past 64K characters with a generic invalid-request error; an oversize request now says how big it
  was and what the limit is.
- `AuthoringActorReferencesRequest` takes an optional `maxPropertyVisits` (1 to 100,000,000,
  default 1,000,000). Actor reference scans on big worlds or actors with large arrays used to stop at
  1,000,000 properties with no way to finish; the `scan_limit` error now names the limits to raise.
