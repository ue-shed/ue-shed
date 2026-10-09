# Plan: Live DataTable editing, the first sync-layer slice

> **Executor instructions**: This plan is parked. Do not start Phase 1 until the owner authorizes
> implementation and answers the decisions below. Before editing, read `AGENTS.md`,
> `docs/README.md`, the concept's
> [direction revision](../docs/ideas/authoring-sync-layer.md#direction-revision-2026-10-09),
> `docs/engineering/testing.md`, Plan 030 and the feasibility research on branch
> `research/sync-feasibility` (`docs/research/sync-feasibility/FINDINGS.md`). Verify every Unreal API
> against each engine's `Engine/Source`. Run every Unreal check on UE 5.7 and UE 5.8 and report each.
>
> **Drift check (run before each phase)**:
> `git diff origin/main...HEAD -- packages/authoring packages/protocol/contracts/authoring unreal/Plugins/UEShedAuthoring unreal/Plugins/UEShedCore apps/workbench extensions/data-authoring`.

## Status

- **State**: `TODO`. Parked 2026-10-09; implementation is not authorized.
- **Priority**: P2
- **Effort**: XL (Phase 1 M, Phase 2 L, Phase 3 L, Phase 4 L)
- **Risk**: HIGH. It mutates live editor objects on every edit and must stay correct under Undo,
  open asset editors, reloads and concurrent editor transactions.
- **Depends on**: the editor foreground responsiveness capability (in progress on
  `feat/editor-foreground-responsiveness`); the Apply editor-notification fix (prepared on
  `fix/authoring-apply-editor-notifications`, unverified in Unreal); a Plan 030 decision before row
  renames are mirrored.
- **Category**: direction
- **Planned at**: `docs/standalone-sync-design`, 2026-10-09, from research `research/sync-feasibility`
  at `ed076f66`. The earlier coordinator-centric phases are preserved in this file's history at
  `78470be7`.

## Context

The goal is in the concept's direction revision: editing in UE Shed is editing in Unreal. Data
Authoring is the first slice because DataTables are native editor objects and
`UUEShedAuthoringLibrary::Apply` already provides the write half: per-table fingerprint
preconditions, one `FScopedTransaction` across every table, rollback from backups, and an
operation-ID result cache. The slice turns end-of-session Apply into continuous, per-edit live
editing with a reverse stream from the editor.

### What the research established (UE 5.7.4 and 5.8.3, fixture project)

| Proven                                                                                      | Evidence       |
| ------------------------------------------------------------------------------------------- | -------------- |
| A five-table Apply is one undo entry; one Undo restores all five tables, Redo reapplies     | T10            |
| Apply marks packages dirty; Undo before Save clears dirty                                   | T10            |
| A stale Apply is rejected with `fingerprint_mismatch`, expected and live hashes             | T12            |
| Editor-side cell, row, property, Undo/Redo, save and reload edits fire observable hooks     | T08            |
| A custom `FScopedTransaction` context survives Undo and Redo                                | T09 supplement |
| One-cell Apply on small tables: ~35 ms p95 over loopback Remote Control                     | T11            |
| A foreground lease lifts background throttling, ~336 ms → ~35 ms p95 for a minimised editor | T15            |

| Gap                                                                                     | Evidence |
| --------------------------------------------------------------------------------------- | -------- |
| One-cell Apply on a 10,000-row table takes ~2.05 s p95; a full snapshot alone ~0.9 s    | T11      |
| Hooks carry no row identity, old or new values; property names are coarse               | T08, T03 |
| Apply's events carry no request ID; the transaction title is not unique provenance      | T09      |
| An open DataTable editor stays stale after Apply until editor notifications are sent    | T12      |
| Raw row-pointer and raw String Table writes fire none of the hooks                      | T08      |
| A cancelled transaction leaves changes and no finalized event                           | T10      |
| An Apply during an active editor transaction nests into it (source only, not exercised) | T03      |
| Modal dialogs, PIE and map loads were not exercised                                     | T02      |

## Decisions required before Phase 1

1. **Offline mode**: read-only over saved packages, or the existing draft session replayed as one
   Apply when an editor connects.
2. **Enablement**: a new capability (proposed `authoring.live.v1`) advertised by `UEShedAuthoring`,
   and a Workbench setting. Default on or off.
3. **First command set**: cell edits only, or cell plus row add/remove/reorder. Renames wait for the
   Plan 030 identity decision.
4. **Large-table budget**: the row count at which one-cell edits must meet the 100 ms p95 target,
   and the accepted behaviour above it.
5. **Fingerprint v2**: accept a composable fingerprint (Phase 1) beside `sha256-v1`.

## Phase 0 — prerequisites (outside this plan)

- The foreground responsiveness capability lands and is verified on 5.7 and 5.8.
- The Apply editor-notification fix is verified on 5.7 and 5.8 with an open DataTable editor,
  including the rolled-back path.

**Gate**: both merged, each with per-engine evidence.

## Phase 1 — Make one Apply cost proportional to the change

### Where the time goes today (from source)

For each table, one Apply currently does all of the following, and every step is O(table):

1. **Precondition**: `TableFingerprint` builds the full JSON snapshot (every row, plus the schema),
   then canonicalizes and hashes it. `BuildTableSnapshot` already computes the fingerprint
   internally, so the canonicalize-and-hash step runs twice.
2. **Backup**: `DuplicateObject<UDataTable>` copies the whole table into the transient package.
3. **Transaction**: `Modify()` records the whole table into the undo buffer. Native editor edits do
   the same, so this cost is Unreal's, not UE Shed's. Measure it rather than design it away.
4. **Result**: `Finish` builds a full snapshot of every table again, serializes the whole result,
   and stores that full string in the operation cache (up to 128 entries).
5. **Transport**: the result travels as a JSON string inside Remote Control's JSON response.
6. **Client**: `acceptApplyResult` decodes full snapshots, then fingerprints the drafted working
   table and the returned snapshot (and once more when it stores the new base).

### Design

- **Instrument first.** Add stage timings (precondition, backup, commands, snapshot, serialize,
  cache) to Apply's diagnostics behind a request flag. Profile `DT_LargeScalars` (10,000 rows) on
  5.7 and 5.8 before changing anything, and record the split in this plan.
- **Shadow rows.** For each table the plugin has served, keep a shadow copy of its rows: row name to
  a struct copy (`UScriptStruct::CopyScriptStruct`) and that row's hash. The shadow replaces the
  per-Apply `DuplicateObject` backup. Rollback restores only the rows the commands touched, plus
  row order for structural commands. Invalidate the shadow on package reload
  (`FCoreUObjectDelegates::OnPackageReloaded`), row-struct changes, and memory pressure.
- **Change detection without JSON.** Compare live rows to shadow rows with
  `UScriptStruct::CompareScriptStruct` (present in 5.7 and 5.8). Serialize and rehash only rows that
  differ. This gives the row identity the hooks lack, and Phase 2 reuses it.
- **Fingerprint v2.** `sha256-v2` hashes the table header (kind, object path, row struct, parent
  tables) followed by the ordered list of `(row name, row hash)`. A one-row change costs one row
  serialization plus an O(rows) pass over 32-byte hashes. `packages/authoring/src/fingerprint.ts`
  implements the same algorithm, with shared parity fixtures. `sha256-v1` stays for existing clients
  and saved-package authorities. The request names the version it expects.
- **Delta results.** A new Apply contract minor lets the request ask for `result: "delta"`. Each
  table then returns its new fingerprint, the changed and added rows in full, the removed row names,
  the order only when it changed, and the schema only when it changed. Rejected and rolled-back
  results stay unchanged. Full snapshots remain the default for older clients.
- **Smaller cache entries.** Cache the delta result. A later `LookupApplyResult` returns it, and a
  client that lost its base requests a full snapshot instead.
- **Client side.** `acceptApplyResult` applies the delta to its base. It verifies with v2 row hashes:
  the drafted working rows against the returned rows, and the table fingerprint against the
  returned one. It never rehashes the whole table.

**Gate**: on 5.7 and 5.8, a one-cell Apply on `DT_LargeScalars` meets the budget from decision 4,
measured as p50/p95/max over at least 40 runs with a normal editor and the lease held. Small-table
latency does not regress. C++ and TypeScript produce identical v2 fingerprints for every authoring
fixture. Existing v1 clients and `pnpm test:unreal-authoring` still pass. Undo bytes per Apply are
recorded for small and large tables.

## Phase 2 — Observe the editor

### Native observer (in `UEShedAuthoring`, generic extraction comes later)

- **Tracked tables**: tables a client has subscribed to, each with its shadow rows from Phase 1.
- **Triggers**: `FCoreUObjectDelegates::OnObjectTransacted` for tracked tables;
  `UDataTable::OnDataTableChangedDelegate` (thread-safe delegate in 5.8, ordinary in 5.7);
  the DataTable editor-manager listener used by the Phase 0 fix; `FEditorUndoClient`
  `PostUndo`/`PostRedo`; `UPackage::PackageDirtyStateChangedEvent`;
  `FCoreUObjectDelegates::OnPackageReloaded`. A trigger only marks a table as possibly changed. The
  observer diffs that table against its shadow once per tick, never inside the trigger.
- **Change records**: table object path, a per-table revision (monotonic within an editor
  session; the session comes from the capability manifest), changed rows, removed row names, order
  if changed, package dirty flag, and a source.
- **Sources and provenance**:
    - Apply uses `FScopedTransaction` with a UE Shed context
      (`FScopedTransaction(const TCHAR* TransactionContext, ...)`). At finalization the observer maps
      the engine transaction ID to the request's `operationId`. A finalized event with that mapping
      becomes `ue_shed_apply` with the operation ID.
    - `UndoRedo` events are always new authority changes (`undo` or `redo`), even for UE Shed's own
      transaction. They are never suppressed. Direction comes from `PostUndo`/`PostRedo`.
    - A diff with no finalized transaction (a cancelled transaction, or a raw write that fired a
      table delegate) becomes `unattributed`.
    - Reload resets the shadow and publishes a full-table change with source `reload`.
- **Reconciliation sweep**: raw writes fire no hooks, so tracked tables are diffed at a low rate
  (on lease acquisition, and on a bounded interval). The script contract is documented: change
  DataTables through `FDataTableEditorUtils` or send its notifications.
- **Active-transaction fence**: Apply refuses with a retryable `editor_busy` while
  `GEditor->IsTransactionActive()` or `GIsTransacting` is true. Verify on both engines that this
  covers an in-progress interactive drag. Never nest into the user's transaction.

### Transport

- **First**: `ReadChanges(sinceRevision per table)` over Remote Control, backed by a bounded ring
  buffer of change records per table (e.g. 256). A gap returns `resync_required` and the client
  takes a full snapshot. Poll every 50–100 ms while the foreground lease is held, and slowly otherwise.
- **Later**: a push channel, built only if polling cost or latency fails the gate. Stock Remote
  Control WebSocket presets do not cover DataTable rows (T02).

**Gate**: an automated version of the T08 matrix on 5.7 and 5.8. Each edit source yields the
expected change record, source and row set. UE Shed's Apply is attributed by operation ID; its Undo
and Redo publish as `undo`/`redo`; a cancelled transaction publishes as `unattributed`; reload forces
a resync. Edit-to-record latency, poll CPU cost with the editor minimised, and sweep cost on a
10,000-row table are measured.

## Phase 3 — Live mode in `@ue-shed/authoring`

- **Live session**: the confirmed base is kept current from change records. Pending local edits are
  an overlay of commands with mutation IDs.
- **Sending**: edits are batched over a short window (16–50 ms, measured) into one Apply per batch,
  with at most one Apply in flight per set of tables. A five-table edit is one Apply.
- **Settlement**: an overlay entry resolves when its operation's change record or Apply result
  arrives, whichever comes first, and must agree with the other when both arrive. A rejection
  removes the entry with its reason. An `editor_busy` refusal retries with backoff. A lost reply
  resolves through `LookupApplyResult`, or the entry becomes `indeterminate`, which resyncs.
- **External changes**: a record that touches a cell with a pending local edit puts that edit into a
  `conflict` state for the client to resolve. Other pending edits rebase onto the new base.
- **Undo and Redo**: client undo calls the editor's undo (`UndoTransaction`/`RedoTransaction` behind
  the capability). The draft-session undo stack applies only in offline mode.
- **Dirty and Save**: dirty flags come from change records. Save stays the existing explicit Save.
- **Offline**: whatever decision 1 chose.

**Gate**: pure and property-based tests with a fake authority. They cover every ordering of Apply
result and change record, duplicates, gaps, resync, lost replies, `editor_busy` retries and
conflicts. Pending intent is never applied twice, and confirmed state never moves backwards.
Integration tests against the fixture editor run on 5.7 and 5.8.

## Phase 4 — Workbench Data Authoring live mode

- The Data Authoring extension shows confirmed values with pending, rejected and conflict states per
  cell, and package dirty state per table. Save is unchanged.
- Live mode turns on when a connected local editor advertises the capability and the setting from
  decision 2 allows it. The lease from Phase 0 is held while connected.
- Acceptance, each on 5.7 and 5.8 with normal (not `-unattended`) editors:
    1. A one-cell edit appears in an open Unreal DataTable editor, and an editor-side edit appears in
       Workbench. Both meet the 100 ms p95 budget with the editor minimised and the lease held.
    2. A five-table edit is one undo step. Undo from Workbench and from Unreal shows correctly in both.
    3. Structural edits with an open row editor and a selected row do not crash or show stale rows
       (manual steps recorded, plus automated coverage where possible).
    4. A stale write shows a conflict in Workbench.
    5. Reload or revert of a package resyncs Workbench.
    6. Editor restart and disconnect resolve pending edits through `LookupApplyResult` or show them as
       indeterminate, then resync.
    7. Dirty state and Save match Unreal.
    8. The large-table budget from decision 4 holds.

**Gate**: Workbench component and e2e coverage for the states, the acceptance list above, the
existing Data Authoring tests, and `pnpm check`.

## Phase 5 — Extraction decision (not implementation)

After Phase 4, decide what moves into a generic bridge and a client package for the other
consumers: camera, and localization's staged edits and Level 3 writer. The candidates are the
shadow-row diff, provenance mapping, change records, `ReadChanges`, the active-transaction fence
and the client overlay. Record the decision in the concept. Nothing is extracted speculatively.

## Verification strategy

- Pure and property tests for the overlay, settlement and fingerprint v2 parity. Effect TestClock
  tests for batching, retries and polling.
- Unreal automation tests for shadow diff, provenance, the fence and rollback, run on 5.7 and 5.8.
- Live fixture runs with normal editors for latency, throttling, open-editor refresh and reload.
- Every result is reported per engine, with any unavailable gate named. The existing
  `test:unreal-authoring` gate pins 5.7, so 5.8 needs the research's separate engine-configured run
  until that gate supports both.

## STOP conditions

Stop and report rather than weakening the goal if:

- a one-cell edit cannot meet the agreed large-table budget without giving up fingerprint
  preconditions or rollback;
- UE Shed's own transactions cannot be attributed reliably, or attribution would suppress a later
  Undo or Redo;
- Apply cannot be fenced from an active editor transaction on either engine;
- structural edits crash or corrupt an open DataTable editor and no public API prevents it;
- any step would write assets outside Unreal, change the user's editor settings, or save without an
  explicit Save;
- 5.7 and 5.8 need divergent behaviour that cannot be verified in both engines' source.
