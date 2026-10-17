# Types and errors

## Effect Schema first

Effect Schema is the default source for TypeScript-owned data models. Define the runtime schema first,
then infer its decoded and encoded TypeScript types. Do not write a matching interface by hand.

Build related schemas from the base schema with schema combinators: pick fields, omit fields, extend
records, add brands, compose unions, and transform encoded values. Schemas are immutable values, so
“change a schema” means derive a new schema rather than mutate the original.

This applies to domain values, config, stored documents, service input/output, errors, and messages
owned by TypeScript.

## Boundaries

- Treat config, JSON, Unreal results, frames, files, CLI input, and UI messages as `unknown`.
- Validate once at the boundary.
- Use branded IDs for values with different meanings.
- Use unions to rule out invalid states.
- Prefer Effect Schema derivation. Use TypeScript utilities only for shapes that do not need their own
  runtime schema.
- Avoid `any`, unchecked casts, and non-null assertions in domain code.
- Keep needed low-level casts in one tested place. Every type assertion carries a `// SAFETY:`
  comment stating the invariant TypeScript cannot check; in `apps`, `extensions` and `packages`
  source the same comment block also has a `// Verified by:` line naming the tests that fail if the
  invariant breaks. The `anti-slop/require-safety-comment-for-type-assertion` and
  `anti-slop/require-safety-verification` lint rules enforce both.

## Optional values

Optional values are optional properties (`readonly name?: string`), not Effect `Option`. The
repository compiles with `exactOptionalPropertyTypes`, so an absent property and a property set to
`undefined` are different types; omit the property instead of assigning `undefined`, and use
`Schema.optional` (or `Schema.optionalKey`) in schemas. This is a deliberate difference from Effect
coding standards that prefer `Option` everywhere: optional fields keep wire, JSON and schema shapes
identical to the TypeScript types and match the existing code. Use `Option` only inside a workflow
where it composes with Effect combinators, and convert back to an optional field at the boundary.

## Non-null assertions

The non-null assertion `!` is not used in domain code. The one exemption is the Game Text columnar
hot path: typed-array and dense-column indexing in `packages/game-text`, where a bounds check per
read is measurably slower and the column builders already guarantee the index range. The exemption
covers only those named files and is justified by a repeatable benchmark, as `effect.md` requires
for any measured hot-path exception. Elsewhere, narrow with a check, a total function or a typed
error. `typescript/no-non-null-assertion` is enabled outside the exempt files as each package is
cleared of existing uses.

For TypeScript-only boundaries, Effect Schema is authoritative. For TypeScript/C++ wire contracts, the
language-neutral schema is authoritative and the Effect Schema representation must match it. Both
implementations use the same conformance fixtures.

## Errors

Expected failures are typed values. This includes missing capabilities, connection loss, bad input,
drift, conflicts, missing actors, and stream gaps.

Define application errors with `Schema.TaggedError` so their tags and structured fields are
schema-owned. Decode unknown input with `Schema.decodeUnknownEffect` and translate parse failures at
the boundary that owns the recovery decision. Synchronous construction is reserved for trusted
constants, tests, and measured startup or hot paths whose throwing contract is explicit.

A useful error says:

- what failed;
- which safe IDs and versions matter;
- whether retry is safe;
- whether any work completed;
- what the caller can do next.

Every tagged error carries the same guidance fields, spread from `ErrorGuidanceFields` in
`@ue-shed/protocol`:

- `message`: what failed, with the safe IDs and versions that matter;
- `recovery`: prose the caller can follow;
- `retrySafe`: whether repeating the same operation is idempotent;
- `nextStep`: `fix_input`, `retry`, `reconcile` (state changed underneath; re-read first) or
  `escalate` (the caller cannot fix it). `retry` is only valid when `retrySafe` is true.

`pnpm effect:architecture` discovers and enforces the guidance fields across all production
packages, apps and extensions. Error matching uses tags/guards rather than tagged-class
`instanceof`. Exported raw schema-decoder factories have no grandfathered exceptions: public
boundaries expose unary domain parsers, retaining the original schema issues in their typed cause.

The public API check also requires named entry-point exports in the eight reviewed host-facing
packages and caller-facing documentation for every public entry in protocol, Unreal connection,
localization, Unreal assets, engine, cameras, host and Game Text. Adding an internal export no longer
automatically enlarges these public surfaces. Direct `mapError`/IO-catch translations that construct
an error object must retain its cause; expected refusals constructed without a preceding failure do
not need a fabricated cause. Localization's portable evidence errors deliberately sanitize authored
payloads; their code and guidance cross the boundary instead of raw parser/IO objects.

UI and CLI code must not parse error text to make decisions. Translate library errors at the service
that owns the library. Keep the useful cause.

Use defects only for broken invariants and unknown failures. Keep retries safe, bounded, visible, and
cancellable.
