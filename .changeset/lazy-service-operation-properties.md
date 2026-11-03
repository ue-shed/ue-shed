---
"@ue-shed/observability": minor
"@ue-shed/unreal-connection": minor
"@ue-shed/plugin-distribution": minor
"@ue-shed/unreal-assets": minor
"@ue-shed/map-history": minor
"@ue-shed/localization": minor
"@ue-shed/cameras": minor
"@ue-shed/world": minor
"@ue-shed/game-text": minor
"@ue-shed/game-text-corpus": minor
---

Expose parameterless service operations as reusable Effect/Stream properties. Callers execute
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
