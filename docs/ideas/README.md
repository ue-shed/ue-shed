# Product ideas

These documents describe UE Shed product directions. They are vision documents, not commitments to
implement every mechanism exactly as first described. Risky decisions are intentionally earned
through vertical slices and engine-source verification.

## Shared infrastructure

- [Authoring synchronization layer](authoring-sync-layer.md) — proposed Node coordinator, public
  sync interfaces, and optional Unreal bridge/menu clients; a general sync library remains future work

## Running-world products

These directions share discovery, producer/world/session identity, capability negotiation, bounded
streams, and evidence while keeping their domain models separate.

- [Real-time actor observatory](actor-observatory.md) — foothold via Map Review Live World Scout
- [Live camera feeds](live-camera-feeds.md) — Camera Load Lab slice measured
- [Map review cameras](map-review-cameras.md) — graduated to [`products/map-review.md`](../products/map-review.md)
- [Interactive gameplay scenarios](interactive-scenarios.md)

## Authored-content products

These Workbench destinations assemble saved project content into queryable, historical, visual, and
reviewable corpora while keeping their headless capabilities independently usable.

- [Content observatory](content-observatory.md)
- [Asset audits](asset-audits.md) — Texture Audit lens shipped
- [Asset lookbook](asset-lookbook.md)
- [Game text workbench](game-text-workbench.md) — early scan/search slice shipped

A separate [ranked catalog](catalog.md) collects a different family — corpus tools and analytical
surfaces over authored project data. Promising entries graduate to their own vision documents.
