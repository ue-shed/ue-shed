# Plan 015: Close the Effect migration with telemetry and zero-debt enforcement

> **Executor instructions**: This plan removes all temporary migration allowlists. Do not mark it
> complete while known architectural debt remains hidden behind broad exceptions.
>
> **Drift check (run first)**: `git diff --stat 2f7ac8b..HEAD -- apps packages extensions scripts docs package.json pnpm-lock.yaml`

## Status

- **Priority**: P1
- **Effort**: L
- **Risk**: MED — telemetry wiring and enforcement touch every runtime but should not change domains
- **Depends on**: Plans 012, 013, and 014
- **Category**: migration
- **Planned at**: commit `2f7ac8b`, 2026-07-16

## Why this matters

Existing code creates spans in several adapters and workflows, but no application runtime installs a
coherent telemetry layer, health is not a shared service, and architecture debt is only countable by
search. The migration is complete only when observability is provided once by runtimes and new code
cannot fall back to scattered `runPromise`, Promise services, env reads, or unmanaged resources.

## Current state

- Named spans exist in Unreal connection, saved assets, authoring sessions, camera review, asset
  audits, and game text.
- There are no `Effect.fn` operations at commit `2f7ac8b`, so operation-level tracing is inconsistent.
- `docs/engineering/observability.md` requires traces, metrics, structured logs, and public health,
  including queue depth/drops/gaps, Apply/Save, camera capture, and discovery/connection.
- Plan 008 introduces a temporary path allowlist for migration debt.

## Commands you will need

| Purpose            | Command                    | Expected on success           |
| ------------------ | -------------------------- | ----------------------------- |
| Architecture check | `pnpm effect:architecture` | exit 0 with no migration debt |
| Typecheck          | `pnpm typecheck`           | exit 0                        |
| Fast tests         | `pnpm test:fast`           | pass                          |
| E2E                | `pnpm test:e2e`            | pass                          |
| Full gate          | `pnpm check`               | exit 0                        |

## Scope

**In scope**: CLI/Workbench telemetry layers, structured logging/metrics/tracing configuration,
shared public health service/state, architecture checker and docs, test telemetry.

**Out of scope**: a hosted observability backend, secrets/credentials, product dashboards, new
domain workflows, high-cardinality payload logging.

## Steps

### Step 1: Define observability policy in layers

Add synchronized v4 OpenTelemetry integration to the pnpm workspace catalog only if its peer version
matches the pinned Effect build; every consuming manifest uses `catalog:`. Build
console/local-development and test telemetry layers. Configure exporter/resource data through Effect
Config with redacted secrets. CLI and Workbench each provide telemetry once at their runtime root.

Do not require a remote exporter for local use. Telemetry setup failures must be visible and follow a
documented startup/degraded policy.

**Verify**: an integration test captures one domain operation span through the actual runtime layer.

### Step 2: Normalize operation instrumentation

Use `Effect.fn("Domain.operation")` for service operations and add safe annotations: operation,
versions, bounded IDs when useful, duration/result/retry count. Add metrics for latency, traffic,
errors, saturation, coverage, queue depth/drops/gaps, camera replacements, and Apply/Save states.

Never attach secrets, raw user data, full object paths when cardinality is unbounded, image bytes, or
payload bodies.

**Verify**: tests assert required span names/attributes and metric updates without snapshotting
unstable timestamps.

### Step 3: Make health a public service

Define schema-owned health state that aggregates configured capability availability, connection,
reader/process health, stream gaps/drops, and telemetry degradation. CLI diagnostics and Workbench
diagnostics consume the same service state. Do not infer health by parsing logs.

**Verify**: tests cover healthy, optional capability absent, reconnecting/degraded, and telemetry-gap
states.

### Step 4: Remove the migration allowlist

Make the architecture checker enforce:

- no `Effect.run*` in packages/extensions or app workflows;
- only named approved runtime/foreign adapters may run an Effect;
- no Promise members in public domain/extension service interfaces;
- no direct `process.env` in application code;
- no raw fetch outside the transport adapter;
- no unmanaged long-lived timers/listeners/sockets/processes;
- every service has a live layer and a test strategy;
- no mixed Effect major versions;
- no direct Effect-family version ranges outside `pnpm-workspace.yaml`; workspace packages use the
  central catalog.

Hot-path exceptions require a benchmark file/command, a narrow adapter boundary, cleanup ownership,
and a documented rationale. Do not allow directories wholesale.

**Verify**: seed one violation per rule in a temporary checker fixture and confirm each fails with a
useful file/line diagnostic; remove fixtures and confirm zero debt.

### Step 5: Record the final architecture

Update architecture and engineering docs with the actual service graph, composition roots, runtime
exits, browser adapter, optional capability layers, telemetry, and hot-path exception process. Remove
all migration wording and stale Effect-shell examples.

**Verify**: documentation examples typecheck as part of the gate or are imported from tested source.

## Test plan

- In-memory telemetry capture for spans/logs/metrics.
- ConfigProvider tests for disabled/local/exported telemetry.
- Health aggregation tests with test service layers.
- Architecture-check fixtures for every forbidden pattern and exception shape.
- Full CLI and Workbench E2E after telemetry is installed.

## Done criteria

- [ ] CLI and Workbench each provide one telemetry layer at the runtime root.
- [ ] Health is schema-owned and shared by headless and Workbench clients.
- [ ] Architecture checker has no legacy allowlist.
- [ ] `Effect.run*`, Promise-domain APIs, direct env reads, duplicate fetch clients, and unmanaged
      resources are absent outside narrow approved adapters.
- [ ] Any hot-path exemption has benchmark evidence and scoped ownership.
- [ ] `pnpm check` and `pnpm test:e2e` pass.

## STOP conditions

- The v4 OpenTelemetry package does not match the pinned Effect build.
- A useful metric requires unsafe/high-cardinality labels; redesign it before proceeding.
- Removing an allowlist entry reveals unfinished work from Plans 010–014.
- A hot-path exception has no repeatable benchmark.

## Maintenance note

The architecture checker is a design boundary, not a style preference. Exceptions stay narrow,
measured, and reviewable.
