---
"@ue-shed/protocol": minor
"@ue-shed/unreal-assets": minor
---

The Game Text engine runs in its own binary session, `uasset game-text-engine`, instead of the
uasset-io protocol's `game_text_engine` operation, which is removed. Requests and replies are
length-prefixed frames carrying request IDs, so calls can overlap and an interrupted call sends
`cancel` instead of ending the process. Requests carry their values inline: the JSON text
`payload` fields are gone, and the rule document travels as an object. `GameTextEngineRequest`
and `GameTextEngineOutcome` are removed from `@ue-shed/protocol`; the engine's types are
`GameTextContract.EngineRequest`, `OpenReply`, `EngineEnd`, `EngineFailure` and `EngineProfile`,
generated from the engine. `NativeGameTextEngineClient.execute` returns an `EngineAnswer` (its
parts and profile); `answerJson` reads its reply.
