# Unreal editor world-control contract v1

This contract lets a trusted external client open one explicit `/Game/` map in Unreal Editor
without player input. The operation never saves, discards, or prompts over dirty work. It returns
`already_open` when the target is current and otherwise rejects active play sessions, dirty world
packages, missing maps, and failed loads as typed outcomes.

`request.schema.json` and `response.schema.json` are the language-neutral authority shared by
`@ue-shed/protocol` and `UEShedCoreEditor`. The companion advertises
`editor.world-control.v1` and its reflected object path before clients may invoke the operation.
