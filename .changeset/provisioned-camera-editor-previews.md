---
"@ue-shed/cameras": minor
"@ue-shed/protocol": minor
---

Add opt-in `editorPreviews` to the provisioned live feed. With `editorPreviews: true`,
`ensureProvisionedCameras` previews show the child actors that ChildActorComponents spawn for
editor-only owners, such as spawn-volume previews, using the same rule as
`renderer.editorPreviews` on renders. A host's live preview can then match its captures, including
while a camera set is open and render sessions are refused with `authoring_open`.

The plugin rescans before each batch of preview frames. It restores the original flags when the
feed is cleared or reprovisioned without the option, when the world is cleaned up, when Play
starts, and on shutdown. Saves never write the changed flag. Render sessions, camera panel
previews and the feed now share one reference-counted reveal, so one of them finishing never hides
a preview another still shows.

The request uses provisioning version 5 only when the option is on, so other requests are
unchanged. Status and `getCameraStatus` report `editorPreviews.revealedChildActors` while the feed
shows previews. Older plugins ignore the option, so `ensureProvisionedCameras` fails with the new
`ProvisionedCameraError` code `unsupported_capability`. Retry without the option to fall back. A
missing visibility echo (version 4) now carries the same code. The provisioning contract adds
`editorPreviews` and version 5, and `CameraStatus` adds optional `editorPreviews`. Update the plugin
with the package to use the option.
