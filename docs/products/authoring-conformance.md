# Data authoring conformance

This document classifies the generic behaviors that define UE Shed authoring. It is an executable
test roadmap, not an API specification. Public TypeScript and C++ interfaces are deliberately left
open until the architecture grill following the fixture characterization work.

## Test layers

| Layer    | Boundary                                                  | Runtime                 |
| -------- | --------------------------------------------------------- | ----------------------- |
| Contract | Fixture manifest and source definitions                   | Node.js                 |
| Pure     | Snapshots, command folds, validation, diffs, conflicts    | Node.js                 |
| Unreal   | Reflected schemas, values, mutation, transactions, saving | Real editor fixture     |
| Headless | Discovery through the public library and CLI              | Node.js + real editor   |
| Product  | User-visible behavior through the host-neutral extension  | Browser or desktop host |

A behavior belongs at the cheapest layer that can establish it. Mocks cannot define Unreal
reflection, serialization, transaction, or package-saving behavior.

## Conformance inventory

### Fixture and schema

- The fixture contract is versioned and readable without launching Unreal.
- Each declared DataTable loads with its declared row structure and deterministic row order.
- Schema discovery preserves authored names, property types, container shapes, and relevant metadata.
- Scalar, enum, localized text, nested struct, asset reference, row reference, and container fields
  have representative values.
- A deliberately opaque value remains visible and round-trippable even when no specialized editor
  exists.
- Composite tables expose ordered parents and deterministic override behavior.

### Snapshots and commands

- A snapshot preserves table identity, row-structure identity, row order, row identity, and every
  field value.
- Working state is derived by folding active commands over a base snapshot.
- Set, add, remove, rename, and reorder commands have deterministic inverses.
- Undo and redo select a prefix of the command log without mutating the base snapshot.
- Appending after undo discards the inactive redo tail.
- Invalid row names, duplicate rows, missing fields, and non-permutation reorders fail as typed domain
  values with recovery guidance.

### Unreal mutation

- A valid bounded batch applies all commands inside one editor transaction.
- A failure in any command rolls the entire batch back.
- Apply and Save are separate observable operations.
- Successful Apply rebases the session from a new Unreal snapshot.
- Save reports exactly which assets were written and whether retry is safe.

### Concurrent change

- Preflight compares the base snapshot with current Unreal state before mutation.
- Unrelated external changes can be rebased without losing either side.
- Overlapping cell, row, rename, and reorder changes become explicit conflicts.
- Choosing the draft or Unreal value updates the base and command log consistently.
- Transport loss or editor exit never reports an indeterminate batch as successful.

### Headless and product parity

- The CLI can discover tables, inspect schema, export snapshots, validate drafts, review diffs, Apply,
  and Save using the same public services as graphical hosts.
- Workbench and other hosts receive no private authoring endpoint.
- Missing or partial Unreal capabilities are represented explicitly.

## Behaviors intentionally not inherited

- Desktop-process RPC topology.
- Renderer-owned session authority or singleton stores.
- Project-specific table roles, schemas, hooks, paths, or source-control policy.
- Silent fallbacks for unsupported mutation operations.
- UI navigation and layout details unrelated to the generic workflow.
