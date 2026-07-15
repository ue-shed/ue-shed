# Plan 010: Put every external system behind scoped Effect services

> **Executor instructions**: Execute this as an adapter migration, not a domain redesign. Run each
> focused test before continuing and update the plan index on completion.
>
> **Drift check (run first)**: `git diff --stat 2f7ac8b..HEAD -- packages/unreal-connection packages/unreal-assets packages/authoring/src/persistence.ts packages/authoring/src/session-service.ts packages/cameras packages/asset-audits/src/live.ts packages/game-text apps/workbench/src/main/main.ts`

## Status

- **Priority**: P0
- **Effort**: XL
- **Risk**: HIGH — files, child processes, HTTP, sockets, and named-pipe cleanup are affected
- **Depends on**: Plan 009
- **Category**: migration
- **Planned at**: commit `2f7ac8b`, 2026-07-16

## Why this matters

Existing functions return Effect, but they close over Node globals, configuration, and manually
managed resources. Effect becomes the core only when authority and lifetime are visible in the
environment and provided by layers.

## Current state

- `packages/unreal-connection/src/index.ts:62-120` owns raw `fetch`, timeout, decoding, and telemetry
  in a free function; lines 144-236 return an ad-hoc connection object.
- `packages/unreal-assets/src/index.ts:288-327` reads `process.env` and invokes a promisified child
  process directly; lines 394-421 recursively walk Node files.
- `packages/authoring/src/session-service.ts:227-374` builds a semaphore and directly uses Node file
  APIs inside a factory, with clock/UUID supplied through a manual dependency bag.
- `packages/cameras/src/index.ts:207-287` exposes Promise close and callback subscribe from a named
  pipe server. Acquisition is not scoped. Lines 293-320 are a second raw Remote Control client.
- Asset audit and camera modules contain additional raw Remote Control fetch implementations.

## Target service graph

- `RemoteControlClient`: one HTTP adapter for Unreal calls, status classification, schema decoding,
  timeout, idempotency-aware retry, and safe telemetry.
- `UnrealAuthoringConnection`: capability-negotiated authoring operations, built from
  `RemoteControlClient`.
- `AssetReader`: saved-package process invocation and discovery, using configured executable,
  timeout, file system, and command/process services.
- `AuthoringSessionRepository` and `ReviewRepository`: atomic durable storage and quarantine rules.
- `CameraFeed`: scoped named-pipe ownership; exposes `Stream<CameraFrame>`, latest state, and metrics,
  never a Promise close method or raw callback subscription.

Each module uses `Context.Service`, `Layer.effect`, `Effect.fn`, Effect `Config`, and scoped resource
acquisition. Concrete live layers and test layers are public; implementation helpers remain private.

## Commands you will need

| Purpose          | Command                                                                                                   | Expected on success                             |
| ---------------- | --------------------------------------------------------------------------------------------------------- | ----------------------------------------------- |
| Adapter tests    | `pnpm test:fast -- packages/unreal-connection packages/unreal-assets packages/cameras packages/authoring` | pass                                            |
| Typecheck        | `pnpm typecheck`                                                                                          | exit 0                                          |
| Full gate        | `pnpm check`                                                                                              | exit 0                                          |
| Real Unreal gate | `pnpm check:unreal`                                                                                       | pass when local Unreal verification is required |

## Scope

**In scope**: the adapter modules listed above, their manifests/exports/tests, and minimal caller
changes required to provide services temporarily.

**Out of scope**: domain workflow service conversion, CLI command design, Electron IPC design,
renderer/Solid, wire shape changes.

## Steps

### Step 1: Centralize Remote Control transport

Create `RemoteControlClient` in `@ue-shed/unreal-connection`. Its named request operation constructs
the request, executes it, classifies status before body decoding, decodes the envelope and result
schema, maps failures, applies the configured timeout, and emits spans. Prefer Effect v4 HttpClient
when its platform layer is compatible; otherwise keep raw fetch entirely inside this adapter and
wire the Effect cancellation signal.

Replace raw Remote Control calls in cameras and asset audits with this service. Do not make domain
packages depend on a raw client; expose capability-specific adapter services from their owning
modules.

**Verify**: `rg -n "\bfetch\(" packages -g '*.ts'` returns only the approved adapter implementation.

### Step 2: Build AssetReader as a configured service

Move executable selection and timeout to `Config`; do not read `process.env` in operations. Acquire
platform file/process dependencies through the layer. Keep each public operation as `Effect.fn` and
decode unknown output effectfully. Preserve maximum output, timeout, partial-result exit code, and
Windows hidden-process behavior.

**Verify**: existing fixture and commandlet-conformance tests pass with both configured and PATH
reader selection.

### Step 3: Split session behavior from persistence

Extract atomic file storage/quarantine to `AuthoringSessionRepository`. Convert clock and UUID to
Effect services rather than manual function dependencies. The session service may retain its
semaphore but obtains repository, clock, and ID generation from context. Layer acquisition creates
shared state once; callers never call `Effect.runSync` to manufacture a service object.

**Verify**: restart, atomic persist, malformed quarantine, project ownership, and concurrent update
tests pass through live/test layers.

### Step 4: Convert review storage

Move review set/capture-run file operations behind `ReviewRepository`. Preserve path containment and
atomicity rules. Make storage failures typed by operation and path without leaking file contents.

**Verify**: all camera review repository and capture tests pass using temporary directories supplied
by layers.

### Step 5: Scope CameraFeed

Acquire the named-pipe server with `Effect.acquireRelease` in a scoped layer. Adapt socket callbacks
through bounded `Queue`/`PubSub` or `SubscriptionRef`, expose a backpressured `Stream`, and release
all sockets/server handles on success, failure, or interruption. Make queue capacity and overflow
policy explicit and observable.

Keep `CameraFrameDecoder.push` as a direct calculation for now. It is the strongest hot-path
candidate, but all ownership, buffering, subscription, and cleanup around it must be Effect-native.

**Verify**: tests cover listen failure, fragmented frames, multiple subscribers, slow consumer
policy, interruption, and deterministic close with no open handles.

## Test plan

- Convert adapter tests to `it.effect`; use scoped local servers and temp directories.
- Use `Deferred`, `Queue`, and `TestClock` rather than sleeps.
- Provide first-class test layers for Remote Control, reader execution, repositories, clock, and IDs.
- Assert finalizers run when operations succeed, fail, and are interrupted.
- Keep real Unreal/reader conformance lanes; unit fakes do not define those contracts.

## Done criteria

- [ ] External authority is represented by service requirements and layers.
- [ ] Application operations do not read `process.env` or create unmanaged resources.
- [ ] One Remote Control transport implementation exists.
- [ ] Camera feed acquisition and teardown are scoped; consumers receive a Stream.
- [ ] Tests use deterministic Effect synchronization.
- [ ] `pnpm check` exits 0.

## STOP conditions

- v4 platform APIs cannot preserve child-process timeout/output/Windows semantics.
- Named-pipe callback adaptation cannot be bounded without changing the documented data-plane policy.
- Extracting a repository reveals incompatible persistence behavior between CLI and Workbench.
- A retry is proposed without proven idempotency.

## Maintenance note

Adapters translate foreign libraries once. Domain modules must not regain direct Node, Electron,
fetch, or Unreal client access after this plan.
