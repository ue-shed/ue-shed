# Functional design

## Pure core, Effect shell

Keep decisions in pure functions. Use Effect for I/O and lifetimes.

Pure code should handle folds, diffs, validation, state changes, compatibility, scheduling policy, and
timeline edits.

Effect should handle clocks, config, files, processes, sockets, pipes, Unreal, queues, streams, and
telemetry.

Do not wrap pure code in Effect without a reason. Do not hide state in globals. Pass clocks and seeds
when behavior depends on them.

## State

- Prefer immutable values.
- Return the next state instead of mutating shared state.
- Use unions instead of boolean flag bags.
- Put needed mutation behind a small tested interface.
- Make ownership, cancellation, queue limits, and retention clear.
- Prefer object arguments for non-trivial calls.

Domain packages must not depend on Workbench. A test or CLI should be able to run the same behavior.
