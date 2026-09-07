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

Depot CI owns the full portable gate. Its repository checks run on every pull request. The UAsset
library and IO lanes run only when their Rust, WASM, package, contract, script, or fixture inputs
change; parser and inspection changes also trigger downstream IO conformance. During local
iteration, run the smallest truthful checks for the surface you changed; do not routinely run the
full gate after every edit. Run `pnpm check` locally only when the user requests it, when changing
the portable gate or release infrastructure, or when reproducing a CI failure.
Never describe a change as fully verified while a relevant targeted check or the Depot gate is
failing.

`pnpm run check:precommit` runs the fast pre-commit subset (`format:check`, `lint`,
`typecheck`, `test:architecture`, `contract:check`). Use it for broad TypeScript or contract changes.
For focused work, run the relevant individual command or test file. Do not leave formatting, lint,
type, or test errors for the user to discover. Fix with `pnpm exec oxfmt .` when `format:check`
fails, then rerun the failing command.

Full `pnpm check` also covers `uasset:check`, license/architecture/release gates, and `test`.
`pnpm run check:repository` runs the always-on Depot lane without native UAsset work. UAsset parser,
inspection, and WASM checks use `uasset:check:libraries`; SQLite-backed IO, native/WASM parity,
native-reader CLI, and fixture integration tests use `uasset:check:io` and the conditional IO lane.
Packed-package and Data Authoring adoption conformance remain explicit parts of the full local gate
while their hosted flows are being redesigned. Individual commands include `typecheck`, `lint`,
`format:check`, and `test`.

## Unreal Engine reference

A local engine install exists, but its location is not a given — discover it (for example, the
`HKLM:\SOFTWARE\EpicGames\Unreal Engine` registry keys) or ask. On this machine, the default
location is `D:\ue5\UE_5.7`; verify Unreal APIs against its `Engine\Source` instead of guessing.

This is a development reference, not a product default. Runtime code, fixtures, and tests must use
engine discovery or explicit configuration rather than depend on any machine path.

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
