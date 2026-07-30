# `@ue-shed/map-history`

The optional, Perforce-backed UE Shed workflow for reconstructing and explaining the saved actor
history of one Unreal map.

The package owns Perforce acquisition, historical temporary project state, actor continuity, and
semantic changes. It uses `@ue-shed/unreal-assets` for each saved-world snapshot and is the only UE
Shed package that depends on `p4client-ts`.

Deep History reconstructs one complete map-scope corpus. Fast History is a separate request mode that
accepts a single-actor Investigation Target, proves that actor's external-actor package from the
SavedWorld projection, and returns explicit targeted-coverage metadata.

The first implementation is intentionally Perforce-specific. A source-neutral revision abstraction
is deferred until another real producer exists.

Browser-safe consumers can import `@ue-shed/map-history/playback` to derive the saved actor state at
the range start or immediately after a selected submitted changelist. Playback uses the retained
range-start snapshot and semantic deltas locally; it neither serializes full snapshots per
changelist nor receives Perforce or filesystem authority.

See [the product contract](../../docs/products/map-history.md) and
[Plan 034](../../plans/034-build-perforce-map-history.md).

## Real Perforce conformance

`pnpm test:perforce-map-history` provisions a temporary generic localhost depot from the committed
Unreal-generated map-history bundles. It does not use the active `p4` CLI configuration, a
contributor workspace, or a hosted Perforce server. See the
[fixture instructions](../../fixtures/perforce-map-history/README.md) for the optional executable
override and cache controls.
