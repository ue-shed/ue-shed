# Asset lookbook

> Status: product vision; visual browsing and curation over live project assets

## Ambition

Give artists, art directors, and designers a visual way to understand and curate the content a
project already owns.

Today, teams often browse the Content Browser, take screenshots, paste them into a board, and then
lose the connection between the board and the assets it was meant to discuss. The Lookbook should
preserve that connection. A collection titled “props for the fishing village” should remain a set of
live asset references with useful context, not a collage that silently becomes stale.

The product is both a better visual browser and a lightweight curation workspace. It helps someone
discover candidates, compare them, make a selection, explain the selection, and hand the result to
another person without requiring Unreal to remain open.

## North star

Turn project content into a living visual vocabulary: searchable, comparable, and curatable, with
every image still connected to the asset and project evidence it represents.

The Lookbook is successful when a board can replace “screenshot the Content Browser into Miro” while
remaining simpler and more project-aware than a general-purpose whiteboard.

## Who it serves

- **Art directors** surveying the available visual language and assembling references for a theme.
- **Environment and prop artists** finding reusable content before creating or importing more.
- **Level designers** selecting candidate assets for a space, encounter, or gameplay purpose.
- **Quest and narrative designers** gathering visual references around a location or story beat.
- **Producers and reviewers** understanding a proposed set without locating every asset in Unreal.

It is designed for visual decision-making. Asset Audits answers whether content follows expectations;
Lookbook answers what is available, what belongs together, and what a team wants to use.

## Product shape

### Library

Open into a fast visual grid over the selected project scope. Search and filtering should combine
recognizable asset identity with useful metadata such as type, path, tags, dimensions, recent change,
or other supported properties.

The library should make broad visual scanning pleasant:

- stable thumbnails with clear loading and unsupported states;
- density controls that preserve useful labels and selection targets;
- multi-select and keyboard-friendly curation;
- filters that can be understood and removed at a glance;
- visible distinctions between assets, variants, and unresolved entries;
- no requirement to load the asset into a running editor simply to browse it.

The grid is not meant to reproduce every Content Browser operation. Its advantage is comparison,
query, curation, and continuity outside Unreal.

### Asset focus

Selecting an asset should open a focused view without losing the surrounding search or board. Show a
larger preview, identity, path, relevant metadata, nearby variants, board membership, notes, and
links to available history or audit evidence.

The focus view should make uncertainty explicit. A cached thumbnail may not represent the latest
source, some asset families may have no useful preview, and a moved or deleted asset may require
resolution.

### Boards

A board is a deliberate collection of live project references organized around a question or intent:

- props for a particular environment;
- material directions for a biome;
- candidate characters for a scene;
- rejected and preferred variants;
- a review set for an upcoming milestone.

Boards should support lightweight grouping, ordering, headings, notes, and annotations. They should
favor clear comparison over unrestricted whiteboard mechanics. The product earns richer spatial
layout only if it improves real curation work.

### Review and handoff

A board should communicate what its author intended:

- purpose and scope;
- selected, alternate, and rejected candidates where useful;
- notes tied to an entry or group;
- unresolved or changed assets;
- enough identity for another user or tool to act on the selection.

Exports may be useful for people outside Workbench, but the durable board should retain live links
and reveal when its evidence changes.

## Principles

### Live references are the differentiator

The thumbnail is presentation; the asset identity is the durable subject. Boards should survive
ordinary project evolution where identity can be resolved and show an explicit unresolved state
where it cannot.

### Browsing and curation are one loop

Users should be able to search, compare, collect, arrange, annotate, and return to discovery without
copying identifiers between modes. A board is not a separate destination that forgets the query that
created it.

### Visual speed matters

The route should feel useful at a glance. Preserve scroll position, selection, and board context;
avoid layout shifts; reveal previews progressively; and keep unsupported or missing thumbnails
legible rather than substituting misleading generic art.

### Metadata supports the eye

Paths, types, tags, dimensions, history, and audit findings should help narrow and explain visual
choices. They should not crowd the grid or turn Lookbook into another spreadsheet. Details appear
when they help someone compare or decide.

### Curation is not correctness

A preferred asset is not necessarily the technically healthiest asset, and an audit finding does not
automatically disqualify a visual candidate. Cross-links to Asset Audits should add context while
leaving the creative decision visible and human-owned.

### Collaboration should stay lightweight

The product should make a board understandable to another person without becoming a hosted design
platform with accounts, permissions, and a parallel asset library. How boards are shared can evolve;
their content should remain portable and inspectable.

### Staleness must be visible

A board should indicate when referenced assets are missing, moved without resolution, materially
changed, or represented by stale or unavailable previews. It should not silently preserve an old
image as though the underlying asset were unchanged.

## First convincing demo

Use a small generic art set with a clear visual theme and deliberate variation:

1. Populate the fixture with a few families of simple props, materials, and textures that are easy
   to distinguish at thumbnail size.
2. Open Lookbook to the full library and demonstrate fast visual browsing without Unreal running.
3. Search and filter down to candidates for a named environment concept.
4. Compare variants in a focused view while preserving the result grid.
5. Create a board, group preferred and alternate candidates, and add concise notes.
6. Return to the library, add another asset, and show that the active board remains present.
7. Open a board entry and follow it back to its live asset identity and available metadata.
8. Demonstrate one changed or unresolved asset state so the board proves it is more than a collage.
9. Present the board in a clean review mode suitable for a short handoff conversation.

The emotional payoff is simple: a useful art-direction board emerges directly from real project
content, and every choice remains connected to the thing the team can actually use.

## Growth path

- Saved library views for environments, disciplines, asset families, and milestones.
- Stronger variant comparison and side-by-side inspection.
- “New or changed since” views supplied by Content Observatory history.
- Audit context supplied by Asset Audits without turning findings into creative verdicts.
- Board templates for common selection and review workflows.
- Portable review exports that retain stable asset identity where possible.
- Optional board annotations, decisions, and ownership signals for lightweight collaboration.
- Links from selected assets into Unreal, Authoring, or downstream studio-specific workflows.
- Generated codex or design-bible exports composed from curated boards and authored data.

## Anti-goals

- A pixel-for-pixel clone of Unreal's Content Browser.
- A general-purpose whiteboard or hosted digital-asset-management platform.
- Screenshots that lose their relationship to project assets.
- Assuming every asset has a useful or current embedded thumbnail.
- Hiding missing, moved, changed, or unresolved entries.
- Turning technical audit findings into automatic creative rejection.
- Requiring a running editor for ordinary browsing and board review.
- Project-specific categories built into UE Shed.
- Unbounded layout mechanics that overwhelm selection and comparison.
- Silent project mutation from a curation board.

## Product decisions to earn

The default library density and metadata; the first supported visual asset families; how much board
layout freedom improves real work; the vocabulary for preferred, alternate, and rejected candidates;
how board sharing should work without becoming a hosted platform; what constitutes a material asset
change; how unresolved references are repaired; and which review export is valuable enough to ship.
