# @ue-shed/observability

## 0.29.0

## 0.28.0

## 0.27.1

## 0.27.0

### Minor Changes

- 84915c0: Expose parameterless service operations as reusable Effect/Stream properties. Callers execute
  `yield* ids.generate` rather than `yield* ids.generate()`; parameterful operations remain functions.
  Implementations retain per-execution work, original service and scope requirements, fresh IDs and
  named tracing. Native schemas and wire representations are unchanged. Hosts must migrate their supplied service
  implementations and local checked-dispatcher adapters when adopting the coordinated suite release.
  See `docs/engineering/effect-operation-properties.md` for migration guidance and the consumer audit.

    Game Text progress hooks and corpus comparison layers preserve their supplied error types rather
    than widening them to `unknown`. Private viewer read/search ports use the same generic error
    parameterization. Recoverable file/JSON/schema boundaries retain their original tagged failures
    and nested causes; trusted construction failures remain defects.

    Export a tagged `GameTextWorkspaceHostFailure` constructor in place of the former untagged host
    failure interface. Host adapters supply the original failure as `cause` with the existing recovery
    guidance. Reject non-finite TypeScript measurement/cache metadata and localization memory budgets,
    while retaining finite fractional values and existing host policy. Wait for cancelled plugin archive
    IO to settle before releasing staging resources, including cancellation through the owning fiber.

## 0.26.0

## 0.25.0

## 0.24.0

No direct behavioral change: released to keep the suite aligned.

## 0.23.0

## 0.22.0

## 0.21.0

## 0.20.0

### Patch Changes

- No direct behavioral changes; version advanced for suite alignment.

## 0.19.0

### Patch Changes

- No direct behavioral changes; version advanced for suite alignment.

## 0.18.0

## 0.17.1

## 0.17.0

## 0.16.2

## 0.16.1

No direct behavioral changes; version advanced for suite alignment.

## 0.16.0

## 0.15.0

## 0.14.0

### Patch Changes

- d8eca33: Upgrade Effect and its integrations to stable 4.0.4. Update renamed schema and configuration APIs,
  JSON Schema validation, synchronous cache queries, retained resource cleanup, and Remote Control
  response handling while preserving authoritative wire contracts and existing workflow behavior.
  Published libraries now require the application to provide `effect@^4.0.0` as a peer dependency,
  and `@ue-shed/observability` also requires `@effect/opentelemetry@^4.0.0`. Install these in the
  application (or reuse compatible existing versions) so UE Shed shares the application's Effect
  runtime. Workspace development and tests remain pinned to Effect 4.0.4 through the catalog.

## 0.13.0

## 0.12.0

## 0.11.0

## 0.10.0

No direct behavioral change. Align with the UE Shed 0.10.0 suite and exact internal dependency pins.

## 0.9.3

No direct behavioral change. Align with the UE Shed 0.9.3 suite and exact internal dependency pins.

## 0.9.2

## 0.9.1

## 0.9.0

Align this package with the synchronized UE Shed 0.9.0 suite and exact internal dependency pins. There is no direct behavioral change.

## 0.8.0

## 0.7.1

Align this package with the synchronized UE Shed 0.7.1 suite and exact internal dependency pins. There is no direct behavioral change.

## 0.7.0

### Minor Changes

- Align this unchanged package with the synchronized UE Shed `0.7.0` release. There is no direct behavioral change.

## 0.6.0

### Minor Changes

- ff117a0: Add a headless selected Unreal target service with operation-scoped endpoint capture. Changing
  selection affects subsequent operations while active operations and their children retain their
  starting target. Review capture adapters can resolve an endpoint from an Effect at execution time.

    Expose browser-safe camera and world-observation contracts and pure helpers, plus an observability
    metrics entry point that does not load telemetry exporters. Existing root exports remain available.

## 0.5.1

### Patch Changes

- Align this unchanged package with the synchronized UE Shed `0.5.1` patch release. There is no
  direct behavioral change.

## 0.5.0

### Patch Changes

- Align this unchanged package with the synchronized UE Shed `0.5.0` suite release. There is no
  direct behavioral change.

## 0.4.0

### Patch Changes

- Align this unchanged package with the synchronized UE Shed `0.4.0` suite release. There is no
  direct behavioral change.

## 0.3.0

## 0.2.0

### Patch Changes

- 51c0e1b: Align the unchanged public packages with the synchronized UE Shed `0.2.0` suite release.

## 0.1.0

### Patch Changes

- 9c2cdce: Publish the stable 0.1 package set, including the headless Game Text and World Log Map History
  integration packages.
