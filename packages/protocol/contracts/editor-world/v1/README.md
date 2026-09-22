# Unreal editor world-control contract v1

This contract lets a trusted external client open one explicit `/Game/` map in Unreal Editor
without player input. The operation never saves, discards, or prompts over dirty work. It returns
`already_open` when the target is current and otherwise rejects active play sessions, dirty world
packages, missing maps, and failed loads as typed outcomes.

`request.schema.json` and `response.schema.json` are the language-neutral authority shared by
`@ue-shed/protocol` and `UEShedCoreEditor`. The companion advertises
`editor.world-control.v1` and its reflected object path before clients may invoke the operation.

## Asynchronous opening and live state

Companions advertising `editor.world-control.async.v1` accept the same explicit request via
`BeginOpenMap`. It returns an `operation.schema.json` acknowledgement before scheduling the actual
load on the game thread. `GetOpenMapStatus` takes that same request identity and is read-only.
`pending` and `running` are not successful loads; `completed.result` contains the original typed
open/refusal response. Dirty-world and play-session checks run immediately before loading.

There is at most one pending/running operation. Repeating an identity returns its retained state,
and using it for another target reports `conflict`. The producer retains the last 32 terminal
operations in process memory. An unknown/evicted identity or editor restart reports
`unknown_operation`; clients must not reinterpret it as permission to replay a mutation.

Unreal's map loader still blocks its game thread. Status requests can time out during a large load;
clients retry only these read-only queries. There is no invented progress percentage and no remote
cancel/discard capability. The public engine workflow waits up to 30 minutes by default (configurable
per call), checks deadlines between bounded requests, and reports an indeterminate outcome on expiry.
Interrupting a client wait stops its polling, not Unreal's already accepted operation. Old companions
retain the synchronous API with a longer request budget and no automatic retry.

`editor.world-state.v1` advertises `GetWorldState`, returning `state.schema.json`: the current editor
map, dirty world packages, project name and whether Play/Simulate is active. Updated companions also
return `projectRoot`, the absolute project directory. It is optional for wire compatibility; clients
that require a matching local project must reject missing or mismatched identity rather than infer
it from a map path or display name. Clients can poll state independently of camera or actor streams.
No editor-event subscription is claimed by this version.
