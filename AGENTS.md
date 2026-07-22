# UE Shed

UE Shed is a headless-first toolkit for extending Unreal Engine development out into external
tools. The desktop Workbench is a showcase and dogfood client, never a privileged architecture
layer.

## Hackathon judging freeze

`main` is frozen until 13 August 2026 for hackathon judging. Do not merge, push, or target pull
requests to `main` during this period. Use temporary or feature branches instead.

## Before changing code

- Start at [`docs/README.md`](docs/README.md) for the doc map and read order.
- Keep the core usable from libraries and the CLI without the Workbench.
- Do not introduce studio-project names, paths, assets, schemas, credentials, or assumptions.
- Treat existing internal tooling as behavioral reference, not source code or architecture to copy.
- Keep Unreal integrations capability-driven and separately enabled.

## Commands

Run `pnpm check` after edits and immediately before returning work to the user. A task is not
complete while this check is failing: fix the failures and rerun the check, or clearly report the
remaining blocker instead of handing back an unverified change. Individual commands are
`typecheck`, `lint`, `format:check`, and `test`.

## Unreal Engine reference

Use `C:\Program Files\Epic Games\UE_5.7` as the current local engine install. Verify Unreal APIs
against `C:\Program Files\Epic Games\UE_5.7\Engine\Source` instead of guessing.

This is a development reference, not a product default. Runtime code, fixtures, and tests must use
engine discovery or explicit configuration rather than depend on this machine path.

## TypeScript style

Tabs, double quotes, semicolons, no trailing commas, and approximately 100 characters per line.

- Use SolidJS for maintained first-party interfaces and Effect for services, resources, concurrency,
  typed failures, configuration, and telemetry.
- Use StyleX for maintained UI styling. Shared tokens and primitives create consistency; feature
  styles remain local. Do not use global selectors or stylesheet order as an extension contract.
- Keep pure domain transformations as ordinary pure functions; do not wrap computation in Effect only
  to appear functional.
- Use Effect Schema for most TypeScript-owned runtime schemas. Infer types from schemas and derive
  variants with schema combinators instead of copying interfaces or mutating base schemas.
- Validate all external input at the boundary. A language-neutral wire schema remains authoritative
  when TypeScript and C++ share a contract.
- Prefer discriminated unions for lifecycle state and branded identifiers at system boundaries.
- Expected failures are typed domain values with useful context and recovery guidance. Defects are
  reserved for broken invariants and genuinely unexpected failures.
- Instrument boundary operations with structured spans, metrics, and logs. Console output is not a
  substitute for product observability.
- Tests are part of the design: pure, integration, protocol-conformance, fixture, UI, and recovery
  tests should cover the behavior at the cheapest truthful layer.
- Styling correctness belongs in CI: run the StyleX compiler and lint rules, type constrained style
  props, and visual-regression checks for critical components and product states.

Before writing unfamiliar Effect code, consult `effect-solutions` when it is available, then official
Effect documentation and installed source. Do not guess at APIs or force Promise/Effect conversions
through multiple layers.
