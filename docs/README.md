# Docs

Start here when choosing what to read. Prefer the highest-authority document that answers the
question; do not treat ideas or research as product contracts.

## Read order for agents and contributors

1. [Vision and architecture](vision-and-architecture.md) — product boundary, sequencing, open-source
   gates.
2. [Engineering index](engineering/README.md) — how to design and implement packages. Load only the
   focused guides relevant to the work; read
   [agent adoption](engineering/agent-adoption.md) when touching a maintained workflow, CLI,
   extension, trusted host, or Unreal integration.
3. The focused [product](products/) contract for the domain you are changing.
4. [Showcase](showcase.md) when running or documenting demos.

Implementation plans live outside this tree in [`plans/`](../plans/README.md). Mark plan status
there; do not invent a second status source in docs.

## Map

| Path                                                     | Authority                   | Use it for                                                                                  |
| -------------------------------------------------------- | --------------------------- | ------------------------------------------------------------------------------------------- |
| [vision-and-architecture.md](vision-and-architecture.md) | Canonical intent            | Boundaries, sequencing, suite shape                                                         |
| [engineering/](engineering/README.md)                    | Canonical engineering       | Effect, schemas, UI, tests, observability, agent adoption                                   |
| [products/](products/)                                   | Canonical product contracts | Shipped promises and acceptance for a domain                                                |
| [showcase.md](showcase.md)                               | Canonical demos             | Fresh-clone walkthroughs and live setup                                                     |
| [releases/](releases/0.5.1.md)                           | Release notes               | User-facing changes and compatibility notes                                                 |
| [decisions/](decisions/)                                 | Accepted ADRs               | Settled design choices                                                                      |
| [ideas/](ideas/README.md)                                | Vision / brainstorm         | Directions not yet product contracts                                                        |
| [research/](research/)                                   | Dated investigation         | Historical notes; not living authority                                                      |
| [`plans/`](../plans/README.md)                           | Executable work             | Active implementation plans; completed plans under [`archive/`](../plans/archive/README.md) |

## Products

| Document                                                  | Domain                               |
| --------------------------------------------------------- | ------------------------------------ |
| [data-authoring.md](products/data-authoring.md)           | DataTable authoring product          |
| [hosting-grill.md](products/hosting-grill.md)             | Hosting / authoring grill contract   |
| [hosting-conformance.md](products/hosting-conformance.md) | Hosting conformance gates            |
| [map-review.md](products/map-review.md)                   | Map Review product                   |
| [map-capture.md](products/map-capture.md)                 | Orthographic map tile pyramids       |
| [map-history.md](products/map-history.md)                 | Perforce-backed saved map history    |
| [config-explorer.md](products/config-explorer.md)         | Saved Unreal config provenance       |
| [game-text.md](products/game-text.md)                     | Saved text corpus and quality review |
| [scenario-studio.md](products/scenario-studio.md)         | Live PIE scenario execution          |
| [project-custodian.md](products/project-custodian.md)     | Reclaimable Unreal workspace storage |
| [niagara-preview.md](products/niagara-preview.md)         | Portable Niagara preview evidence    |

## Decisions

| ADR                                                                          | Title                                           |
| ---------------------------------------------------------------------------- | ----------------------------------------------- |
| [0001](decisions/0001-authoring-first-proving-slice.md)                      | Authoring-first proving slice                   |
| [0002](decisions/0002-derive-authoring-contract-and-drafts.md)               | Derive authoring contract and drafts            |
| [0003](decisions/0003-demand-driven-local-camera-frames.md)                  | Demand-driven local camera frames               |
| [0004](decisions/0004-own-the-uasset-parser.md)                              | Own the UAsset parser                           |
| [0005](decisions/0005-gate-peculiar-sheets-and-defer-custom-authoring-ui.md) | Gate Peculiar Sheets; defer custom authoring UI |
| [0006](decisions/0006-bounded-observatory-transform-stream.md)               | Bounded Observatory transform stream            |
| [0007](decisions/0007-separate-uasset-inspection-and-io.md)                  | Separate UAsset parsing, inspection, and IO     |
| [0008](decisions/0008-editor-world-camera-preview-stream.md)                 | Stream Map Review from the editor world         |

## Research

- [Canonical SQLite and incremental snapshots (2026-09-05)](research/sqlite-canonical-2026-09-05.md) —
  production migration, three-size before/after timings, lifecycle validation, and cache repair.

- [Rust core speed pass 2 and actual-project SQLite comparison (2026-09-05)](research/rust-core-speed-round2-2026-09-05.md) —
  discovery, protocol validation, and real Catalog comparisons across three project sizes.
- [Rust core review and SQLite reassessment (2026-09-05)](research/rust-core-review-2026-09-05.md) —
  baseline, implemented fixes, native storage comparisons, and CI tradeoffs.

| Note                                                                                                | Topic                              |
| --------------------------------------------------------------------------------------------------- | ---------------------------------- |
| [uasset-parser-roadmap.md](research/uasset-parser-roadmap.md)                                       | Parser expansion roadmap           |
| [hosting-ue57-boundary.md](research/hosting-ue57-boundary.md)                                       | UE 5.7 hosting boundary notes      |
| [map-capture-performance-2026-08-13.md](research/map-capture-performance-2026-08-13.md)             | Map Capture performance experiment |
| [anti-slop-audit-2026-08-18.md](research/anti-slop-audit-2026-08-18.md)                             | Anti-slop code-quality audit       |
| [map-review-detected-occluder-feasibility.md](research/map-review-detected-occluder-feasibility.md) | Automatic Clear intervention       |
