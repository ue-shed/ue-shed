# Game text workbench

> Status: early Workbench and CLI corpus slice shipped (scan/search); localization editing, Apply,
> and Save remain vision. The [review workspace](game-text-review-workspace.md) sketches how review
> should work at the scale of a shipping game.

## Ambition

Make every piece of player-facing text in an Unreal project discoverable and understandable from one
place.

Writers, narrative designers, localization teams, and reviewers should not have to remember whether
a line lives in a DataTable, a String Table, an `FText` property on another asset, or an exported PO
file before they can find it. They should be able to search the game's language as a corpus, inspect
where a text unit appears, understand its localization state, make supported edits safely, and see
whether length, terminology, or translation expectations are being met.

The product should feel like a writing and localization workbench, not a package browser with a text
filter. Unreal serialization, namespaces, keys, gather data, and PO mapping provide its evidence, but
those mechanisms should stay behind language that reflects the work: source text, occurrence,
context, culture, translation, budget, terminology, draft, Apply, and Save.

## North star

Every player-facing text unit should have one explainable place in the corpus:

- what the source text says;
- which Unreal identity anchors it;
- where it is authored and where it occurs;
- which cultures have current translations;
- which quality or budget concerns apply;
- whether it can be edited here, and through which authority;
- what evidence is missing when the answer is incomplete.

The Workbench succeeds when someone can move from “where does the game say this?” to a reviewed,
safe change without first reverse-engineering the project's storage layout or rebuilding Unreal's
localization links by hand.

## Who it serves

- **Writers and narrative designers** searching, revising, and reviewing source language across the
  project.
- **Localization teams** entering and reviewing translations with Unreal's established identities
  and PO workflow intact.
- **UX and UI designers** checking character budgets, likely overflow, terminology, and consistency
  across related screens.
- **Audio and narrative production** understanding which lines exist and which identities later
  connect to recording and VO assets.
- **QA and reviewers** finding text by phrase, culture, asset, state, or diagnostic without tracing
  package ownership manually.
- **Engineers and technical writers** explaining coverage gaps and localization state without being
  the only people able to query it.

The route should remain useful to someone who does not know the difference between an `FText`
history, a gatherable-text record, and a localization archive. Those distinctions qualify evidence
and edit authority; they are not the primary navigation.

## Product shape

### Corpus

Open into a searchable corpus over the selected project and localization targets. The initial
editable sources are DataTable `FText` cells and String Table entries. The durable product also finds
gatherable `FText` embedded in supported arbitrary assets, even when those occurrences are not yet
editable.

Search and filtering should combine:

- source and translated text;
- Unreal namespace and key;
- table, row, field, String Table key, package, asset class, and property path;
- localization target and culture;
- translated, untranslated, stale, or unresolved state;
- read-only, source-editable, or translation-editable capability;
- length, terminology, duplicate, and other diagnostics;
- parser coverage and unsupported evidence.

The default view should make language easy to scan. Storage details appear as context and filters,
not as the organizing principle. Equal source strings are not automatically one text unit: Unreal
identity remains the durable distinction.

### Text focus

Selecting a text unit should preserve the surrounding search while revealing a focused account:

- source text and its Unreal-owned namespace/key identity;
- all known authored and gathered occurrences;
- native culture and available translations;
- comments and contexts preserved by the PO workflow;
- length and character counts by culture;
- applicable terminology and budget findings;
- saved-package, live-editor, and PO provenance;
- current edit capability and the reason for any read-only state;
- freshness, parser version, scan scope, and unresolved evidence.

An occurrence is first-class evidence. Two assets may intentionally share an identity, while two
identical strings may serve different contexts and require different translations. The focus view
must explain both cases without flattening them into a string-only index.

### Source authoring

Supported source text follows the same safe model as the rest of UE Shed authoring:

```text
saved package evidence -> persistent draft -> review -> live Unreal Apply -> explicit Save
```

Saved packages are permanently read-only. Game Text Workbench must never patch `.uasset` or `.umap`
files directly. DataTable and String Table source changes go through narrow Unreal capabilities in a
live editor, under a transaction, with drift detection and distinct Apply and Save results.

The UI should make authority unmistakable. A user can begin from saved evidence, but applying a
source change requires a compatible live Unreal session. An arbitrary-asset `FText` occurrence
remains read-only until that asset family and property path have earned a safe, capability-scoped
mutation contract. Generic unchecked property mutation is not the shortcut.

Drafts should support focused editing, bulk review, undo and redo, and clear conflict handling. A
text domain may be mechanically simple, but stale source, changed identity, or simultaneous edits
must never become silent last-writer-wins behavior.

### Localization workspace

The Workbench should offer simple translation input without becoming a replacement localization
system.

Unreal's namespace/key identity and PO pipeline remain authoritative. UE Shed may discover configured
localization targets, ask Unreal to gather and export PO files, present those entries by culture,
stage translation edits, show a reviewed PO diff, write the selected PO file atomically, and ask
Unreal to import and compile the result. Unreal owns the mapping between project text and PO entries.

The product must preserve PO contexts, comments, flags, plurals, headers, and entries outside the
active edit. If Unreal reports an unresolved or stale mapping, Workbench should show that result
rather than invent a link from matching source strings.

Manifests, archives, `.locres`, and `.locmeta` are workflow or compiled evidence, not manual editing
authorities. They should be regenerated through the official Unreal workflow rather than modified by
UE Shed.

The useful interaction is intentionally modest: select a culture and scope, enter translations,
review changes, synchronize through Unreal, and see what remains untranslated or stale. Translation
memory, vendor management, assignment, billing, and hosted collaboration belong to dedicated TMS
products.

### Quality and coverage

Text quality should be expressed as inspectable rules over the same corpus, not as a separate lint
command with a different decoding path.

Useful first rules include:

- character or rendered-length budgets attached to user-defined roles or scopes;
- forbidden, preferred, or inconsistent terminology;
- placeholders or format arguments that differ between source and translation;
- duplicate source strings under distinct identities;
- missing source, context, or translation;
- culture-specific character, whitespace, or punctuation concerns;
- translations that are stale relative to their source according to Unreal's workflow evidence.

Rules remain project-authored. UE Shed provides a generic rule language, explanations, evidence, and
scope; it does not ship one studio's terminology, UI budgets, target cultures, or narrative schema as
product defaults.

Every report and chart must carry coverage. Counts should distinguish discovered, decoded, partial,
unsupported, failed, and stale packages or entries. “Twenty percent untranslated” is meaningful only
when the product also says which localization targets, cultures, package roots, asset families, and
parser capabilities were included.

### Review and export

Source drafts, PO changes, and diagnostics should assemble into a reviewable change set without
collapsing their different authorities. A reviewer should be able to see:

- what source or translation changed;
- why it was changed and which rule or budget motivated it;
- which identities and occurrences are affected;
- whether the operation writes through live Unreal or an atomic PO update;
- whether Unreal Apply, Save, import, and compile have occurred;
- which coverage gaps prevent a stronger claim.

CSV, JSON, and static reports can support handoff and offline review, but their contents should
retain stable Unreal and occurrence identities where available. An export is evidence or an exchange
artifact, not a second authoring authority that silently diverges.

## Principles

### Unreal owns localization identity

Namespaces, keys, gather behavior, and PO mapping are Unreal concepts with compatibility and history
behind them. Preserve and expose them. Do not replace them with UE Shed IDs, infer links from equal
strings, or make users repair a parallel identity graph.

UE Shed may assign a deterministic identity to an observed occurrence for its own provenance, but
that identity must never masquerade as the Unreal text identity.

### Saved packages are evidence, never a write target

The package reader enables broad, editor-free discovery. That does not authorize package mutation.
All asset writes pass through live Unreal with transactions, capability checks, conflict detection,
Apply, and separate Save.

This boundary is permanent, including after the parser becomes capable of decoding more asset
families.

### Comprehensive is a direction with measurable coverage

“All player-facing text” is the end-state promise. The parser cannot fulfill it today, and no early
slice should pretend otherwise. Start with strong DataTable and String Table support, decode package
gatherable-text evidence, and expand `FText` histories and asset families deliberately.

Coverage is therefore a product surface and a roadmap input. Unsupported evidence should remain
visible enough to explain why search results or localization percentages are incomplete.

### Source and translation are related but distinct workflows

A source edit changes an Unreal asset and follows Draft, Apply, and Save. A translation edit changes
a PO exchange artifact and follows Draft, atomic write, Unreal import, and compile. Their text may
appear side by side, but their authority, conflicts, failure states, and receipts must remain honest.

### One corpus, multiple provenances

Package evidence, live editor state, and exported PO entries are different observations of related
text. Normalize them into one navigable product while retaining the provenance required to explain
disagreement, staleness, or edit capability.

The normalized corpus is a domain model, not permission to erase the boundaries between its sources.

### Writing should feel faster than storage archaeology

Preserve search, selection, filters, and editing context. Favor keyboard navigation, clear text
density, readable comparisons, and progressive disclosure. Namespace, package, and property details
should be one gesture away without crowding every row.

### Project language is configured, not assumed

Teams decide their text roles, budgets, terminology, cultures, localization targets, package roots,
and saved scopes. UE Shed should make those choices expressible and reusable without encoding a
particular game, studio, schema, or source-control system.

### Headless behavior is the durable product

Corpus scans, search, coverage, diagnostics, drafts, PO synchronization, Apply, and Save must remain
available through public packages and CLI commands. Workbench is the maintained first-party
experience, not the owner of text state or a privileged integration layer.

### Game text deserves data minimization

Source and translated text may be confidential or narratively sensitive. Structured telemetry
should default to identities, counts, sizes, durations, and diagnostic codes rather than logging
complete text. Explicit exports may contain content because that is their purpose; ordinary logs
should not.

## First convincing demo

Use a generic fixture with a small, recognizable set of UI and dialogue-like text:

1. Create a DataTable containing named UI messages and a String Table containing prompts and status
   text.
2. Place a few `FText` values in other supported fixture assets, including shared identities,
   equal-source/different-key cases, a String Table reference, and one intentionally unsupported
   history or asset shape.
3. Configure a native culture and two translated cultures through normal Unreal localization
   targets and deterministic PO exports.
4. Open the corpus without Unreal running and search for a phrase across DataTables, String Tables,
   arbitrary asset occurrences, and available translations.
5. Focus a text unit and show its identity, multiple occurrences, cultures, provenance, and edit
   capability.
6. Filter to one UI role and reveal a length-budget issue plus a terminology inconsistency.
7. Draft a DataTable or String Table source edit, attach to live Unreal, review the change, Apply it,
   and Save explicitly.
8. Enter one missing translation, review the PO diff, and synchronize it through Unreal's official
   import and compile workflow.
9. Re-scan and show the updated source, translation, and diagnostic state.
10. Finish on coverage: supported content is accounted for and the intentionally unsupported text is
    still visible as a qualified blind spot.

The emotional payoff is that a writer can find and safely improve language across the game while the
tool remains truthful about where that language comes from and what it does not yet understand.

## Growth path

- Broader `FText` history decoding and gatherable-text coverage in the owned UAsset parser.
- Coverage-led support for additional asset families and property contexts.
- Safe, asset-specific live mutation beyond DataTables and String Tables where conformance earns it.
- Better placeholder, plural, rich-text, whitespace, and culture-specific diagnostics.
- User-defined text roles that connect schemas, paths, tables, keys, and rules without hardcoding a
  project taxonomy.
- Incremental indexing and change detection once measured project scale justifies persistence.
- Source and translation history through normal source-control evidence.
- Saved review scopes and portable reports for localization milestones.
- Cross-links into Narrative Studio for script views, scratch VO, and recording pipelines without
  folding those products into the text corpus core.
- Codex and design-bible exports derived from selected text roles and cultures.
- Agent-assisted suggestions operating only through scoped drafts and normal human review.

## Anti-goals

- Direct writes to `.uasset`, `.umap`, `.locres`, `.locmeta`, localization manifests, or archives.
- A replacement namespace/key system or string-matching identity graph.
- Reimplementing Unreal's gather, PO linking, import, or compilation semantics.
- A hosted translation-management system with accounts, assignments, vendors, and billing.
- Generic unchecked Unreal property mutation in order to claim arbitrary-asset editing.
- Calling a partial DataTable/String Table scan “all game text.”
- Merging equal source strings that have distinct Unreal identities or contexts.
- Requiring a running editor for search, coverage, diagnostics, or ordinary review.
- A UI-only corpus or draft model that disappears with Workbench.
- Studio-specific terminology, roles, paths, cultures, or budgets built into the product.
- Silent Apply, Save, PO import, compilation, or conflict resolution.
- Folding screenplay views, TTS, VO asset tracking, or narrative production boards into the first
  product slice.

## Product decisions to earn

The default corpus density and grouping; how much Unreal identity appears inline; the first useful
text roles and generic rule vocabulary; whether character count or rendered measurement is the right
first budget; which `FText` histories and asset families most improve real coverage; how scan
completeness is summarized without overwhelming writers; how PO drafts preserve formatting while
remaining reviewable; which localization operations should launch an editor versus a commandlet;
how source and translation changes appear in one review; and when measured project scale justifies an
incremental index.
