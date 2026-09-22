# Shared world preparation

Status: DONE — implemented, unreleased

Implement the package boundary agreed after the World Partition investigation. The public
`@ue-shed/world` Effect service and independently enabled `UEShedWorld` editor plugin own temporary
actor/area loading. Actor capture requests include surrounding context. Cameras consume the shared
capability; saved-package parsing remains in `unreal-assets`.

Acceptance:

- Versioned wire authority, validated requests, explicit map/world identity, and truthful readiness.
- Read-only planning and actor inventory for requested areas, including unloaded descriptors.
- Scoped renewable leases, independent overlapping ownership, bounded dependency sets, replaceable
  areas, Data Layer conflict detection, and recovery after lost responses or client interruption.
- Actor-context capture helper and shared native preparation for the existing renderer.
- Headless CLI access, package/release/plugin distribution wiring, and public usage documentation.
- Portable schema/lifecycle tests and real Unreal selective-loading/lifecycle evidence using a
  streaming-enabled generic fixture. Run repository checks and relevant Unreal checks.

The first capability targets editor worlds. Nested actor containers that cannot be safely resolved
are explicit unsupported results. Runtime streaming and portable descriptor codec expansion remain
separate increments; do not pretend either is implemented by editor loading.

Implemented `@ue-shed/world`, `UEShedWorld`, `renderPreparedCamera`, optional preparation in
`camera render`, and `world request`. Camera native preparation shares the lease manager. Public
schemas, release metadata, package exports, plugin graph and usage documentation are wired.

Validation on 2026-09-10:

- `pnpm check:repository`: passed; 189 test files and 1,131 tests passed. Environment-gated
  integrations were reported as skipped, not treated as live evidence.
- `pnpm check:precommit`: passed after the final TypeScript lifecycle changes.
- Focused world, camera and CLI tests: 18 passed after cancellation and cleanup changes.
- `pnpm test:release:packages`: 18 tarballs passed clean offline consumer conformance.
- `pnpm test:unreal-plugins`: all eight plugins built against UE 5.7.4; seven automation tests
  passed, including streaming-enabled selective loading, an out-of-region hard dependency,
  overlapping ownership, replacement, expiry, cancellation, world change and camera preparation.

Two existing CLI process tests needed explicit 20-second budgets, consistent with adjacent process
tests; their default five-second budgets failed under the full parallel suite. Their assertions
remain intact. Unrelated parser conformance and the full `check:unreal` fixture suite were not rerun;
the targeted plugin automation supplies live evidence for this change.

The living contract is [world preparation](../../docs/products/world-preparation.md). Runtime
streaming, nested containers and offline descriptor codecs remain outside this increment.

Release hardening on 2026-09-22:

- Start renewal windows after synchronous loading and snapshot construction, including replacement.
- Separate the 128-active-lease budget from 4,096 reserved/retained recovery slots. Never evict a
  retained identity early; existing leases can still release at capacity. Exhaustion reports retry
  timing.
- Preserve caller/cleanup defects and interruption at the scoped boundary, including combined work
  and restoration failures. Rename the single-poll API to `checkReady` before first publication.
- Add regressions for lost replacement responses, slow loads, active/recovery exhaustion, safe
  release at capacity and expiry recovery.
- `pnpm check:repository`: 212 test files / 1,245 tests passed; 83 environment-gated tests skipped.
- Focused world/camera tests: 23 passed. Packed-package conformance: 18 tarballs passed in a clean
  offline consumer.
- Unreal 5.7.4 and 5.8.2: all ten plugins compiled; all 18 automation tests passed on each.
- Accommodate UE 5.8 clearing viewport pilot locks before world cleanup; preserve ownership checks
  outside world teardown. The existing camera map-change regression caught and verified this fix.

This is targeted release evidence for world preparation; the full `pnpm check` and `check:unreal`
fixture gates still belong to preparation of the final release candidate.
