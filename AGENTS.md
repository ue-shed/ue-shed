# UE Shed

UE Shed is a headless-first toolkit for extending Unreal Engine development out into external
tools. The desktop Workbench is a showcase and dogfood client, never a privileged architecture
layer.

## Before changing code

- Start at [`docs/README.md`](docs/README.md) for the doc map and read order.
- Keep the core usable from libraries and the CLI without the Workbench.
- Do not introduce studio-project names, paths, assets, schemas, credentials, or assumptions.
- Treat existing internal tooling as behavioral reference, not source code or architecture to copy.
- Keep Unreal integrations capability-driven and separately enabled.

## Commands

`pnpm check` must stay green. A task is not done, and must not be handed back as ready to
commit, while it fails. Run it after substantive edits and again immediately before returning
work. Fix failures and rerun until it passes, or clearly report the remaining blocker instead of
handing back an unverified change.

Commits are blocked by Lefthook `pre-commit`, which runs `pnpm run check:precommit`
(`format:check`, `lint`, `typecheck`, `test:architecture`, `contract:check`). If that subset
fails, the commit will be rejected—do not leave formatting, lint, or type errors for the user
to discover at commit time. Fix with `pnpm exec oxfmt .` when `format:check` fails; then rerun
the failing command and `pnpm check`.

Full `pnpm check` also covers `uasset:check`, license/architecture/release gates, and `test`.
Individual commands include `typecheck`, `lint`, `format:check`, and `test`.

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
