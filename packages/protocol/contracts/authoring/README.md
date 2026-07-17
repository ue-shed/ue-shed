# Authoring wire contracts

The checked-in JSON Schemas in this directory are the language-neutral authority for authoring wire
data. TypeScript Effect schemas, the Rust saved-package producer, and the Unreal C++ companion must
remain conformant with them.

`v1` remains the mutation contract used by Apply and Save. `v2/table-snapshot.schema.json` adds field
schema, producer, package, and fingerprint evidence without changing the mutation envelope. Apply
results allow either versioned snapshot during migration.

Snapshot 2.1 and mutation 1.1 add the normalized `row_reference` value for
`FDataTableRowHandle`. It carries the table object path and row name explicitly; generic structs
remain structurally encoded.

`v1/table-list.schema.json` is the deliberately narrow live discovery boundary. It lists canonical
object paths; callers retrieve v2 snapshots for descriptor evidence and isolate per-table failures.

Change a wire shape in this order:

1. Edit the authoritative JSON Schema and add or update language-neutral conformance fixtures.
2. Update the Effect runtime schema until `pnpm --filter @ue-shed/protocol contract:check` passes.
3. Update Rust and C++ producers and run their fixture conformance gates.
4. Switch consumers only after both producers pass.

Do not generate these files from TypeScript. That would reverse the authority established by ADR 0002.
