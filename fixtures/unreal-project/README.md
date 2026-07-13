# Generic Unreal fixture

This is the reproducible Unreal Engine project used by UE Shed integration and conformance tests. Its
first content slice exercises generic DataTable authoring under `/Game/Fixture/Authoring`.

## Requirements

- Unreal Engine 5.7 installed through the Epic Games Launcher, or an explicit engine root supplied
  through `UE_SHED_UNREAL_ENGINE_ROOT`.
- Visual Studio 2022 with the Unreal Engine C++ workload on Windows.

The local UE 5.7 installation is a development baseline, not a runtime product default. The fixture
runner discovers a matching Launcher installation or uses explicit configuration.

## Commands

From the repository root:

```powershell
pnpm fixture:build
pnpm fixture:generate
pnpm fixture:verify
```

`fixture:generate` compiles the project and regenerates the committed DataTables from JSON under
`FixtureSource/Authoring`. `fixture:verify` regenerates them, reloads every asset in a fresh commandlet
process, and compares their row structures and row names with `fixture-contract.json`.

## Contract

[`fixture-contract.json`](fixture-contract.json) is readable without launching Unreal. It declares
the contract version, engine baseline, asset paths, row structures, source definitions, expected row
names, and the field families each table exercises.

Generated build products, editor state, and locally installed plugin binaries are ignored. The
generated `.uasset` files are committed together with their reviewable JSON sources so contributors
can validate and reproduce them.
