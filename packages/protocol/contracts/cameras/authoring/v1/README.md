# Camera authoring contract v1

The package and native bridge exchange bounded JSON requests, snapshots, panel events, and published
panel state over unreal-rc. These checked-in schemas are checked against the public Effect decoders.

The host owns durable arrangements and immutable saved Views. The optional native bridge owns a
transient camera set and editor lease; the optional menu is a replaceable producer of `panel-event` actions.
A command names the arrangement, expected revision, operation ID and explicit scope. Camera/group
membership is validated before a host mutation. The bridge reports a queued event, not a committed
edit. The host acknowledges after persisting its outcome; transport errors leave the event available.

Regeneration is a proposal followed by explicit acceptance. Retained identities keep their exceptions;
removed customized identities require acknowledgement. Removing a draft camera does not remove its
saved View until explicit approval includes that retired View. Batch approval is atomic.

Discovery advertises `multiCameraEditing` for whole-set editing. Attach/apply accept bounded `cameras`
with stable IDs, resolved poses and optional draft definitions. Snapshots expose all cameras, native
selection, changed poses, additions and removals. The host commits one `poses` command before acknowledging
the native sequence. Definitions let native duplication allocate independent camera/View IDs and let
Undo restore the same deleted identity. Retained actors are updated in place. `select_cameras` supports
empty selection and multi-selection; `pilot_camera` switches the existing actor. Legacy single-camera
requests/snapshots remain supported. Sequence/revision checks apply to the entire set, not just the
active camera; only a verified chain of the same producer's commits permits acknowledgement-race rebasing.

Framing `recipe` documents omit actor references and destination View identities. `visibility-preset`
documents are project/map-specific immutable values; adopting a replacement copies its lists into a
chosen scope. Changes do not mutate previously approved View snapshots.

Native/package validation also enforces semantic rules not expressible in the generated JSON Schema:
revision freshness, unique IDs and scope membership, map/project ownership, immutable replacement,
profile references, exact requested artifact variants, and matching renderer visibility evidence.
GUIDs are authoritative; path aliases deduplicate only after resolving to the same loaded actor.
Protection wins. Advertised geometry is loaded opaque non-Nanite static-mesh actors only.

Discovery also advertises `nativeSetup`. `setup_status` reads host availability and the editor's
single selected subject before any set is attached. `setup_create` queues one explicit actor path,
map path, name and validated layout under a request ID. A matching-project host uses `setup_poll`
with its own identity to renew a 30-second lease, consume the intent and acknowledge an outcome
(`error: null` or an actionable failure). This queue does not persist drafts or attach actors itself.
Another host is rejected while the lease is held. Loss of the host or a pending request's editor
world cancels the pending intent; it is not silently handed to a replacement host. The public
`makeCameraSetupHost` caches an outcome before acknowledgement to avoid duplicate creation when
a reply is lost during that host lifetime. Inspect saved data after interruption before retrying.
`setup_release` requires the owning host identity; hosts use it on graceful shutdown so reconnecting
does not have to wait for the old lease. The public host exposes this as `close`.

Consumers negotiate `cameras.authoring.v1` plus `arrangementPanel` before attaching this panel protocol.
Capture-only consumers need Core+Cameras, never the menu or bridge. Render capabilities independently
advertise authored visibility. Generic synchronization and the production recovery matrix remain
separate work.
