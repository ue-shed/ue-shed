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
automatically enlarges these public surfaces. Direct `mapError`/IO-catch translations and helper
adapters that construct error objects must retain their causes. The guard covers repository tagged
errors even when their names do not end in `Error`, and checks spread fields rather than treating
any spread as proof of retention. Expected refusals constructed without a preceding failure do not
need a fabricated cause.

Privacy boundaries deliberately sanitize evidence: portable localization failures exclude authored
payloads, engine-installation candidates and private descriptor paths. Secret configuration values
are also excluded from CLI errors. Keep a safe classified cause and recovery guidance at these
boundaries instead of attaching raw private parser, IO or configuration objects.

UI and CLI code must not parse error text to make decisions. Translate library errors at the service
that owns the library. Keep the useful cause.

### Writing the message

These rules follow dmmulroy's
[cf-workflow-pool error design](https://github.com/dmmulroy/cf-workflow-pool/blob/73e0f2f5d3b72d85a17384638716c4b0490e16aa/docs/errors.md),
adapted to the guidance fields above.

- Name the operation that failed and the most specific safe reason known. Never write "Something
  went wrong" when the failure has been classified.
- Start with a specific phrase that can be searched for in the source.
- End with a way forward: fix the input, retry, re-read and reconcile, or escalate. That is the
  `nextStep`; `recovery` says it in words the caller can follow.
- Make reassurance and retry advice provably true. Do not say "nothing was changed" after a step
  that may have partly completed, such as a multi-package save or an engine call whose reply was
  lost; say the outcome is unknown and what to re-read instead. Do not offer `retry` when a repeat
  would run the operation a second time.
- Keep the tone calm and plain: no jokes, apologies, alarm or blame.
- Caller-facing text uses product vocabulary. Internal detail (library exception text, stack
  traces, private paths, raw payloads) stays in the typed cause and logs, not in `message`.

### Translating failures

Translate each known failure by tag with `Effect.catchTag` or `Effect.catchTags`, or with
`Effect.catchIf` on a discriminating field. Leave an unhandled tag in the error channel on purpose:
a newly added failure should be a type error until someone decides how it is reported, retried and
recovered. Do not use `instanceof` branches to tell expected failures apart. `Effect.mapError`
remains fine when the whole error channel has one meaning.

Catch-all recovery (`Effect.catch`, `catchCause`, `orElse`, `orElseFail`, `orElseSucceed`) folds
every failure, including future ones, into one answer. `anti-slop/no-effect-catch-all` rejects it in
new code. Where a catch-all is the deliberate contract (a best-effort probe whose answer is
"unknown" for any failure, or the outermost boundary that turns any failure into a report), disable
the rule on that line and say why:

```ts
// oxlint-disable-next-line anti-slop/no-effect-catch-all -- Readiness is best effort; any failure reads as unknown.
Effect.orElseSucceed(() => "unknown");
```

Files that already had catch-alls when the rule arrived are listed in
`tools/oxlint/effect-catch-all-baseline.ts`, where the rule only warns. Convert a file's catch-alls
when you work in it, then remove it from the list. Never add a file to the list.

### Review checklist

Before adding or changing an error, check that:

1. it says what failed and the most specific safe reason;
2. it carries typed context (tag, IDs, guidance fields) instead of facts only in prose;
3. `nextStep` and `recovery` give a correct way forward;
4. reassurance and `retrySafe` are provably true;
5. the tone is calm and free of blame and implementation jargon;
6. the message or tag can be found by searching the source;
7. secrets, private paths and raw external data stay out of caller-facing text;
8. every boundary translates it deliberately, not through a catch-all.

Use defects only for broken invariants and unknown failures. Keep retries safe, bounded, visible, and
cancellable.
