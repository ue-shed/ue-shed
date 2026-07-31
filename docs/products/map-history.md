# Map History product

## Product promise

UE Shed Map History explains how the saved actors in one Unreal map changed across a bounded
Perforce range. A level designer, technical artist, producer, or agent selects a project, map, and
time range; UE Shed reconstructs the relevant saved revisions and returns actor-level changes with
the changelists, authors, descriptions, package revisions, and coverage evidence that support them.

The first product is deliberately Perforce-backed. It preserves Perforce concepts rather than
flattening them into generic revisions, while keeping the dependency confined to the optional
`@ue-shed/map-history` package.

## First supported question

```text
What saved actor changes happened to this map during this bounded Perforce range,
who submitted them, and how complete is our explanation?
```

Users do not need to discover World Partition external-actor paths, sync historical workspaces,
download `.umap` or `.uasset` revisions manually, or compare parser documents themselves.

## Product boundary

### UE Shed owns

- Resolving one selected map and its matching external-actor scope.
- Finding only the submitted changelists relevant to that scope.
- Establishing a baseline immediately before the requested range.
- Materializing exact binary revisions without changing workspace have-state.
- Reconstructing each changelist atomically in an isolated temporary project tree.
- Reading saved-world actor snapshots without launching Unreal.
- Matching actor continuity using saved GUID evidence and conservative path fallback.
- Producing semantic actor changes and Perforce provenance.
- Retaining changed packages that cannot be semantically classified as visible coverage evidence.
- Explicit limits, progress, cancellation, typed failures, diagnostics, and cleanup.
- A headless Effect service, CLI operation, and focused local Workbench history view.

### Consumers own

- Project, workspace, branch, map, and time-range selection.
- Perforce credentials and connection access.
- Studio-specific taxonomy, ownership, milestones, approval, retention, and notification policy.
- Private decoders or interpretations for project-specific actor classes and native serialization.
- Central indexing, hosted storage, scheduling, web portals, permissions, and reporting.

## Supported authority

Map History reads saved editor packages. It does not describe unsaved editor memory, PIE actors,
runtime movement, construction-script results, live Data Layer state, or Map Review captures.

The first actor projection contains:

- actor GUID when serialized;
- object and package identity;
- class;
- label;
- resolved saved root-component position or an explicit resolution failure; and
- package/snapshot completeness diagnostics.

The result retains renderer-safe saved-actor snapshots immediately before the bounded range and at
its end when the map exists at those points. They contain actor facts, coordinate-resolution state,
and coverage evidence, but never the owned temporary historical workspace path. A map created
inside the requested range has no range-start snapshot and is represented by the existing
`map_not_yet_created` baseline state. Consumers can replay the semantic changelist transitions from
that start state into discrete 2D actor-map frames without reconstructing or scanning Perforce
again.

World Log's World lens defaults to the saved state after the last submitted changelist and can
scrub locally to range start or the exact saved state after any in-range changelist. It never
interpolates between submissions or renders a historical Unreal world. Each active frame labels its
coverage, empty-before-map-creation state, and retained unclassified package evidence. If the map
or range controls change, the completed result stays inspectable but is visibly marked stale until
the user starts another bounded scan.

## Deep History changelist inspection

World Log's Deep History view selects one submitted changelist locally from that completed result.
It presents all of the selected revision's semantic changes, exact package revisions, and retained
unclassified package evidence without another Perforce request. Its shared 2D point map renders
additions, removals as ghosts, changed actors, and before-to-after movement vectors only where the
saved top-down positions are resolved; unresolved actor evidence remains explicit in the ledger.
Selecting an actor from that diff preserves the selected changelist.

## Deep History actor inspection

The completed Deep History corpus has an actor lens built from stable identity across its
range-start snapshot, range-end snapshot, and semantic revisions. Its **View Filters** are local:
field-qualified `label:`, `class:`, `path:`, `package:`, and `guid:` terms can be combined with
changed, present/removed, position-resolution, and class controls without a Perforce request.

Actors removed before range end remain searchable and inspectable. Their lifecycle and semantic
event ledger retain the submitted changelists that explain their removal. A movement trail is shown
only when serialized before-and-after saved positions exist. Selecting a semantic actor event
locally focuses its corresponding changelist diff; it does not request history again.

The first semantic change vocabulary is:

- actor added or removed;
- actor moved;
- actor label changed;
- actor class changed;
- actor package/object path changed when GUID continuity proves the actor;
- actor position-resolution state changed; and
- snapshot coverage changed.

A relevant package revision may contain a serialized change outside this projection. Such a revision
is retained as an **unclassified package change**. It must not disappear or be described as
semantically unchanged merely because the current parser projection cannot explain it.

## Actor identity

Continuity is evidence-based:

1. Prefer a nonzero saved actor GUID.
2. Otherwise use exact saved package and object identity while both remain unchanged.
3. Never use an actor label as identity.
4. When continuity cannot be proven, report removal plus addition instead of inventing a rename,
   move, or package transition.

Every matched change records whether continuity came from a GUID or exact path fallback.

## Perforce reconstruction

The operation:

1. Resolves the selected local map to one depot map path.
2. Adds the matching external-actor subtree when the current map is World Partition.
3. Lists submitted changelists touching only that scope.
4. Materializes one exact baseline before the requested range.
5. Applies each relevant changelist's in-scope adds, edits, and deletes in ascending order.
6. Reads and diffs the saved world after each atomic changelist.
7. Cleans the temporary project tree on success, failure, interruption, or cancellation.

The operation never uses `p4 sync`, changes have-state, checks out files, or mutates the Perforce
server.

Historical conversion between conventional and World Partition storage is unsupported until a
generic fixture proves that both scopes can be discovered without guessing.

## Portable historical package fixture

[`fixtures/perforce-map-history`](../../fixtures/perforce-map-history) contains small,
Unreal-generated conventional and World Partition map histories. The conventional map proves a
map-file actor move; the World Partition history proves a move, label change, add, delete, and
two-package unclassified edit. Its manifests contain only project-relative paths and add/edit/delete
actions; they carry no Perforce server state or credentials.

The parser reconstructs every bundle incrementally in an owned temporary project tree during its
ordinary portable test lane. The separately gated `pnpm test:perforce-map-history` harness seeds
those same bundles as changelists in a disposable localhost `p4d` server. This keeps saved-package
truth independently testable while reserving real Perforce behavior for its own conformance lane.

The real lane never uses the contributor's active `p4` configuration: it uses explicit isolated
settings and either an explicitly supplied `p4`/`p4d` pair or a pinned, SHA-256-verified official
Perforce download cached outside the repository. Its workspace, tickets, trust data, server root,
and logs are operation-owned temporary paths.

## Limits and partial knowledge

Every query bounds its time range, changelists, packages, materialized files, concurrency, and
duration. The materialized-file bound applies to the whole baseline-plus-revision reconstruction,
not independently to each Perforce call. A limit breach is explicit and never becomes silent
truncation.

History distinguishes:

- complete semantic history within the supported projection;
- partial parser coverage;
- unclassified changed packages;
- unavailable or ambiguous Perforce mapping;
- missing baseline or historical files;
- cancellation;
- resource limits; and
- failed reconstruction.

An empty range is a successful result with its effective scope and baseline stated.

## Public workflow

The headless package owns Effect-native operations:

```ts
readPerforceMapHistory({
	projectRoot,
	mapPath,
	range,
	limits
});

readPerforceFastMapHistory({
	mode: "fast",
	projectRoot,
	mapPath,
	range,
	limits,
	target: { kind: "actor", identity }
});

readPerforceFastMapHistory({
	mode: "fast",
	projectRoot,
	mapPath,
	range,
	limits,
	target: { kind: "actor_class", classPath: "/Script/Game.Npc" }
});
```

**Deep History** reconstructs the complete selected-map scope for a bounded range. **Fast History**
is a separate request mode. It accepts either one present-day actor Investigation Target, proving
that actor's package from the SavedWorld projection, or an exact current actor class, proving every
current member's package. It scans only the selected map plus those proven packages. Fast History
results always include targeted-coverage metadata and never claim complete map or historical-class
coverage; deleted or historically reclassified class members require Deep History.

The CLI and Workbench use the same service. Workbench owns presentation only and does not receive
filesystem, subprocess, or raw Perforce authority.

The headless CLI mirrors those operations:

```text
ue-shed map history <project-root> <map-path> --since "7 days" [--until <ISO-UTC>]
ue-shed map history <project-root> <map-path> --since "7 days" --mode fast --actor-guid <guid>
ue-shed map history <project-root> <map-path> --since "7 days" --mode fast --actor-class <class-path>
```

`--since` accepts ISO-8601 UTC or an Effect duration such as `7 days`; omitted `--until` means the
current UTC time. Deep History writes the existing schema-encoded history document to stdout. Fast
History writes a discriminated document that includes `mode: "fast"` and explicit targeted coverage.
The CLI exits `0` for a complete, classified history, `3` when a successful history is partial or has
unclassified package evidence, and `2` for invalid input or failed reconstruction. Its conservative
default bounds may be tightened or raised with the `--max-*`, `--concurrency`, and
`--max-duration-ms` options.

## Workbench World Log

Workbench's focused Content Observatory route is named **World Log**. It is a presentation of the
same Perforce-first workflow, not a second history implementation: the renderer can check status,
start one bounded request, poll validated progress, and cancel its owned job. The main process keeps
the configured project root, Perforce configuration, temporary tree, and child-process authority;
the renderer never receives those capabilities.

The route shows submitted changelists chronologically and pairs a selected semantic change with its
exact package-revision evidence. The local actor lens supports precise View Filters and can focus an
actor's event in its corresponding changelist diff. Unclassified package changes are highlighted as
a coverage warning, never discarded or presented as no change. Opening Workbench or the route does
not execute a Perforce command; acquisition begins only after the user starts a query. Conservative
scan bounds are visible and editable under Advanced Limits, then validated at the same request
boundary as every other renderer input.

## First convincing demo

Use a generic Perforce fixture with one conventional map and one World Partition map:

1. Establish a baseline.
2. Move an actor.
3. Add and remove external actors.
4. Change a label and class across distinct changelists.
5. Change two actor packages atomically in one changelist.
6. Include one package change the first projection cannot classify.
7. Query one week of history through the CLI and Workbench.
8. Confirm every semantic and unclassified change points to the correct changelist.
9. Confirm an unrelated map never enters the result and workspace have-state does not change.

## Deferred work

- Referenced Blueprint, mesh, material, texture, and transitive dependency history.
- Whole-project growth, cartography, and Janitor findings.
- Persistent indexing or a global revision cache.
- Additional source-control producers and a source-neutral history abstraction.
- Runtime or live-world history.
- Project-specific identity heuristics.
- Automatic judgments about whether a change is good, expected, or safe.

## Anti-goals

- A generic Perforce revision browser.
- Requiring users to reconstruct external-actor histories file by file.
- Claiming every binary revision has a decoded semantic explanation.
- Treating actor labels as stable identity.
- Scanning unrelated depot changelists to discover map changes.
- Syncing historical revisions into the user's workspace.
- Requiring a running Unreal editor for saved history.
- Hiding partial, unsupported, missing, or unclassified evidence.
- Making Workbench the only usable implementation.
