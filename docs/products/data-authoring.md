# DataTable authoring product

## Product promise

UE Shed should make ordinary Unreal DataTable work straightforward out of the box. A user should not
need to build a custom UI, write a script, or understand Remote Control to inspect and safely edit a
table.

Generic tooling is the boundary, not a reduction in ambition. DataTables, row structures, enums,
object references, validation, asset saving, and conflict handling are generic Unreal concerns. The
suite should offer a polished default workflow for them while keeping project-specific rules in
schemas, annotations, hooks, and optional extensions.

Inspection is useful without a running editor. UE Shed treats saved project files as a first-class
read-only authoring source and adds a separately enabled companion when live editor state or mutation
is needed.

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
saved project packages             live editor + UEShedAuthoring
        |                                      |
@ue-shed/unreal-assets                  live authoring adapter
        \                                      /
                 @ue-shed/authoring
  snapshots + command log + fold + validation
  preflight + conflicts + apply + save
                    |
       host-neutral authoring services
           /                 \
first-party Data Authoring   CLI automation
extension
           |
     Workbench or another trusted host
```

- `@ue-shed/unreal-assets` adapts the versioned `uasset` CLI JSON contract and owns no authoring
  policy. Its authoring result follows the same language-neutral contract as the live companion.
- `UEShedAuthoring` exposes the smallest generic live-state and mutation operations missing from
  supported stock Unreal APIs.
- `@ue-shed/authoring` owns behavior and state transitions; a renderer does not become the authority.
- The saved-package reader, C++ companion, and TypeScript libraries derive their authoring shapes
  from one language-neutral contract rather than translating between independent models.
- `@ue-shed/authoring-sdk` exposes browser-safe reads and draft operations to the maintained
  first-party interface without exposing filesystem or raw Unreal access.
- `extensions/data-authoring` is the maintained default product interface.
- Workbench composes that extension but receives no private authoring endpoint.
- `ue-shed` CLI commands cover discovery, inspection, validation, diff, apply, and save for automation.

## Session model

The selected Unreal authority remains canonical. A read-only project-files session is based on a
saved package snapshot. A live session is based on editor memory and may differ from disk until Save.
Every snapshot records its authority and provenance. A UE Shed editing session holds a base snapshot
and a command log; working state is derived by folding active commands over that snapshot.

```text
base snapshot + commands[0..undo pointer] = working table
```

Commands carry stable identity, gesture-group identity, authored-at time, authorship, table and
session-stable row identity, base fingerprint, and dispatch state. The initial command union is Set
Cell, Add Row, Remove Row, Rename Row, and Reorder Rows; structured fields and containers are complete
typed cell values. Apply uses a preflight plan: validate the working state, compare semantic
fingerprints, classify drift, request resolutions for supported conflicts, and send one bounded
multi-table batch. A failed batch must not pretend that some commands succeeded.

Apply and Save are separate because they answer different questions:

- **Apply:** should the connected Unreal editor adopt this working state?
- **Save:** should the affected assets be written to disk now?

Source-control checkout is an optional adapter around Save, not a core assumption.

Successful Apply rebases the active draft onto returned live snapshots and records an Apply receipt.
It does not erase the still-unsaved state. Save records a separate receipt, allowing the Draft to
Applied to Saved pipeline to survive process restarts and remain reviewable.

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

A table grid is the default product, not the only possible surface. The first-party table sheet
switches **Grid** and **Charts** over the same filtered rows. Public authoring data can also power:

- inferred charts over the current filtered rows;
- joined or filtered views over several tables;
- row-detail forms;
- purpose-built maintained first-party extensions.

All maintained surfaces draft the same typed commands into the same session. The headless service
keeps review and mutation authority outside the renderer.

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

Project and asset discovery, package-reader negotiation, DataTable listing, normalized schema,
authority-tagged snapshots, CLI inspection, and the default grid. A running editor is optional.

### B. Safe editing loop

Persistent sessions, typed cell edits, row lifecycle operations, fold, undo/redo, review, validation,
transactional Apply, and Save.

### C. Concurrent-change safety

Fingerprints, refresh, drift classification, cell/row conflicts, explicit resolution, retry, and
diagnostics that explain partial capability support.

### D. Rich everyday authoring

Structured fields, references, annotations, Composite DataTables, reusable views, and strong
keyboard/search workflows.

### Deferred: arbitrary custom UI hosting

An untrusted or generated-interface platform would require a separate product decision, capability
model, isolation boundary, threat model, and publishing policy. It is not part of the maintained
authoring roadmap. Trusted hosts may embed the first-party extension through its narrow browser-safe
client contract.

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
- Turning the first-party editor into a general untrusted-UI hosting platform without a separate
  product and security decision.
