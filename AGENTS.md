# UE Shed

UE Shed is a headless-first toolkit for extending Unreal Engine development out into external
tools. The desktop Workbench is a showcase and dogfood client, never a privileged architecture
layer.

## Before changing code

- Start at [`docs/README.md`](docs/README.md) for the doc map and read order.
- Keep the core usable from libraries and the CLI without the Workbench.
- In Showcase/Workbench, only the shell owns project selection. Feature routes and extensions must
  use the host's selected project, never add their own project picker or maintain a separate active
  project. Scan, rescan, export, and preset actions must not change the selected project. If none is
  selected, direct the user to the shell picker. See
  [project ownership](docs/showcase.md#project-ownership).
- Do not introduce studio-project names, paths, assets, schemas, credentials, or assumptions.
- Provide the base, not the constraints. Unreal's own behaviour (its parsers, validators and how it
  reads data) is fixed. Every judgment beyond that is policy: which checks run, their thresholds,
  word lists, severities and scope. A host or the project's files must be able to change, extend or
  drop any policy without changing UE Shed. See
  [base, not constraints](docs/vision-and-architecture.md#base-not-constraints).
- Treat existing internal tooling as behavioral reference, not source code or architecture to copy.
- Keep Unreal integrations capability-driven and separately enabled.
- Unreal owns writes to project content. Headless code detects and plans; native APIs or a UE Shed
  editor plugin apply. See
  [Unreal owns content writes](docs/vision-and-architecture.md#unreal-owns-content-writes).
- Follow the [visual density](docs/engineering/stylex.md#visual-density) rules for UI: compact
  summary rows, no stat tiles, no coloured left-border accents.

## Delegating to Codex

Implement directly by default. Delegate implementation to Codex only when the user asks, and then
for the whole task they named. The orchestrating agent writes each phase brief, reviews the diff,
runs the verification itself (targeted checks, Node 24 and 26, UE 5.7 and 5.8 for Unreal work,
real-app screenshots for UI) and makes the commits; Codex does not commit. Launch
`codex exec -m gpt-6.1-sol -c model_reasoning_effort="high"` from a script file, because
worktree-isolated sessions reject an inline `codex exec`, and tell Codex it may read files with the
shell.

## Commands

GitHub Actions runs the portable gate on GitHub-hosted Ubuntu 24.04 runners. Repository checks run
on every pull request. On PRs, the UAsset lanes follow their Rust, WASM, package, contract, script and fixture
inputs; parser and inspection changes also trigger downstream IO conformance. Website and Catalog
oracle checks have separate input scopes. Pushes to `main` and manual dispatches run all lanes. Use `pnpm check`
for full local verification. During local iteration, use targeted checks for the surface you changed.
Never describe a change as fully verified while a relevant targeted check or the portable CI gate is
failing.

`pnpm run check:precommit` runs `check:static` (dependency paths, formatting, lint, Effect
architecture, licenses, StyleX and architecture regressions), then type and contract checks. Use it
for broad TypeScript or contract changes.
For focused work, run the relevant individual command or test file. Do not leave formatting, lint,
type, or test errors for the user to discover. Fix with `pnpm exec oxfmt .` when `format:check`
fails, then rerun the failing command.

Full `pnpm check` also covers `uasset:check`, license/architecture/release gates, and `test`.
`pnpm run check:repository` runs the always-on repository lane without native UAsset work. UAsset parser,
inspection, and WASM checks use `uasset:check:libraries`; SQLite-backed IO, native/WASM parity,
native-reader CLI, and fixture integration tests use `uasset:check:io` and the conditional IO lane.
Packed-package and Data Authoring adoption conformance remain explicit parts of the full local gate
while their hosted flows are being redesigned. Individual commands include `typecheck`, `lint`,
`format:check`, and `test`.

## Unreal Engine reference

Always run relevant Unreal checks on both **UE 5.7 and UE 5.8** for parser, codegen, fixture, and
Unreal integration changes. A pass on only one version is incomplete verification. Report each
version's result and any unavailable check explicitly. For parser/codegen work, run
`pnpm test:uasset-engine-matrix` in addition to the portable checks; see
[`docs/engineering/testing.md`](docs/engineering/testing.md).

Discover local engine installations (for example, the `HKLM:\SOFTWARE\EpicGames\Unreal Engine`
registry keys) or use explicit configuration. Verify Unreal APIs against each engine's
`Engine\Source` instead of guessing.

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
