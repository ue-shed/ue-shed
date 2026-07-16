# Data authoring conformance

This document classifies the generic behaviors that define UE Shed authoring. It is an executable
test roadmap, not an API specification. Public TypeScript and C++ interfaces are deliberately left
open until the architecture grill following the fixture characterization work.

## Test layers

| Layer    | Boundary                                                  | Runtime                 |
| -------- | --------------------------------------------------------- | ----------------------- |
| Contract | Fixture manifest and source definitions                   | Node.js                 |
| Package  | Saved asset decoding and parser compatibility             | Node.js + `uasset` CLI  |
| Pure     | Snapshots, command folds, validation, diffs, conflicts    | Node.js                 |
| Unreal   | Reflected schemas, values, mutation, transactions, saving | Real editor fixture     |
| Headless | Discovery through the public library and CLI              | Node.js                 |
| Product  | User-visible behavior through the host-neutral extension  | Browser or desktop host |

A behavior belongs at the cheapest layer that can establish it. Mocks cannot define Unreal
reflection, serialization, transaction, or package-saving behavior.

Saved-package and live-editor checks are deliberately distinct. Package conformance proves the
first-class read-only path without launching Unreal; Unreal conformance proves live state and
mutation against a real editor.

## Implementation ledger

This ledger distinguishes intended behavior from the strongest test layer currently present. A
status is not a release claim: environment-gated commands prove behavior only when they actually run.

| Capability                                                                   | Status         | Current proving command or gap                                                                                                                                    |
| ---------------------------------------------------------------------------- | -------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Versioned fixture manifest and declared field families                       | pure-tested    | `pnpm exec vitest run fixtures/unreal-project/fixture-contract.test.ts`                                                                                           |
| Versioned v1/v2 snapshot, command, Apply, and Save schemas                   | pure-tested    | `pnpm exec vitest run packages/protocol/src`                                                                                                                      |
| Saved-package DataTable decoding                                             | adapter-tested | `pnpm exec vitest run packages/unreal-assets/src/fixture.integration.test.ts`                                                                                     |
| Saved project DataTable catalog                                              | adapter-tested | `pnpm exec vitest run packages/unreal-assets/src/catalog.test.ts packages/unreal-assets/src/fixture.integration.test.ts`                                          |
| Saved/commandlet snapshot parity                                             | unreal-tested  | `pnpm test:uasset-conformance`                                                                                                                                    |
| Saved/live snapshot parity                                                   | unreal-tested  | `pnpm authoring:parity fixtures/unreal-project <endpoint> --reader <uasset>`                                                                                      |
| Fingerprints, command folding, grouped undo/redo, and draft-file persistence | pure-tested    | `pnpm exec vitest run packages/authoring/src/authoring.test.ts`                                                                                                   |
| Live schema descriptors independent of row values                            | unreal-tested  | `pnpm authoring:parity fixtures/unreal-project <endpoint> --reader <uasset>`; saved authority remains explicitly unavailable                                      |
| Live DataTable catalog and saved/live merge                                  | unreal-tested  | `pnpm authoring:parity fixtures/unreal-project <endpoint> --reader <uasset>`                                                                                      |
| Schema-aware validation, semantic diff, and Session Review                   | adapter-tested | `pnpm exec vitest run packages/authoring/src/session-service.test.ts packages/authoring-sdk/src/index.test.ts apps/workbench/src/main/services/authoring.test.ts` |
| Persistent session lifecycle and safe intents for every row operation        | adapter-tested | `pnpm test:e2e:cli`                                                                                                                                               |
| Read-only Peculiar Sheets model and browser adapter                          | adapter-tested | `pnpm exec vitest run extensions/data-authoring/src/authoring-grid-model.test.ts` plus the Workbench build                                                        |
| Peculiar Sheets editing, row operations, and product interactions            | product-tested | `pnpm test:components` and `pnpm test:e2e:workbench`                                                                                                              |
| Transactional Apply, result lookup, and separate Save against UE 5.7         | unreal-tested  | `UE_SHED_UNREAL_INTEGRATION=1 pnpm exec vitest run packages/authoring/src/unreal-mutation.integration.test.ts`                                                    |
| Indeterminate-operation reconciliation and response correlation              | planned        | Plan 006                                                                                                                                                          |
| Three-way drift, conflict resolution, and rich-type round trips              | planned        | Plan 007                                                                                                                                                          |
| Full discover-to-Save maintained-editor journey                              | planned        | Plan 007; requires browser/Electron fixture coverage                                                                                                              |

Allowed status values are `planned`, `pure-tested`, `adapter-tested`, `unreal-tested`, and
`product-tested`. Update a row only when its command proves the described behavior at that layer.

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
- All fixture assets can be inspected through a supported `uasset` CLI schema version.
- Package inspection preserves unsupported values as explicit raw evidence rather than omitting
  them.

### Snapshots and commands

- A snapshot records whether its authority is saved project files or live editor memory.
- A snapshot preserves table identity, row-structure identity, row order, row identity, and every
  field value representable by its authority.
- Working state is derived by folding active commands over a base snapshot.
- Set, add, remove, rename, and reorder commands have deterministic inverses.
- Commands capture the prior data needed for inversion when they are drafted.
- Commands produced by one draft gesture append atomically and undo as one group.
- Undo and redo select a prefix of the command log without mutating the base snapshot.
- Appending after undo discards the inactive redo tail.
- Invalid row names, duplicate rows, missing fields, and non-permutation reorders fail as typed domain
  values with recovery guidance.
- Persisted commands that cannot fold over their recorded base fail as a typed session error rather
  than being silently ignored.

### Unreal mutation

- A valid bounded batch applies all commands inside one editor transaction.
- One bounded transaction may contain commands for several tables.
- A failure in any command rolls the entire batch back.
- Apply and Save are separate observable operations.
- Successful Apply rebases the session from a new Unreal snapshot.
- Apply receipts and assets awaiting Save survive restart after active commands are rebased.
- Save reports exactly which assets were written and whether retry is safe.

### Concurrent change

- Preflight compares the base snapshot with current Unreal state before mutation.
- Unrelated external changes can be rebased without losing either side.
- Overlapping cell, row, rename, and reorder changes become explicit conflicts.
- Choosing the draft or Unreal value updates the base and command log consistently.
- Transport loss or editor exit never reports an indeterminate batch as successful.
- Reconnecting clients query an Apply operation ID before considering replay; mutation is never
  retried automatically.

### Headless and product parity

- The CLI can discover saved tables, inspect schema, and export snapshots without a running editor.
- The CLI can validate drafts, review diffs, Apply, and Save through the same public services as
  graphical hosts when live capabilities are connected.
- Workbench and other hosts receive no private authoring endpoint.
- Authority, missing capabilities, and partial decoding are represented explicitly.

## Behaviors intentionally not inherited

- Desktop-process RPC topology.
- Renderer-owned session authority or singleton stores.
- Project-specific table roles, schemas, hooks, paths, or source-control policy.
- Silent fallbacks for unsupported mutation operations.
- UI navigation and layout details unrelated to the generic workflow.
