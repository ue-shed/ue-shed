---
"@ue-shed/cameras": minor
---

Camera authoring bridge failures name their cause. UEShedCameraAuthoringBridge and its native setup collapsed about 50 causes into five statuses (`busy`, `stale`, `unavailable`, `invalid`, `detached`) that only the prose told apart.

Requests carrying `codedFailures: true` receive a stable `code`, for example `scope_mismatch`, `revision_conflict`, `editor_owned`, `camera_not_in_arrangement` or `setup_owned`. The status stays the same coarse category. The camera-authoring v1 request contract carries this opt-in, and `CameraBridgeResponse` accepts the optional `code` (lower snake case, at most 64 characters). `readyCameraBridge` passes it on as `CameraBridgeError.cause`.

The SDK opts in by default and respects an explicit `false`. New plugins preserve the exact legacy three-field failure shape when the flag is absent or false, including setup failures. Older plugins ignore the flag, and their responses still decode. Existing `code` categories on `CameraBridgeError` are unchanged.
