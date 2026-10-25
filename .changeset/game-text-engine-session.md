---
"@ue-shed/game-text": minor
"@ue-shed/protocol": minor
"@ue-shed/unreal-assets": minor
---

The Game Text engine runs in its own binary session, `uasset game-text-engine`, instead of the
uasset-io protocol's `game_text_engine` operation, which is removed. Requests and replies are
length-prefixed frames carrying request IDs, and requests carry their values inline: the JSON
text `payload` fields are gone, and the rule document travels as an object.
`GameTextEngineRequest` and `GameTextEngineOutcome` are removed from `@ue-shed/protocol`; the
engine's types are `GameTextContract.EngineRequest`, `OpenReply`, `EngineEnd`, `EngineFailure`
and `EngineProfile`, generated from the engine. `NativeGameTextEngineClient.execute` returns an
`EngineAnswer` (its parts and profile); `answerJson` reads its reply.

One engine process serves a host: `nativeIndexQueryLayer` starts it on the first read, and every
open snapshot's reader lives in it, instead of two processes per snapshot. Requests run
concurrently in the engine, keystrokes on threads of their own, so a search answers while an
evaluation or an export runs. Interrupting a read cancels it in the engine rather than letting it
finish unseen, and a panic in the engine fails only its request.

Bulk reads stream as column batches instead of files: the corpus, its header, localization lines,
aggregates and findings pages no longer write temporary files under the cache root, and a large
findings page no longer spills to one. An `EngineAnswer` carries its `batches`, read through
`EngineBatch` views over each frame's buffer, and `answerRows` reads one part's rows; the
relations and their columns are generated as `GameTextContract.Relations`. The engine requests
lose their `output` paths, `SpilledReply` is removed, and `ReadProfile` drops `responseBytes` and
`fileFallback`; `EngineProfile` counts `batches`, `batchBytes` and `creditStallMs`.
