# DataTable authoring product

## Product promise

UE Shed should make ordinary Unreal DataTable work straightforward out of the box. A user should not
need to build a custom UI, write a script, or understand Remote Control to inspect and safely edit a
table.

Generic tooling is the boundary, not a reduction in ambition. DataTables, row structures, enums,
object references, validation, asset saving, and conflict handling are generic Unreal concerns. The
suite should offer a polished default workflow for them while keeping project-specific rules in
schemas, annotations, hooks, and optional extensions.

## What ships as a product

The first-party Data Authoring extension must support an end-to-end loop:

1. Discover DataTables in the connected project.
2. Open a table with its row structure and typed field schema.
3. Search, sort, inspect, and edit rows with type-appropriate controls.
4. Add, duplicate, rename, delete, and reorder rows where Unreal supports the operation.
5. Stage edits in a persistent session with undo and redo.
6. Show a truthful review of pending commands and validation diagnostics.
7. Detect when the Unreal asset changed underneath the session.
8. Resolve supported conflicts explicitly rather than overwriting silently.
9. Apply the staged batch to the live editor transactionally.
10. Save changed assets as a separate, visible action.

The UI must make the distinction between **drafted**, **applied to the live editor**, and **saved to
disk** unmistakable.

## Architectural ownership

```text
Unreal DataTables + UEShedAuthoring capability
                    |
          @ue-shed/authoring
  snapshots + command log + fold + validation
  preflight + conflicts + apply + save
                    |
       host-neutral authoring contract
           /                 \
first-party Data Authoring   custom studio UI
extension                    or automation
           \                 /
     Workbench, another host, or CLI
```

- `UEShedAuthoring` exposes the smallest generic operations missing from supported stock Unreal APIs.
- `@ue-shed/authoring` owns behavior and state transitions; a renderer does not become the authority.
- `@ue-shed/authoring-sdk` exposes scoped reads and draft operations to first-party and custom UIs.
- `extensions/data-authoring` is the maintained default product interface.
- Workbench composes that extension but receives no private authoring endpoint.
- `ue-shed` CLI commands cover discovery, inspection, validation, diff, apply, and save for automation.

## Session model

Unreal remains canonical. A UE Shed session holds a base snapshot and a command log. Working state is
derived by folding active commands over that snapshot.

```text
base snapshot + commands[0..undo pointer] = working table
```

Commands carry stable table, row, and field identity plus authorship and dispatch state. Apply uses a
preflight plan: validate the working state, compare asset fingerprints, classify drift, request
resolutions for supported conflicts, and send one bounded batch. A failed batch must not pretend that
some commands succeeded.

Apply and Save are separate because they answer different questions:

- **Apply:** should the connected Unreal editor adopt this working state?
- **Save:** should the affected assets be written to disk now?

Source-control checkout is an optional adapter around Save, not a core assumption.

## Default editing scope

The first usable release should handle the common field families well:

- booleans, integers, floating-point values, names, strings, and text;
- enums with valid-value selection;
- common structs with a structured editor rather than raw JSON;
- asset and object references with inspectable paths and constrained pickers;
- arrays, sets, and maps through an explicit structured-value surface;
- read-only, deprecated, clamp, step, unit, and description annotations;
- row references when a schema declares their target table or role.

Unknown fields must degrade to an honest read-only or structured representation. They must never be
silently dropped from a row during editing.

## Views and specialized workflows

A table grid is the default product, not the only possible surface. Public authoring data can power:

- joined or filtered views over several tables;
- row-detail forms;
- purpose-built first-party extensions;
- studio-authored UIs bound to named table roles;
- AI-generated local interfaces operating through scoped capabilities.

All surfaces draft the same typed commands into the same session. Custom UIs may read their granted
context and draft edits, but cannot Apply, Save, call arbitrary Unreal functions, access the file
system, or escape their capability grant. The trusted host keeps final review and mutation authority.

## Fixture and conformance suite

The generic fixture should contain several small tables that exercise the product rather than merely
prove connectivity:

- scalar and enum fields;
- nested structs and containers;
- asset and row references;
- validation annotations;
- a Composite DataTable with independently addressable parent assets;
- deterministic external drift for conflict tests;
- a deliberately unsupported field to verify honest degradation.

Conformance tests should drive real Unreal assets for load, edit, batch rollback, Apply, Save, drift,
and conflict behavior. Pure tests remain valuable for folding and validation, but mocks cannot define
the engine contract.

## Delivery slices

### A. Read-only spine

Discovery, connection, capability manifest, DataTable listing, schema, snapshots, CLI inspection, and
the default grid.

### B. Safe editing loop

Persistent sessions, typed cell edits, row lifecycle operations, fold, undo/redo, review, validation,
transactional Apply, and Save.

### C. Concurrent-change safety

Fingerprints, refresh, drift classification, cell/row conflicts, explicit resolution, retry, and
diagnostics that explain partial capability support.

### D. Rich everyday authoring

Structured fields, references, annotations, Composite DataTables, reusable views, and strong
keyboard/search workflows.

### E. Extensible authoring

Scoped SDK, isolated custom interfaces, role-based binding contracts, schema-aware generation inputs,
and optional project hooks through an allowlist.

Slices A and B define the minimum credible product. The actor observatory may remain the first public
demo, but authoring must not be left as a collection of future package placeholders.

## Anti-goals

- A generic spreadsheet that loses Unreal type and asset semantics.
- A UI-only implementation whose command state disappears with its renderer.
- Requiring every team to build a custom interface before table editing is usable.
- Raw arbitrary Unreal RPC exposed to embedded or generated UIs.
- Silent last-writer-wins behavior when the asset changed in Unreal.
- Treating Apply and Save as one vague action.
- Making a particular source-control system mandatory.
- Copying an internal product architecture instead of specifying and testing the public behavior.
