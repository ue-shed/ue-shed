# Niagara session transport v1

This local filesystem transport carries the existing preview request contract unchanged.
It is available only to trusted process-owning hosts. Every launch uses a new private
directory. It is not a network protocol or a way to attach to arbitrary editor processes.

- Producer readiness: atomically publish `ready.json` containing
  `{ "protocol": "ue-shed-niagara-session.v1" }`.
- Submit: atomically rename a complete request to `<runId>.request.json`. The lowercase
  UUID v4 filename must match the request's `runId`. IDs are never reused in a session.
- Result: atomically publish `<runId>.result.json` containing
  `{ "protocol": "ue-shed-niagara-session.v1", "runId": "<UUID>", "exitCode": 0 }`.
  Exit codes are integers 0–255 with the same meaning as single-request commandlet exits.
  A result is at most 4096 bytes. Success still requires validation of the existing
  producer receipt and PNG artifacts; this result alone does not authorize publication.
- Cancel: the host creates `<runId>.cancel`. The producer checks before work and between
  output frames. Timeouts or interrupted consumers leave this marker.
- Retire: a `stop` file asks the producer to exit between requests. The supervising host
  writes `closed` on process exit or forced termination. Consumers accept already-completed
  matching results, but fail pending work when `closed` appears.

The producer handles requests serially. It destroys each scene and collects garbage before
publishing its result. It exits after 300 requests or 900 seconds without work and removes
`ready.json`. The host must stop the process before any source revision changes. The host's
process tree—not a stored PID—is the authority for forced cleanup.
