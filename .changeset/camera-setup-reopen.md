---
"@ue-shed/cameras": minor
"@ue-shed/protocol": minor
---

Let the native camera panel reopen a saved set for its selected subject. `makeCameraSetupHost`
accepts optional `open` and `sets` callbacks; with both, each setup poll negotiates `reopen` and
lists the host's saved sets (`CameraSetupSavedSet`, built with `cameraSetupSavedSet`), and the host
opens a set when the panel asks. The camera-authoring/v1 setup contract gains optional `reopen`,
`sets`, `canOpen`, `open`, `selection.actorGuid` and the `setup_open` request. The bridge only adds
reply fields for hosts that sent `reopen: true`, so older hosts and older plugins are unaffected.
