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
| [decisions/](decisions/)                                 | Accepted ADRs               | Settled design choices                                                                      |
| [ideas/](ideas/README.md)                                | Vision / brainstorm         | Directions not yet product contracts                                                        |
| [research/](research/)                                   | Dated investigation         | Historical notes; not living authority                                                      |
| [`plans/`](../plans/README.md)                           | Executable work             | Active implementation plans; completed plans under [`archive/`](../plans/archive/README.md) |

## Products

| Document                                                  | Domain                             |
| --------------------------------------------------------- | ---------------------------------- |
| [data-authoring.md](products/data-authoring.md)           | DataTable authoring product        |
| [hosting-grill.md](products/hosting-grill.md)             | Hosting / authoring grill contract |
| [hosting-conformance.md](products/hosting-conformance.md) | Hosting conformance gates          |
| [map-review.md](products/map-review.md)                   | Map Review product                 |

## Decisions

| ADR                                                                          | Title                                           |
| ---------------------------------------------------------------------------- | ----------------------------------------------- |
| [0001](decisions/0001-authoring-first-proving-slice.md)                      | Authoring-first proving slice                   |
| [0002](decisions/0002-derive-authoring-contract-and-drafts.md)               | Derive authoring contract and drafts            |
| [0003](decisions/0003-demand-driven-local-camera-frames.md)                  | Demand-driven local camera frames               |
| [0004](decisions/0004-own-the-uasset-parser.md)                              | Own the UAsset parser                           |
| [0005](decisions/0005-gate-peculiar-sheets-and-defer-custom-authoring-ui.md) | Gate Peculiar Sheets; defer custom authoring UI |
| [0006](decisions/0006-bounded-observatory-transform-stream.md)               | Bounded Observatory transform stream            |

## Research

| Note                                                          | Topic                         |
| ------------------------------------------------------------- | ----------------------------- |
| [uasset-parser-roadmap.md](research/uasset-parser-roadmap.md) | Parser expansion roadmap      |
| [hosting-ue57-boundary.md](research/hosting-ue57-boundary.md) | UE 5.7 hosting boundary notes |
