# Plugin-only map capture freeze experiment

This records the earlier SceneCapture experiment. The shipped Lit-camera backend now owns scene
freezing automatically; see the [current capture behavior](../products/map-capture.md).

## Result

A useful freeze is feasible inside the Cameras editor plugin on stock Unreal Engine 5.7.4.
No game-code changes, saved material changes, or engine fork were required. A controlled rendered
material test verified both game-time and real-time (Ignore Pause) expressions remain constant
across separate capture requests and animate again after resume.

Freezing did **not** resolve the large lighting discontinuities in the tested lookdev tile grid.
The experiment should remain opt-in diagnostic infrastructure. Shared exposure and coordinated
render history remain necessary work for high-detail tiled capture; this result does not establish
that tiling cannot look good.

## Implementation and scope

The `UEShedCamerasEditor` module registers two experimental console commands:

```text
UEShed.MapCapture.Freeze time
UEShed.MapCapture.Resume

UEShed.MapCapture.Freeze scene
UEShed.MapCapture.Resume
```

`time` captures the current editor world's real and game timestamps and supplies them through a
world-scoped `FWorldSceneViewExtension`. Both editor views and scene captures use those timestamps.
Engine frame counters and render deltas continue; global application time is unchanged. The
extension excludes other worlds. Exposure and render policy are unchanged to isolate this experiment.

`scene` additionally disables existing enabled primary actor and component ticks. Resume restores
those exact enabled states and leaves originally disabled ticks alone. The session survives tile
request boundaries. A duplicate freeze is rejected, preserving the original snapshot.

Resume is explicit after the capture operation, including failures. World cleanup, starting PIE,
module shutdown, or a 600-second inactivity watchdog also release the session. For long capture
runs, `UEShed.MapCapture.KeepAlive` renews that lease without replacing the frozen timestamps or
original tick snapshot. An expired session is not recreated by KeepAlive. The watchdog executes when the
editor ticker can run; it cannot interrupt a synchronous capture already occupying the game thread.
This diagnostic command is not yet an operation-owned public capture policy, and is not recorded in
the v1 tile request or manifest. It must not be silently enabled in published runs.

This is not a universal simulation pause. Timers, custom editor tickers, secondary tick functions,
newly spawned actors, Niagara world-manager simulation, GPU particle updates, externally supplied
material parameters, and custom clocks are not comprehensively suspended. It does not snapshot or
restore arbitrary properties changed by those systems. No project-specific adapter is required or
included. These limits are why the command is explicitly experimental.

## Evidence

The same disposable stock-engine host as the earlier quality audit loaded the supplied lookdev
content and copied rendering configuration. Native game and middleware binaries were not loaded.
Source files and a project descriptor were available on this pass, but built game binaries were
absent. Results establish behavior in this host, not complete native-project atmosphere fidelity.

The map region was 32,768 world units square, captured from Z 60,000 at 32 units per pixel. A whole
1,024-pixel reference and four 512-pixel tiles used the same `full_fidelity` profile and 16-pixel
gutters. Every mode received a discarded initial tile batch. Normal-order, repeat, reversed-order,
and separate-request captures were compared. Separate requests had 1.1-second gaps. Additional
separate-request comparisons enabled fog and volumetric fog together.

Mean absolute RGB differences below are on the 0–255 scale. These are image differences, not a
perceptual quality score or a seam-local measurement.

| Comparison                                     |  Live | Frozen time | Frozen time + primary ticks |
| ---------------------------------------------- | ----: | ----------: | --------------------------: |
| Same tile order, repeated                      |  0.46 |        5.07 |                        1.25 |
| Normal versus reversed batch order             | 26.94 |       23.21 |                       27.14 |
| Batched versus separate requests               | 26.83 |       23.47 |                       27.03 |
| Whole image versus four-tile image             | 39.55 |       36.18 |                       40.36 |
| Fog enabled, separate requests, reversed order | 0.152 |       0.025 |                       0.049 |

The large order-dependent and whole-versus-tiled differences persist during the freeze. Frozen
normal-order repeats were not uniformly more stable. Modes were tested sequentially at different
scene timestamps, with renderer caches still evolving; small between-mode differences do not
isolate causality or prove a regression. The fog comparison became more repeatable, but a small
repeat difference does not mean its spatial lighting or seams are correct.

Separate controlled material tests used transient unlit cubes with sinusoidal emission, one driven
by ordinary Time and the other by Time with Ignore Pause enabled. Four samples 1.1 seconds apart
produced these interior RGB means:

| State   | Ordinary Time      | Ignore Pause       |
| ------- | ------------------ | ------------------ |
| Live    | 199, 238, 238, 200 | 213, 151, 91, 127  |
| Frozen  | 197, 197, 197, 197 | 130, 130, 130, 130 |
| Resumed | 241, 234, 188, 118 | 137, 89, 142, 207  |

This verifies the clock override independently of the lit map's exposure and renderer history.
All ordinary lookdev capture receipts reported clean map packages before and after. The subsequent
transient fixture actors were discarded in the disposable host without saving any source asset.
Primary tick enumeration verified all enabled ticks were disabled during the scene freeze and all
original flags restored afterward. A duplicate freeze preserved the first session. Opening an empty
map released the old session and allowed a new one.

The plugin also includes `UEShed.Cameras.MapCapture.FreezeState`, an Unreal automation test covering
world isolation, fixed render times, continuing render delta, tick restoration, initially disabled
components, and time-only mode. The targeted CamerasEditor build and this test are the appropriate
small native checks; this investigation does not claim the full repository or all-plugin gate.

Private requests, responses, PNGs, metrics, material checks, build/test logs, and an interactive
comparison are retained under ignored `out/map-capture-audit/freeze/`. No studio content is added to
the plugin or public fixtures.

## Consequence for capture design

Keep the tile pyramid and bounded render targets. A frozen scene moment can support a future
operation-owned asynchronous capture session, but it does not replace a shared exposure policy,
tile-aware camera/lighting coverage, or genuine render-frame warmup. Finest-resolution tiles can
still supply lower pyramid levels without allocating one unbounded full-map render target.

The earlier audit's master-image approach remains a bounded comparison reference, not the required
architecture for large, high-clarity maps. The next quality experiment should isolate exposure and
render history while holding this same scene moment fixed.
