# Testing

Write many useful tests, not many shallow tests. Test at the lowest layer that can prove the behavior.

## Test types

- **Pure tests:** folds, diffs, validation, state changes, and scheduling.
- **Property tests:** codecs, round trips, ordering, convergence, and bounds.
- **Effect tests:** use `@effect/vitest` for typed errors, services/layers, cancellation, cleanup,
  timeouts, retries, and concurrency.
- **Integration tests:** real temp files, local servers, pipes, processes, and frames.
- **Protocol tests:** valid and bad messages, limits, versions, gaps, and reconnects.
- **Unreal tests:** real fixture assets, DataTables, rollback, Save, actors, focus, and recovery.
- **UI tests:** visible states and user actions through public services.
- **Visual tests:** shared primitives and a small set of key product screens.

Use mocks only when the real boundary is too slow, unsafe, or unavailable. A mock must not define the
contract it claims to test.

## Rules

- Test success and failure.
- Assert expected failures through the typed error channel rather than catching thrown decoder or
  Promise exceptions.
- Test cleanup and cancellation for every owned resource.
- Test slow consumers, stale sessions, reconnects, and partial support.
- Share protocol fixtures between TypeScript and C++.
- Keep the Unreal fixture contract readable without launching Unreal.
- Test UI meaning, not DOM shape or generated CSS names.
- Add a regression test for every fixed bug.

Coverage reports help find missed paths. A percentage is not the goal. Critical state machines,
codecs, errors, and recovery need deep coverage.

## Local verification

Run the portable repository gate with:

```powershell
pnpm check
```

Run every process-level end-to-end journey with:

```powershell
pnpm test:e2e
```

The lanes can also run independently:

```powershell
pnpm test:e2e:cli
pnpm test:e2e:workbench
```

The Workbench command builds the production Electron app before launching it against the committed
fixture. During local iteration, reuse the existing build or open Playwright's interactive runner:

```powershell
pnpm test:e2e:workbench --no-build
pnpm test:e2e:workbench:ui
```

Workbench specs live under `apps/workbench/e2e`. Add route-level actions and accessible locators to
the shared `WorkbenchPage`, and use the shared fixture for app launch, teardown, screenshots, and
traces. Failure artifacts are written under `test-results/workbench`.

Installing dependencies also installs the repository-managed pre-commit hook. The hook runs the
same `pnpm check` gate before Git creates a commit.

### Unreal gate reporting

The ordinary Vitest run prints every environment-gated real-Unreal suite before executing tests. A
gate is reported as `RUN` or `SKIP`, and skipped gates include the exact environment variable or
specialized command that enables them. The final Vitest skipped count should agree with this list;
an unexplained skip is a test-infrastructure defect.

### Solid component interactions

Run Solid component interaction tests independently with:

```powershell
pnpm test:components
```

Vitest keeps Node and component tests in separate projects. Component tests use jsdom, the Solid and
StyleX transforms, Testing Library accessible queries, and user-event interactions. Prefer a small
in-memory implementation of a component's public client contract; keep process, IPC, and native
reader behavior in the CLI and Workbench E2E lanes.

### Coverage discovery

Generate terminal, HTML, and JSON summary reports with:

```powershell
pnpm test:coverage
```

Reports are written to `coverage/`. Coverage includes untouched TypeScript and TSX source files so
zero-coverage modules remain visible, but it intentionally has no percentage threshold. Use it to
choose risk-based tests, not to reward incidental line execution.

V8 coverage only measures code executed inside Vitest workers. CLI and Electron E2E behavior runs in
child processes, so those entry points can appear uncovered even when their external journeys pass.
Read coverage together with `pnpm test:e2e`, not as a replacement for it.

Real Unreal verification remains an explicit, heavier local lane because it builds the fixture
plugins, runs commandlets, and regenerates fixture content before verifying it:

```powershell
pnpm check:unreal
```

This command requires the configured local Unreal Engine installation. Run it before landing changes
to Unreal plugins, fixture generation, or live authoring mutation behavior. The Map Review wire
evidence step (`pnpm test:unreal-review`) additionally needs a fixture editor with Remote Control;
start it with `pnpm fixture:launch-authoring` and set `UE_SHED_REMOTE_CONTROL_ENDPOINT`.
