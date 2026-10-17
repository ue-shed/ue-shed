---
"@ue-shed/observatory": minor
---

Observatory stream failures now carry a code and a retry flag. UEShedObservatory's StartActorObservation and SetActorObservationCadence failures used to be prose only. They now add `code` and `retrySafe` beside `message` and `recovery`. The codes are `invalid_json`, `missing_cadence`, `invalid_cadence`, `world_unavailable` (the only retry-safe one), `stream_inactive` and `platform_unsupported`.

`setObservationCadence` passes the code and retry safety on in `ObservatoryConnectionError` (new optional `code`). Actor-feed start failures name the code in their message. Both fields are optional, so older plugins still decode, and their failures stay retry-safe as before.
