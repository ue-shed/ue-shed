# `@ue-shed/cameras`

Headless camera observation APIs. The first vertical slice owns the versioned BGRA8 frame decoder,
bounded named-pipe server, latest-frame snapshots, subscriptions, host metrics, and Remote Control
adapter. Electron is only one consumer.

The live transport is deliberately disposable: it validates and resynchronizes the byte stream,
caps individual payloads, and retains at most one frame per camera. Scheduling and producer health
remain on the control plane. Durable captures will use `@ue-shed/evidence`, not this live buffer.

The decoder uses a bounded chunk queue instead of repeatedly concatenating partial frames. Payloads
cross the package boundary as zero-copy `Uint8Array` views while malformed framing still
resynchronizes at the protocol magic.
