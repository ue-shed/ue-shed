# Effect

Effect is the application core and the canonical public workflow type. It owns composition for
stateful and effectful modules, not only code at external boundaries.

## Compiler and lint tooling

`pnpm run lint` and `pnpm run lint:fix` use the Effect-patched Oxlint through
`@effect/tsgo`, with the recommended Effect preset alongside our custom rules.
Use `pnpm run lint:fix --fix-suggestions` to apply suggested simplifications.
The simplification diagnostics are warnings; correctness errors fail the existing
static and repository gates. The lint commands build the TypeScript packages
first so type-aware lint can resolve their declarations in a fresh checkout.

`pnpm run tsrs --noEmit -p packages/protocol/tsconfig.json` runs the installed
Rust compiler for a selected project. Builds and the existing typecheck commands
retain their current compilers. Both wrappers use bundled binaries without
rewriting the package store. Upgrade `@effect/tsgo`, `tsrs`, `oxlint`, and
`oxlint-tsgolint` together against the
[upstream compatibility table](https://github.com/Effect-TS/tsgo#supported-package-versions).

## Use it for

- services and dependency wiring;
- resource setup and cleanup;
- Unreal, files, processes, sockets, and pipes;
- concurrency, cancellation, schedules, and timeouts;
- bounded queues, streams, and reconnect flows;
- config, Effect Schema, typed errors, logs, traces, and metrics.

Keep pure calculations as plain functions. Effect is not part of the wire protocol.

## Rules

- Give each external library one adapter service.
- Expose every stateful or effectful module through `Context.Service` and layers.
- Name callable public and non-trivial internal operations with `Effect.fn("Domain.operation")`.
  Parameterless service operation properties attach the same per-execution name with
  `Effect.withSpan("Domain.operation")`; see [the source migration](effect-operation-properties.md).
- Use Effect Schema for TypeScript-owned domain values and boundary validation.
- Expose domain actions, not raw library clients.
- Use Layers for setup and tests, not hidden global access.
- Scope resources and release them on success, failure, and cancellation.
- Keep errors typed until the right boundary can translate them.
- Make timeouts, retries, and queue limits explicit.
- Adapt Promise APIs once. Avoid Promise/Effect ping-pong.
- Restrict `Effect.run*` to runtime exits and explicit Electron, browser, Node, or third-party
  framework adapters.
- Use the simplest concurrency tool that works.

Pure transformations remain plain immutable functions and compose inside workflows. An exemption
for a measured hot path requires a benchmark and a documented adapter boundary.

`pnpm effect:architecture` enforces a zero-debt policy for runtime exits, public Promise surfaces,
direct environment reads, raw fetch calls, and unmanaged long-lived resources. Approved sites are
named files at foreign-framework boundaries, never count baselines or directory-wide exceptions.
Every `Context.Service` must have live/test layer evidence and named operations. A measured hot-path
exception also requires a repeatable benchmark, explicit cleanup ownership, and a written rationale.

Layers compose through requirements. A layer factory may take configuration, but never a Layer or a
service: it requires the service and the composition root provides it, so a host or a test can
replace it. A `make*` constructor that only its own module uses stays private. Test layers are
complete, behaviourally honest fakes: they take the whole service, or fill what a test leaves out
with what that fake's state really answers (an empty feed, an unindexed project). They never fill
it with `Effect.die("not stubbed")`. The architecture check rejects exported factories that take
a Layer and exported `make*` functions no other module uses.

## Composition roots and exits

- The CLI builds `CliLive` once and exits through the single `Effect.runPromiseExit` in
  `apps/cli/src/index.ts`.
- Workbench main builds `WorkbenchLive` once as a `ManagedRuntime`; Electron lifecycle adaptation and
  disposal stay in `apps/workbench/src/main/main.ts`.
- The renderer builds one `ManagedRuntime` from browser-safe client services. Promise-shaped preload
  calls are adapted once in renderer transport files; Solid owners launch and interrupt work through
  `@ue-shed/ui`'s Effect adapter.
- Node sockets, Electron callbacks, preload IPC, and browser lifecycle callbacks are foreign adapters.
  Their files own registration and cleanup and are named explicitly by the architecture checker.
- The Game Text Node query adapter in `packages/game-text/src/joined-query-node.ts` preserves
  the published synchronous `TextCorpusQuery` API over pinned positioned Node reads and the
  bounded Effect cache. It accepts effects without service requirements and rejects asynchronous
  work. The caller's shared-index scope owns and closes the pinned handles; query data and hosts
  do not own additional runtimes or reader lifetimes.
- The Game Text search worker is a Node message boundary. The host's retained index scope owns
  startup, its separately pinned reader and termination; only bounded, schema-validated search
  pages cross the boundary. Shared cancellation flags interrupt scans without waiting for a
  worker message. Failed or interrupted query-cache lookups have zero TTL; completed pages stay
  cached. The Workbench and CLI keep their existing runtimes.
- Retained Game Text models use `RcRef` for reader and worker pins. A preparation scope holds the
  candidate until an uninterruptible publication transfers a pin to its host owner. Each operation
  borrows the published generation for its complete scope; retiring an owner does not close active
  borrowers. Rejected preparations release their candidate without retiring the published model.

## Tests

Test success, typed failure, cancellation, cleanup, timeout, retry limits, and concurrency. Use real
temporary files, local servers, pipes, and child processes when they are cheap.

Check `effect-solutions` when supported. Otherwise use current official docs and installed source.
Choose one Effect major version and do not mix examples from other versions.
