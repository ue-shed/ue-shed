# Content observatory

> Status: product vision; combines project cartography, content growth, history, and hygiene

## Ambition

Make an Unreal project's content legible as a changing body of work rather than a folder tree full
of opaque files.

A producer, technical artist, or lead should be able to open one place and understand what the
project contains, what is growing, what depends on what, how an asset arrived at its current state,
and where cleanup deserves attention. An investigation should move naturally from a project-level
signal to a folder, asset, changelist, reference edge, or authored value without asking an engineer
for a one-off report.

This combines four catalog ideas into one Workbench destination:

- **Project cartography:** what exists and how content is connected;
- **Content growth observatory:** where size and asset count are changing;
- **Content time machine:** how assets and authored values evolved in Perforce;
- **Project janitor:** what appears unused, duplicated, redirected, empty, or otherwise costly.

They are distinct capabilities, but they answer one continuous question: **how did this project get
into this shape, and what should we look at next?**

## North star

Every asset should have an explainable place in the project:

- what it is and what it costs;
- what refers to it and what it refers to;
- when, why, and by whom it changed;
- whether a concern is current, historical, or merely suspected;
- what evidence supports a proposed cleanup.

The observatory is not a cleanliness score. It is a navigable account of current structure and
change over time, designed to support judgment rather than replace it.

## Who it serves

- **Producers** tracking growth, ownership, and the content behind schedule or footprint changes.
- **Technical artists** investigating dependencies, duplicates, redirectors, and cleanup candidates.
- **Designers and content owners** reviewing the history of a particular asset or authored value.
- **Engineers** answering why content is present without reconstructing reference chains by hand.
- **Leads** establishing whether a project trend is intentional, temporary, or neglected.

The route should remain useful to someone who does not understand package serialization or Perforce
commands. Those mechanisms provide evidence; they are not the product vocabulary.

## Product shape

The Workbench route is one progressively disclosed investigation space, not four unrelated tools in
a sidebar.

### Overview

Open with a concise account of the selected project and time range:

- current asset count and known content size;
- growth over the selected period;
- folders and asset families responsible for the largest changes;
- newly introduced dependency or hygiene concerns;
- notable changelists and unresolved cleanup plans;
- coverage and blind spots that qualify every number.

The overview should answer “what changed enough to deserve attention?” Each card or chart must lead
to the underlying assets and evidence.

### Explore

Provide a queryable inventory organized by the project's own folders and asset types. Users should
be able to search, filter, group, compare, and move between a table, distribution, and dependency
context without losing the active scope.

This is where project cartography begins: not with an impressive graph of everything, but with a
useful answer to questions such as “what pulls this texture into the project?” or “which assets in
this folder are referenced outside it?” A graph is one explanatory view, not the default product.

### Growth

Show size and count over Perforce history by folder, asset family, owner signal, or another available
dimension. A user should be able to select a spike and see the changelists and files that produced
it, then distinguish an intentional content drop from gradual accidental growth.

Growth is not automatically bad. The product should emphasize attribution and trend changes rather
than red numbers for large files.

### History

Treat the time machine as a contextual lens available from assets and decoded values:

- when an asset appeared, moved, or changed;
- which changelists touched it and what those changelists said;
- how a selected table, curve, string, setting, or other supported value changed;
- a comparison between any two meaningful points;
- nearby project growth or dependency changes that help explain the event.

The strongest experience is not a generic revision browser. It is selecting an authored value and
seeing a comprehensible timeline of that value, annotated with the Perforce history that carried it.

### Janitor

Collect evidence-backed hygiene findings: apparently unused assets, redirectors, empty folders,
content-identical duplicates, broken references, and other findings earned by the available corpus.

Each finding should explain:

- why it was raised;
- what roots and reference kinds were considered;
- what uncertainty remains;
- when the condition first appeared or how long it persisted;
- the likely benefit and blast radius of acting;
- who or what may still depend on it.

The route may assemble findings into a reviewed cleanup plan. A plan is an artifact for human review,
not permission to silently mutate the project.

## Principles

### Current truth and history belong together

A current-state warning is much more useful when the product can say when it began. A growth spike is
more useful when it leads to the assets and values that changed. History should be a shared lens
throughout the route rather than an isolated archive screen.

Perforce is the first history experience. The product may support other sources later, but it should
not flatten away useful Perforce concepts such as changelists, descriptions, authors, depot paths,
and revisions.

### Move from signal to evidence without restarting

Overview, inventory, dependencies, growth, history, and Janitor should preserve the user's active
project, scope, asset, and time range where that context remains meaningful. The product succeeds
when a surprising chart becomes an explained set of files in a few deliberate steps.

### “Unused” is a claim, not a fact

Reference analysis always has roots, exclusions, unsupported reference kinds, generated content,
and project conventions. The observatory must present those assumptions alongside the result.
“No known path from these roots” is honest; “safe to delete” requires stronger evidence and review.

### Explain causes before prescribing actions

Large, old, duplicated, or highly connected assets are not inherently wrong. Prefer explanations,
comparisons, and ownership context over universal health scores. When the product recommends an
action, the recommendation should be traceable to evidence the user can inspect.

### Preserve project language without embedding project knowledge

Folders, asset types, Perforce paths, owners, labels, and user-defined saved views can reflect how a
team organizes its work. UE Shed should not require a prescribed content taxonomy or encode one
studio's notion of discipline, ownership, or acceptable size.

### Make partial knowledge visible

Every project view should disclose scan scope, supported asset families, unavailable history,
unresolved references, ignored roots, and stale results. Missing evidence should reduce confidence,
not disappear behind a precise-looking number.

### Read-only is the valuable default

Inventory, history, growth, dependency analysis, and Janitor reporting should provide substantial
value without changing the project. Cleanup remains an explicit, reviewable escalation with a clear
preview of intended effects.

## First convincing demo

Use a small generic project history with deliberate, understandable events:

1. Establish a baseline containing a few related assets and one authored balance table.
2. Add a visible content drop in a later Perforce changelist.
3. Introduce a duplicated large asset, an orphan candidate, and a redirector or broken reference.
4. Change one meaningful numeric table value across several changelists.
5. Open the Content Observatory to a growth spike and identify the responsible changelist and files.
6. Follow one file into its dependency context and explain why it is present.
7. Select the table value and chart its authored history with changelist annotations.
8. Open Janitor, inspect the duplicate and orphan evidence, and add them to a cleanup plan.
9. Review the plan's estimated recovery, uncertainty, and affected references without applying it.

The demo should feel like one investigation. It begins with “why did the project grow?” and ends with
an explained history and a cautious, reviewable response.

## Growth path

- Saved views for recurring production and discipline-specific questions.
- Historical dependency edges and “when did this become reachable?” explanations.
- Trends for orphan count, duplicate bytes, redirectors, and broken references.
- Ownership and review annotations without prescribing a studio org chart.
- Changelist and branch comparisons around milestones or release candidates.
- Exportable reports and cleanup plans for teams that do not use Workbench.
- Cross-links into Asset Audits and Lookbook while preserving the current scope and asset.

## Anti-goals

- A single project-health score that hides why something was classified as healthy or unhealthy.
- Treating all project growth as waste.
- Declaring an asset safe to delete from incomplete reference evidence.
- A spectacular whole-project graph that is harder to use than a filtered list.
- Reimplementing a generic Perforce client UI inside Workbench.
- Requiring a running Unreal editor for ordinary inventory, history, or reporting.
- Silent deletion, redirector fixing, moving, or source-control mutation.
- Studio-specific folder rules or ownership assumptions built into the product.
- Exact-looking charts that conceal unsupported files or missing history.

## Product decisions to earn

The initial project overview; the most useful default growth dimensions; how users express project
roots and exclusions; which Janitor findings deserve first-class status; what makes a cleanup plan
shareable and reviewable; how history appears inside other views; how saved scopes are named and
shared; and how much uncertainty users need inline versus on demand.
