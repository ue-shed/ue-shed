---
"@ue-shed/protocol": minor
"@ue-shed/cameras": minor
---

Camera status, configure and provisioning failures are now valid, coded JSON. UEShedCameras used to build these responses with `Printf`, so a quote, backslash or control character in a message made the JSON invalid, and authored-preview visibility put prose into the `error` code field.

The plugin now writes failures with the JSON writer. `error` is always a stable code (visibility failures report `invalid-visibility`), prose moves to a new `message` field, and GetStatus and Configure failures gain `status: "failed"`.

- `@ue-shed/protocol`: `CameraControlFailure` describes the wire failure. Decoding stays inside the camera adapter so callers receive its domain error.
- `@ue-shed/cameras`: `getCameraStatus` and `configureCameras` turn a coded failure into a `CameraControlError` that carries `code` (new, optional), instead of reporting it as an invalid response. Provisioning errors include the plugin's `message` beside its code.

All fields are additive, and responses from older plugins still decode. No migration needed.
