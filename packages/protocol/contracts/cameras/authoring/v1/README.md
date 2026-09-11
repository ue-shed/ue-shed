# Camera authoring contract v1

The package and native bridge exchange bounded JSON requests, snapshots, panel events, and published
panel state over unreal-rc. These checked-in schemas are checked against the public Effect decoders.

The host owns durable arrangements and immutable saved Views. The optional native bridge owns a
transient camera and editor lease; the optional menu is a replaceable producer of `panel-event` actions.
A command names the arrangement, expected revision, operation ID and explicit scope. Camera/group
membership is validated before a host mutation. The bridge reports a queued event, not a committed
edit. The host acknowledges after persisting its outcome; transport errors leave the event available.

Regeneration is a proposal followed by explicit acceptance. Retained identities keep their exceptions;
removed customized identities require acknowledgement. Removing a draft camera does not remove its
saved View until explicit approval includes that retired View. Batch approval is atomic.

Framing `recipe` documents omit actor references and destination View identities. `visibility-preset`
documents are project/map-specific immutable values; adopting a replacement copies its lists into a
chosen scope. Changes do not mutate previously approved View snapshots.

Native/package validation also enforces semantic rules not expressible in the generated JSON Schema:
revision freshness, unique IDs and scope membership, map/project ownership, immutable replacement,
profile references, exact requested artifact variants, and matching renderer visibility evidence.
GUIDs are authoritative; path aliases deduplicate only after resolving to the same loaded actor.
Protection wins. Advertised geometry is loaded opaque non-Nanite static-mesh actors only.

Consumers negotiate `cameras.authoring.v1` plus `arrangementPanel` before attaching this panel protocol.
Capture-only consumers need Core+Cameras, never the menu or bridge. Render capabilities independently
advertise authored visibility. Generic synchronization and the production recovery matrix remain
separate work.
