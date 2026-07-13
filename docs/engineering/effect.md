# Effect

Use Effect for TypeScript code that talks to the world or owns a lifetime.

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
- Use Effect Schema for TypeScript-owned domain values and boundary validation.
- Expose domain actions, not raw library clients.
- Use Layers for setup and tests, not hidden global access.
- Scope resources and release them on success, failure, and cancellation.
- Keep errors typed until the right boundary can translate them.
- Make timeouts, retries, and queue limits explicit.
- Adapt Promise APIs once. Avoid Promise/Effect ping-pong.
- Use the simplest concurrency tool that works.

## Tests

Test success, typed failure, cancellation, cleanup, timeout, retry limits, and concurrency. Use real
temporary files, local servers, pipes, and child processes when they are cheap.

Check `effect-solutions` when supported. Otherwise use current official docs and installed source.
Choose one Effect major version and do not mix examples from other versions.
