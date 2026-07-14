# Asset audits

> Status: product vision; a Workbench range for corpus-wide inspection and conformance

## Ambition

Give each content discipline a queryable, visual account of the assets it owns instead of a validator
log, a spreadsheet export, or a collection of project-specific editor utilities.

An audit should do more than list failures. It should reveal the shape of a corpus: distributions,
outliers, conventions, exceptions, missing relationships, and changes over time. A technical artist
should see how texture memory is distributed before opening the largest offender. An audio designer
should hear and compare the loudness outlier, not merely receive a warning code. An animator should
find every sequence carrying a notify and understand whether its timing is unusual.

Asset Audits is one Workbench destination containing a growing range of specialist lenses. The
lenses share an interaction language, but each discipline keeps its own meaningful measurements and
questions.

## North star

Turn every supported asset family into an explorable corpus where a user can move from distribution
to outlier to evidence to an intentional decision.

The route should answer both:

- **What is unusual or inconsistent?**
- **What does normal look like for this project and this scope?**

The second question prevents the product from becoming another stream of context-free warnings.

## Who it serves

- **Technical artists** reviewing import settings, dimensions, memory signals, naming, and drift.
- **Audio designers** reviewing source characteristics, loudness, class assignment, and coverage.
- **Animators and technical animators** exploring sequence characteristics, curves, and notifies.
- **Designers and UX teams** reviewing input coverage, conflicts, and gameplay-tag usage.
- **Leads and producers** understanding the scale, ownership, and trend of audit concerns.
- **Teams with local conventions** that want declarative rules without maintaining editor code.

The route should feel native to each discipline while remaining consistent enough that learning one
audit makes the others approachable.

## Product range

### Texture and import audit

Expose dimensions, format, compression, color-space flags, mip behavior, texture group, naming,
source availability, and other useful import evidence as a queryable corpus. Pair a dense asset sheet
with distributions and saved questions such as:

- Which textures are unusually large for their group?
- Which masks are marked as color data?
- Where do folder peers disagree on compression or mip policy?
- How much of the selected scope is concentrated in a few assets?

The product should support convention discovery as well as explicit rules. A lone setting difference
may be intentional; seeing it beside twenty peers makes the decision legible.

### Audio audit

Bring sample rate, channels, duration, compression settings, sound-class relationships, and available
source analysis into one surface. Loudness distributions should lead to playable evidence so an
audio designer can hear the outlier in context.

The audit should distinguish package metadata, source-audio measurements, and unavailable evidence.
It should not present an inferred loudness value as though it came from the final in-game mix.

### Animation corpus

Index sequences, montages, lengths, rates, compression signals, curves, slots, sections, and notifies
where available. Search should make scattered authored events behave like a corpus:

- everywhere a footstep or hit notify appears;
- unusually early or late notify timing;
- sequences missing an expected event or relationship;
- inconsistent conventions among otherwise similar assets.

This begins as exploration and only becomes conformance where a team has declared an expectation.

### Input atlas

Present mappings across contexts and platforms as a single control vocabulary. Reveal conflicts,
unbound actions, overlapping contexts, inconsistent affordances, and documentation gaps. The result
should be useful to designers and UX reviewers, not only programmers who understand the underlying
asset structure.

### Gameplay tag atlas

Show the taxonomy and actual usage together: where tags appear, which branches grow, which tags are
unused, and what a rename might affect. Tree browsing, usage distributions, and blast-radius review
belong in the same lens.

### Declarative validation

Allow teams to express project conventions as named rule packs over the same corpus used by the
built-in audits. Rules should produce evidence in the common audit experience without forcing every
discipline into one generic field model.

Rule packs are an extension of exploration, not its replacement. Users should still be able to see
the underlying values and distributions that explain why a rule exists.

## Route shape

### Summary

Show recent scans, coverage, major distributions, newly observed concerns, and lenses that need
attention. Avoid combining unrelated severities into one score. A texture import concern and an
audio loudness outlier deserve their own context even when shown on the same summary.

### Lens navigation

Each audit lens should offer a recognizable progression:

1. select a project scope or saved view;
2. see corpus size, coverage, and important distributions;
3. filter or select an outlier group;
4. inspect assets and the evidence behind a concern;
5. compare against peers or declared rules;
6. record an exception, ownership note, or follow-up where supported;
7. export or revisit the exact scoped result.

### Asset inspection

Selecting an asset should keep the user inside the audit context. Show the relevant measurements,
peer comparison, triggered rules, evidence availability, and links to related lenses. Opening the
asset in Unreal may be a useful escalation, but it should not be required to understand the finding.

### Rules and exceptions

Rules need human-readable intent, scope, severity, evidence, and recovery guidance. Exceptions should
record why they exist and whether they are permanent or worth revisiting. “Ignore” without context is
not a durable workflow.

## Principles

### Show the corpus before judging it

Distributions, grouping, and peer comparison often reveal more than a pass/fail list. Start with the
authored landscape, then layer explicit expectations over it.

### Specialist meaning beats a universal asset score

Texture dimensions, audio loudness, notify timing, input conflicts, and tag usage are different kinds
of evidence. They can share navigation and finding conventions without pretending to be the same
measurement.

### Findings must be explainable

Every finding should identify the observed value, the expectation or comparison that made it notable,
the scope in which it was evaluated, and what evidence was unavailable. A user should be able to
disagree intelligently.

### Rules are authored policy

UE Shed may ship broadly useful checks, but project conventions belong to the project or team. Folder
patterns, acceptable ranges, naming conventions, and exceptions should be declarative and visible,
not hidden assumptions in product code.

### History adds context, not automatic blame

When Content Observatory history is available, an audit can show when a concern appeared, whether it
is spreading, and which change carried it. The audit should not treat the author of a changelist as
the owner of every resulting concern.

### Evidence quality is part of the result

An audit may have package metadata but not source media, partial decode coverage, or no trustworthy
estimate of runtime cost. Those limitations must travel with summaries, charts, exports, and rules.

### Remediation remains deliberate

The route can explain likely recovery steps and assemble follow-up work. It must not bulk-edit assets,
rewrite tags, or change import settings as an incidental consequence of scanning.

## First convincing demo

Start with texture/import auditing as the first complete lens, then add audio to prove that Asset
Audits is a range rather than a texture-specific product.

1. Populate a generic fixture with a small, visually understandable texture set: ordinary peers,
   one oversized asset, one non-power-of-two asset, and deliberate setting disagreements.
2. Open the route to a texture summary with dimension, group, and setting distributions.
3. Select an outlier from a chart and see the corresponding assets in the sheet.
4. Inspect one asset beside its peers and explain exactly why it was raised.
5. Apply a simple named rule pack and show the same evidence as a finding rather than a separate
   validation path.
6. Add a small audio set with intentionally different levels, channels, and sample rates.
7. Move to the Audio lens, select a loudness outlier, and audition it alongside a normal peer.
8. Return to the summary and show both lenses with honest, separate coverage.

The demo succeeds when the user understands the corpus before reading a warning and can move from a
distribution to a concrete asset without opening Unreal.

## Growth path

- Animation notify search and sequence distributions.
- Input coverage and conflict views across contexts and platforms.
- Gameplay-tag taxonomy with usage and rename impact.
- Saved team scopes and reusable declarative rule packs.
- Baseline comparisons around milestones without freezing one project state as universal truth.
- Historical trends supplied by Content Observatory.
- Review exports that retain scope, rules, evidence, and coverage.
- Cross-links to Lookbook for visual selection and to Authoring where supported data can be changed
  through an explicit authoring session.

## Anti-goals

- A single score that combines unrelated disciplines and severities.
- A flat validator log as the primary interface.
- Treating statistical outliers as automatic defects.
- Project-specific conventions embedded as universal UE Shed policy.
- Rules whose evidence cannot be inspected.
- Claiming runtime or final-mix truth from incomplete source metadata.
- Requiring custom Unreal project code for ordinary read-only reporting.
- Silent bulk repair or mutation from the audit screen.
- Replacing discipline judgment with generic “best practices.”
- A universal asset schema that erases specialist meaning.

## Product decisions to earn

The first summary measures; the default texture and audio distributions; how scopes and peer groups
are expressed; the shared finding language; how rules and exceptions are reviewed; whether teams
need assignments or only ownership notes; how historical comparisons appear; and which additional
audit lens earns the next place in the route.
