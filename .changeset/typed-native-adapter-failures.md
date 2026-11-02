---
"@ue-shed/engine": minor
"@ue-shed/cameras": minor
---

Expose typed supervisor-resolution and map-tile capture/release failures instead of `unknown`.
Supervisor resolution reports `ProcessSupervisorUnavailable` with the original Node failure in
`cause`; explicit executable overrides retain their existing behavior. Map-tile ports expose named
unions of their existing tagged transport, protocol and timeout failures. Restoration refusals now
report `MapTileCaptureRestorationError`, retain the decoded response and keep the run owned until
release succeeds. Host ports that previously returned arbitrary failures must classify them into
the declared unions, using Effect's tagged `UnknownError` at a foreign throwing API boundary when
necessary. Capture results, RPC requests, polling, release ordering and cancellation are unchanged.
