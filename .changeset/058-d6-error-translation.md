---
"@ue-shed/game-text": minor
"@ue-shed/localization": minor
"@ue-shed/unreal-assets": minor
"@ue-shed/cameras": minor
"@ue-shed/plugin-distribution": minor
"@ue-shed/map-history": minor
---

Errors are translated on purpose instead of being caught wholesale or matched with `instanceof`.

- **Breaking (`@ue-shed/host`):** authoring session failures no longer expose an internal error tag as their public `code`. The codes are `session_live_failed`, `session_storage_failed`, `session_transition_refused`, `draft_intent_rejected`, `invalid_session_id`, `session_corrupt`, `session_not_found`, `editor_capability_missing` and `editor_connection_failed`; `authoring_session_failure` remains the default. Every session pipe names the failures it translates, so a new failure type is a compile error instead of a silently caught one. Live and connection failures now report their real `retrySafe`.
- Tagged errors are matched by tag (`Schema.is` guards such as `isSnapshotStoreError`, `isLocalizationError` and `isProjectIndexError`, `Effect.catchTag`, or `Predicate.isTagged`), never with `instanceof`, so checks keep working across package copies and after a schema round trip.
- The shared Game Text index decides whether to retry a racing open from the `missing` code instead of searching the message for `ENOENT`.

Migration: hosts that branched on authoring session codes such as `AuthoringSessionStorageError` should switch to the new codes. Code that matched UE Shed errors with `instanceof` should match on `_tag` or use the exported guards.
