# Generated legacy fixtures

Run `pnpm fixture:generate-legacy --update` with UE 4.27 and UE 5.3 installed. Commit each version's
`evidence.json`, `UEShedLegacyFixture.uproject`, and three `Content/Legacy/*.uasset` files together.
These are fixture-authored assets; no engine content belongs here.

The assets and evidence must come from the generator. No placeholder packages or inferred oracle
data are supplied. Portable conformance requires both version directories and fails if either is
missing. Generation and engine verification remain pending until the user runs the commands in
the [project README](../README.md).
