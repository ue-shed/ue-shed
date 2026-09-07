# Capture inspection v1

`InspectMapCaptureSelection` requires `cameras.capture-selection.v1`. It reads selection in the
current editor world, rejects PIE and selections outside 1–1024 actors, and combines finite component
bounds. `skippedActorPaths` identifies actors without usable bounds or in another world. Ready bounds
must satisfy min <= max on every axis; planar/point selections are valid. Host plan fitting supplies
positive XY extent. The operation neither modifies selection nor loads additional regions.

`InspectMapCaptureReadiness(ExpectedMapPath)` requires `cameras.capture-readiness.v1` and applies to
Lit capture. `ready` is true exactly when `blockers` is empty. It checks map identity, rendering,
streaming, viewport locking/overrides, screenshot use, PIE and capture ownership. It does not reserve
resources, load regions, or guarantee visual completeness. Capture execution repeats shared checks.

The running operation's optional phase/elapsed/count/current-tile fields are telemetry for the current
batch. `currentTile` is absent during whole-map exposure warmup. Existing responses without these
fields remain valid. Terminal responses and publication rules are unchanged.
