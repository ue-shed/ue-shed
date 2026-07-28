# Perforce Map History fixture

This is a source-control-neutral input fixture for the optional Map History product. It contains
small Unreal Engine 5.7 packages and a scenario manifest; it is not a Perforce server, a depot
database, or a contributor workspace.

`conventional-scenario.json` declares a conventional map; `scenario.json` declares a World
Partition map. Each revision directory contains only the binary package files that its manifest
marks as `add` or `edit`; a `delete` has no replacement file. A future disposable-Perforce harness
will use those manifests to seed named changelists, then exercise the real Perforce acquisition
path.

## Scenario

The conventional map establishes one authored marker, then moves it in a map-file revision. The
World Partition baseline has six external actors, including an attached actor whose saved position
depends on its parent. Its five deltas are deliberately small:

- move the East marker;
- rename the North marker;
- add an Arrival marker;
- delete the South marker; and
- edit two actor packages without changing the current actor projection, producing visible
  unclassified-package evidence.

The generated packages are part of the fixture contract. Do not hand-edit or synthesize `.umap` or
`.uasset` bytes.

## Generation and verification

The generic Unreal fixture owns generation. With Unreal Engine 5.7 and the fixture C++ prerequisites
installed, run:

```powershell
pnpm fixture:generate-map-history
```

Generation replaces only this fixture's `revisions/` directory after verifying that fixed output
root. It uses a short-lived source map under the generic fixture, which it removes before
completing. Review an intentional fixture refresh before replacing the committed bundles.

The portable parser test reconstructs every revision by applying the manifest to an owned temporary
project tree and reads its saved world without Unreal or Perforce:

```powershell
cargo test -p uasset-parser --bin uasset reconstructs_the_real
```

The ordinary repository check remains independent of a Perforce server, Perforce binaries, network
access, and credentials.

## Disposable Perforce conformance

Run the opt-in real-source-control lane with:

```powershell
pnpm test:perforce-map-history
```

It starts a fresh localhost `p4d`, seeds these same package bundles as named changelists, runs the
Map History service, and removes the server, client workspace, tickets, and temporary configuration.
It never uses a `p4` selected from `PATH`, a contributor workspace, or a studio server.

Unless both `UE_SHED_PERFORCE_MAP_HISTORY_P4_EXECUTABLE` and
`UE_SHED_PERFORCE_MAP_HISTORY_P4D_EXECUTABLE` are set, the harness downloads Perforce's pinned
`r26.1` command-line pair from its official distribution, verifies the pinned SHA-256 values, and
caches them outside the repository. Set `UE_SHED_PERFORCE_MAP_HISTORY_BINARY_CACHE` to choose that
cache location. The default uses the local application cache.
