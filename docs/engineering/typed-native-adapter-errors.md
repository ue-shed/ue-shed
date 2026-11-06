# Typed native adapter failures

The next release replaces four public `unknown` error channels from 0.26.0. The source of
truth remains the owning adapter; downstream hosts should consume the new declarations rather
than assert an error type locally.

| Public operation                | Error contract                 |
| ------------------------------- | ------------------------------ |
| `processSupervisorExecutable`   | `ProcessSupervisorUnavailable` |
| `MapTileCapturePortApi.capture` | `MapTileCaptureError`          |
| `MapTileCapturePortApi.release` | `MapTileCaptureReleaseError`   |
| `ReviewCapturePortApi.capture`  | `ReviewCaptureError`           |

The engine exports `ProcessSupervisorUnavailable` from its package entry point. It retains the
original Node package-resolution failure in `cause`, names the optional package, and tells a
host to install the matching package or provide an explicit executable path. A configured path
still bypasses package resolution, including when the path does not exist: the operation using
the executable remains responsible for checking or launching it. No discovery, validation or
process lifetime changed.

The Cameras error unions retain the existing transport, protocol, schema, correlation and timeout
failures. The Remote Control adapter returns those same failure objects without rewrapping
them. A release reply that fails the existing restoration check now produces
`MapTileCaptureRestorationError` with the same message, run identity, reconciliation guidance and
the decoded reply in `cause`. It still leaves the run owned until a later release succeeds.
Capture results, requests, polling cadence, timeouts, overlap between capture and ingestion,
cleanup order and interruption are unchanged.

The Review capture port exposes `ReviewCaptureError`: the existing
`ReviewCaptureConnectionError` or Effect's `Cause.UnknownError` at a foreign throwing boundary.
The Remote Control implementation keeps its existing connection error and nested transport, schema,
contract or renderer cause. Host adapters with a known failure should classify it as
`ReviewCaptureConnectionError` with truthful recovery guidance and the original failure in `cause`.
Unclassified foreign rejections retain their original value through `Effect.try`/`tryPromise`.
Per-view connection failures still become `capture_connection_failed` outcomes with their cause
logged; defects and interruption continue to propagate rather than becoming capture outcomes.
Endpoint selection remains evaluated per capture, and capture/session/resource scopes are unchanged.

Host implementations must return one of the declared tagged failures. At a foreign API that
throws or rejects without a typed contract, `Effect.try` and `Effect.tryPromise` produce the
included `Cause.UnknownError`, retaining the original cause. Use a specific declared failure
when it is known; do not replace a known error with `UnknownError` or use an assertion to erase
the channel. The existing orchestration error still retains the port failure as its cause.

## Release and consumption

The changeset requests minor releases for `@ue-shed/engine`, `@ue-shed/cameras` and
`@ue-shed/game-text`. Tightening
host-port implementation types and changing the supervisor-resolution/restoration failure
representation can require consumer source changes. The fixed public suite group advances
together; this should be consumed as the next 0.x minor, not silently substituted into 0.26.0.
No package version or downstream dependency pin was changed by this cleanup.

The release also adds nominal brands to existing schema error classes. Consumers should construct
these errors through their exported classes instead of assembling structurally matching objects.
Their serialized fields are unchanged.

After the suite is released, Electroswag can update its pinned packages together, rerun installation
and typechecking, and replace its generic recovery with tagged handling. Supervisor resolution can
handle `ProcessSupervisorUnavailable`; direct tile ports can use the two named error unions and
honor `MapTileCaptureRestorationError.nextStep`. Review capture hosts should use
`ReviewCaptureError` and preserve `ReviewCaptureConnectionError.cause` when translating failures.
Electroswag remains pinned to 0.26.0 until a separately authorized suite release and consumer update.
Neither library declares a new stable Unreal API or changes the C++ wire contracts. Live Unreal
5.7/5.8 verification and the normal trusted release gates remain separate release evidence.

The Game Text portion preserves the receiver of host-provided finding-list hydration methods.
Its package-text diff result validates the five counters as non-negative integer cardinalities,
matching `diffPackageText`'s zero-initialized increments. Custom producers that emitted fractional,
negative or non-finite counts must correct those results. Authored Unreal numeric values and host
quality policies retain their existing contracts.
