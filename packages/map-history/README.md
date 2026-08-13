# `@ue-shed/map-history`

The optional, Perforce-backed UE Shed workflow for reconstructing and explaining the saved actor
history of one Unreal map.

The package owns Perforce acquisition, historical temporary project state, actor continuity, and
semantic changes. It uses `@ue-shed/unreal-assets` for each saved-world snapshot and is the only UE
Shed package that depends on `p4client-ts`.

Deep History reconstructs one complete map-scope corpus. Fast History is a separate request mode that
accepts a single-actor Investigation Target, proves that actor's external-actor package from the
SavedWorld projection, and returns explicit targeted-coverage metadata.

This module intentionally remains Perforce-specific. A downstream MB Map producer should use
`@ue-shed/unreal-assets` directly and own its product contract/archive; only independently reusable
identity, diff, or playback primitive gaps should be proposed upstream.

Install the headless package with its exact compatible release dependencies:

```powershell
npm install --save-exact @ue-shed/map-history @ue-shed/protocol @ue-shed/unreal-assets effect@4.0.0-beta.98 p4client-ts@0.7.1
```

The root export owns Perforce acquisition and therefore requires a configured `p4` executable and
workspace. Browser or renderer consumers should use `@ue-shed/map-history/contract` and
`@ue-shed/map-history/playback`; those entrypoints perform no Perforce or filesystem operations.
World Log presentation remains private to the maintained extension and is not bundled with this
headless package.

Conventional map history follows a bounded linear chain of direct Perforce moves, including when a
stale local source path still exists after the depot map moved. Copy, branch, merge, and ambiguous
integration graphs are not treated as map identity.

Browser-safe consumers can import `@ue-shed/map-history/playback` to derive the saved actor state at
the range start or immediately after a selected submitted changelist. Playback uses the retained
range-start snapshot and semantic deltas locally; it neither serializes full snapshots per
changelist nor receives Perforce or filesystem authority.

See [the product contract](../../docs/products/map-history.md) and
[Plan 034](../../plans/archive/034-build-perforce-map-history.md).

## Real Perforce conformance

`pnpm test:perforce-map-history` provisions a temporary generic localhost depot from the committed
Unreal-generated map-history bundles. It does not use the active `p4` CLI configuration, a
contributor workspace, or a hosted Perforce server. See the
[fixture instructions](../../fixtures/perforce-map-history/README.md) for the optional executable
override and cache controls.
