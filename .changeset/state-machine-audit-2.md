---
"@ue-shed/cameras": patch
"@ue-shed/engine": patch
"@ue-shed/game-text": patch
"@ue-shed/map-history": patch
"@ue-shed/observatory": patch
"@ue-shed/plugin-distribution": patch
"@ue-shed/protocol": patch
"@ue-shed/uasset": patch
"@ue-shed/unreal-assets": patch
---

The package parser checks an outer chain's depth before following it, so a malformed package
fails with a parse error instead of exhausting the stack. A Blueprint diff no longer reports
false component additions or removals when a construction-script node could not be read. The
source-text wrapper scan no longer caches a set from a scan that could not list every folder.

Game Text imports a culture's compiled resource when its archive disappears during a refresh.
A finding accepted on a culture backed only by a `.locres` stays accepted. Such findings now
load in the CLI quality report and the workspace.

A supervised editor session accepts readiness only from the editor it launched. A persistent
reader request's write is bounded by its deadline and cancellation.

A visibility-policy change advances the View revision. Map history refuses a project tree that
a failed revision left mixed. It counts the baseline budget over distinct files, and gives each
concurrent revision-cache write its own staging file. Playback frames after a partial snapshot
read as partial. Actor observation leaves live, keeping the last sample, when Unreal's writer
closes without a reset. The previous session's writer closing late does not end the new session.

In the Unreal plugins:

- A camera readback poll can no longer copy an earlier capture into a slot reused for a later
  one.
- A scenario run that holds live-input isolation past a real-time limit ends as
  `ownership_timeout`, including while PIE is paused.
- Final renders rescan editor-preview children before each frame.
- The camera arrangement panel stays read-only until it matches the applied revision, and keeps
  a typed value while it waits.
- The Game Text commandlet publishes its result through a temporary file and a rename.

Map history requires p4client-ts 0.15.0.
