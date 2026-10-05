# Provisioned camera contract v1

`EnsureProvisionedCameras` accepts this bounded JSON request through Remote Control. A provisioned
camera is a transient runtime realization, identified by a generated `ProvisionedCameraId`; it is
never a durable Map Review camera record.

Each request carries an expected map and an explicit correlation to a framing candidate, a durable
Review View, or a Map Capture Plan. A camera selects either perspective field of view or
orthographic width through a discriminated projection. The compatibility decoder accepts the
candidate-only and `schemaVersion: 2` perspective request shapes for already-installed clients.
New clients emit the oldest version that carries the request:

- `schemaVersion: 3`: no options.
- `schemaVersion: 4`: a camera carries authored `visibility`.
- `schemaVersion: 5`: the request sets `editorPreviews: true`. Previews then show the child actors
  that ChildActorComponents spawn for editor-only owners, under the same rule as the camera render
  contract's `renderer.editorPreviews`. Version 5 also allows `visibility`.

JSON Schema cannot express the version requirements; the Effect decoder and the plugin enforce
them. A plugin echoes version 4 or 5 in its status when it honoured that request. For version 5 it
echoes the version in failures too, and reports `editorPreviews.revealedChildActors` while the
feed shows previews. A response to a version 5 request without the echo comes from a plugin that
ignored the option.

The editor returns the same correlation for every provisioned camera. Array index remains a live
frame transport position, never durable identity.
