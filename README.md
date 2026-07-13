# UE Shed

**External tools for Unreal Engine development.**

UE Shed is an early-stage, headless-first suite of libraries, protocols, Unreal companion plugins,
and reference applications. It is built around a simple idea: some tools are essential when you
need them, but they should not have to live inside every game project or dictate a studio's desktop
workflow.

The repository is intentionally a clean implementation. Existing internal Swag tooling can inform
behavior and product lessons, while this codebase establishes a generic public boundary from the
start.

## Status

This is an architectural scaffold, not a release. The first proving slice will connect a generic
Unreal fixture to the CLI and Workbench, then deliver a real-time actor observatory demo. A
batteries-included DataTable authoring product is also a first-class track, not merely an SDK example.

Read [the vision and architecture](docs/vision-and-architecture.md) for the decisions, repository
shape, first MVP, and open-source guardrails. Read
[the engineering index](docs/engineering/README.md) for focused guidance on functional design,
TypeScript, Effect, SolidJS, StyleX, observability, and testing.

## Principles

- Headless capabilities first; graphical clients consume the same public interfaces.
- A complete, safe DataTable workflow delivered through reusable libraries and a first-party UI.
- SolidJS product extensions with StyleX tokens and locally owned, statically checked styles.
- A small, separately enabled Unreal plugin suite instead of one permanent monolith.
- Versioned, language-neutral wire contracts with runtime validation.
- Stock Unreal installations and reproducible generic fixtures as the baseline.
- Static extension composition until a real need justifies runtime plugin loading.
- No studio-project assumptions in public packages, fixtures, examples, or documentation.

## Getting started

```powershell
pnpm install
pnpm check
pnpm ue-shed --help
```

The repository is private and unpublished until licensing, trademark, provenance, and dependency
reviews are complete.
