# Data authoring architecture grill

The fixture and engine characterization are complete enough to decide the public authoring model.
These decisions have multiple valid approaches and meaningful long-term consequences. They should be
resolved before `@ue-shed/authoring`, `UEShedAuthoring`, or CLI interfaces harden.

## 1. Companion requirement for read-only authoring

### Options

1. Require `UEShedAuthoring` for every authoring operation.
2. Support a stock degraded mode for known DataTable paths and JSON export, while requiring the
   companion for discovery, normalized schema, fingerprints, and safe mutation.
3. Require the broad Editor Scripting Utilities plugin as the stock read-only baseline.

### Initial recommendation

Use option 2. It demonstrates capability-driven degradation without making a broad optional engine
plugin a product prerequisite. The UI and CLI must label partial support explicitly.

## 2. Canonical snapshot and schema wire representation

### Options

1. Treat Unreal's exported JSON as the wire contract.
2. Return a normalized language-neutral schema and typed value tree from `UEShedAuthoring`.
3. Return raw reflection records and normalize exclusively in TypeScript.

### Initial recommendation

Use option 2. Raw export remains evidence and a fallback, but a normalized contract can preserve
unknown values, describe containers and references, and remain conformant across TypeScript and C++.
It costs more plugin code and requires an explicit wire-schema authority.

## 3. Command granularity

### Options

1. Replace complete rows or tables.
2. Use only cell patches plus row lifecycle commands.
3. Use a typed command union with cell, structured-value, row lifecycle, and reorder operations.

### Initial recommendation

Use option 3, beginning with cell replacement and row lifecycle commands. Full-table replacement is
too destructive for review and conflict handling; cell-only commands become awkward for containers
and structured values.

## 4. Fingerprint authority

### Options

1. Hash the external JSON snapshot in TypeScript.
2. Have the companion hash a canonical engine-side representation.
3. Use package timestamps, dirty state, or asset-registry package metadata.

### Initial recommendation

Use option 2 and include the algorithm/version in the result. Package metadata is insufficient for
in-memory editor changes, while client-side hashing risks divergence from the engine's semantic
serialization.

## 5. Transaction scope

### Options

1. One transaction per command.
2. One transaction per table batch.
3. One bounded transaction spanning all tables in an Apply plan.

### Initial recommendation

Design for option 3 but constrain the first editing slice to one table. Cross-table product workflows
need atomic intent eventually; the initial limit keeps rollback and failure evidence tractable.

## 6. Persistent session authority

### Options

1. Persist only commands and reload every base snapshot from Unreal.
2. Persist the base snapshots, command log, undo pointer, and schema/fingerprint versions.
3. Keep sessions ephemeral until the mutation contract is mature.

### Initial recommendation

Use option 2 with an explicitly versioned, atomic file format. Persistent sessions are part of the
product promise and are required to distinguish drafted work from editor and disk state after a
restart.

## 7. Apply response under transport uncertainty

### Options

1. Treat connection loss as failure and retry automatically.
2. Return an indeterminate result that requires snapshot/fingerprint reconciliation.
3. Add operation IDs and a companion-side bounded result cache for idempotent lookup.

### Initial recommendation

Combine options 2 and 3. Automatic replay of a mutation batch is unsafe without idempotency. An
operation ID plus short-lived result lookup lets the client distinguish committed, rolled back, and
unknown outcomes after reconnect.

## Decisions that can wait

- Custom authoring UI grants and isolation.
- Joined multi-table view configuration.
- Specialized field-editor registry shape.
- Source-control adapters around Save.
- Runtime extension loading.

These do not need to constrain the read-only spine or first single-table editing loop.
