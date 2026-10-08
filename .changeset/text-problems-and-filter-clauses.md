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

Joining a large localization target is much faster: a 50,000-line, 14-culture target joined in
about 30 seconds and now joins in about 1.5 seconds, and per-culture counts take one pass.
