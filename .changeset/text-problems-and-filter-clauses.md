---
"@ue-shed/game-text": minor
---

Classify every line by problem and filter with clauses. `TextProblem` lists problems worst first
(key changed, same key with different text, not gathered, changed since gather, translation work,
finding, up to date), and search pages add `problems`, counted without the request's problem
clauses. Requests accept `filter`, a list of `{ field, op: "is" | "is_not", values }` clauses over
problem, finding, translation state, origin, folder, editing and translator notes; the existing
request fields keep their meaning. Localization selections accept `cultures`, a culture set that
scopes states, counts and translation work. `text-problems.ts` exports the pure classification and
matching.

Group and facet the matching lines. Requests accept `group` (problem, folder, asset, origin or
namespace), `openGroup` and `facets`; pages add `groups`, worst first and bounded at 200 with a
count of the rest, and `facets` with folders a level at a time, assets, origins and per-culture
work. Clauses add `asset` and `namespace`. `text-groups.ts` exports the pure grouping, and
`textFileLabel` spells a file the way the project does.

Investigation presets accept optional `filter` and `group`; presets saved before them still open.

Search requests accept `lines`, up to 5,000 localization line ids, to act on a selection.
`localizationLinesCsv` accepts `cultures` and then keeps the native culture plus those columns;
`pickedLocalizationCultures` reads the picked cultures from a localization selection.

Joining a large localization target is much faster: a 50,000-line, 14-culture target joined in
about 30 seconds and now joins in about 1.5 seconds, and per-culture counts take one pass.
