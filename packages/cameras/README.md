# `@ue-shed/cameras`

Headless camera observation and durable map-review APIs. The package owns the versioned BGRA8 frame
decoder, bounded named-pipe server, latest-frame snapshots, subscriptions, host metrics, Remote
Control adapters, portable Review Set schemas, filesystem repository, and Capture Run orchestrator.
Electron is only one consumer.

The live transport is deliberately disposable: it validates and resynchronizes the byte stream,
caps individual payloads, and retains at most one frame per camera. Scheduling and producer health
remain on the control plane. Durable review captures do not use this live buffer: the editor stages a
bounded one-shot PNG, then the host validates, hashes, and promotes it into an immutable local run.

Spatial authoring adds typed selection inspection, normalized subject bounds, deterministic Context,
Facade, Cardinal, and editor-view candidate generation, transient candidate previews, bounds-drift
diagnostics, and explicit approval with manual-adjustment provenance. The pure generation and
approval APIs remain usable from the CLI without Workbench.

The durable loop supports approved perspective poses, actor-path subjects, Pure PNG captures, honest
per-view failures, and atomic run publication. Review Sets normally live in
`.ue-shed/review/sets`; generated runs live in `.ue-shed/review/runs` and remain local by default.
The language-neutral editor wire contract is under
`packages/protocol/contracts/cameras/review/v1`.

The decoder uses a bounded chunk queue instead of repeatedly concatenating partial frames. Payloads
cross the package boundary as zero-copy `Uint8Array` views while malformed framing still
resynchronizes at the protocol magic.
