---
"@ue-shed/engine": minor
"@ue-shed/cameras": minor
"@ue-shed/game-text": minor
---

Expose typed supervisor-resolution and review/map-tile capture/release failures instead of `unknown`.
Supervisor resolution reports `ProcessSupervisorUnavailable` with the original Node failure in
`cause`; explicit executable overrides retain their existing behavior. Map-tile ports expose named
unions of their existing tagged transport, protocol and timeout failures. Restoration refusals now
report `MapTileCaptureRestorationError`, retain the decoded response and keep the run owned until
release succeeds. Host ports that previously returned arbitrary failures must classify them into
the declared unions, using Effect's tagged `UnknownError` at a foreign throwing API boundary when
necessary. Capture results, RPC requests, polling, release ordering and cancellation are unchanged.

Review capture ports now expose `ReviewCaptureError`, retaining the existing
`ReviewCaptureConnectionError` and its concrete nested causes, plus tagged `UnknownError` for
unclassified host-boundary throws/rejections. Known host failures must retain their cause and
truthful guidance through the connection error. Per-view failure outcomes, endpoint resolution,
resource scopes and interruption are unchanged.

Package text diff counters now validate as non-negative integers, matching the cardinalities
`diffPackageText` produces. This tightens the TypeScript-owned result schema for custom producers;
it does not constrain authored Unreal numeric values or a host's quality policy. Source quality
hydration also preserves the receiver of host-supplied finding-list methods.
