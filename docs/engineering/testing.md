# Testing

Write many useful tests, not many shallow tests. Test at the lowest layer that can prove the behavior.

## Test types

- **Pure tests:** folds, diffs, validation, state changes, and scheduling.
- **Property tests:** codecs, round trips, ordering, convergence, and bounds.
- **Effect tests:** errors, cancellation, cleanup, timeouts, retries, and concurrency.
- **Integration tests:** real temp files, local servers, pipes, processes, and frames.
- **Protocol tests:** valid and bad messages, limits, versions, gaps, and reconnects.
- **Unreal tests:** real fixture assets, DataTables, rollback, Save, actors, focus, and recovery.
- **UI tests:** visible states and user actions through public services.
- **Visual tests:** shared primitives and a small set of key product screens.

Use mocks only when the real boundary is too slow, unsafe, or unavailable. A mock must not define the
contract it claims to test.

## Rules

- Test success and failure.
- Test cleanup and cancellation for every owned resource.
- Test slow consumers, stale sessions, reconnects, and partial support.
- Share protocol fixtures between TypeScript and C++.
- Keep the Unreal fixture contract readable without launching Unreal.
- Test UI meaning, not DOM shape or generated CSS names.
- Add a regression test for every fixed bug.

Coverage reports help find missed paths. A percentage is not the goal. Critical state machines,
codecs, errors, and recovery need deep coverage.
