# Plan 046: Publish portable Niagara preview runs

**Status**: DONE — portable and UE 5.7 render evidence passed

**Priority**: P2

**Effort**: L

**Depends on**: engine discovery; owned process trees; plugin bundles

## Purpose

Turn the proven standalone Niagara Web Exporter into a generic UE Shed vertical with a separately
enabled Editor plugin, language-neutral contracts, a headless Effect module, CLI access, portable
evidence, and trusted Unreal conformance.

The product contract is [`docs/products/niagara-preview.md`](../../docs/products/niagara-preview.md).

## Delivery sequence

1. Add the versioned request, producer receipt, and published manifest contracts with fixtures.
2. Add `UEShedNiagara` as a source-only Editor plugin that accepts a JSON request and stages only
   beneath the project Saved directory.
3. Add `@ue-shed/niagara` to supervise the commandlet, validate and hash output, and atomically
   publish a Niagara Preview Run.
4. Add `ue-shed niagara preview` as a thin headless composition.
5. Teach plugin bundles to distinguish bundled UE Shed dependencies from stock engine plugins.
6. Add portable tests, generic fixture evidence, a Changeset, and the trusted Unreal lane.
7. Run `pnpm check`, run the relevant Unreal gate, commit, push, and open the pull request.

## Stop conditions

Stop and update the contract if UE 5.7 requires private Niagara exporter classes, output cannot be
contained without accepting an arbitrary producer path, or the fixture cannot demonstrate render
truth without project-specific content.

## Completion checklist

- [x] Versioned contracts and fixtures round trip.
- [x] The Editor-only plugin builds from source against UE 5.7.
- [x] The public module publishes only validated immutable runs.
- [x] CLI output is machine-readable and independent of Workbench.
- [x] Plugin bundles model stock Niagara separately from bundled dependencies.
- [x] Portable and trusted Unreal gates pass.
- [x] Changes are committed, pushed, and available in a reviewable PR.
