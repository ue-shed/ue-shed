# Plan 059 Phase 1: STOP report

## Rule inventory

Verified against `packages/game-text/src/localization-check-ids.ts`,
`localization-checks.ts`, `quality.ts`, `localization-policy.ts` and
`localization-custom-checks.ts`, alongside the supplied producer inventory.

The brief's Phase 1 selection is **20 built-in checks and seven authored rule kinds**.
This is the intended migration inventory, not a claim that they have been implemented.

| Phase 1 subject | Built-in checks                                                                                                                                                                                                                                                                                                               |
| --------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `line_culture`  | `format_arguments`, `argument_modifiers`, `rich_text`, `po_escape_safety`, `whitespace`, `empty_translation`, `format_argument_renamed`, `rich_text_tags`, `rich_text_tag_case`, `line_breaks`, `segment_separator`, `outdated_translation`, `rich_text_tags_added`, `source_line_endings_changed`, `placeholder_translation` |
| `line`          | `missing_translator_notes`, `placeholder_text`, `source_whitespace`, `source_markup`, `number_only_text`                                                                                                                                                                                                                      |

| Authored kind requested in Phase 1 | Current evaluation unit                                          |
| ---------------------------------- | ---------------------------------------------------------------- |
| `character_budget`                 | Raw text unit, then exact source among role-matching occurrences |
| `terminology`                      | Same groups, one finding per discouraged-term match              |
| `localization_character_budget`    | Line and culture, restricted to role-matching saved places       |
| `localization_terminology`         | Line and culture, one finding per discouraged-term match         |
| `pattern`                          | Line or line and culture; match/no-match with a match cap        |
| `length`                           | Line or line and culture; explicit code-point or visible measure |
| `forbidden_term`                   | Line or line and culture; literal terms with a match cap         |

The first two kinds need a subject/emission decision before they can use the proposed IR;
see the contract issue below. They have not silently been moved to Phase 2.

| Phase 2 exclusion                                   | Reason                                                                                                                                                                                                                                                  |
| --------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `duplicate_source` check                            | Groups distinct identities by source, requires place-aware counterpart existence and collation-based owner election.                                                                                                                                    |
| `inconsistent_translation`                          | Source/culture groups, normalized translation counts, majority and tie handling.                                                                                                                                                                        |
| `culture_invariant_text`                            | Project-wide two-pass property census, comparing keyed and invariant occurrences.                                                                                                                                                                       |
| `string_table_key_collision`                        | Distinct String Table object grouping over a line's occurrences; Plan 059 explicitly schedules it in Phase 2. This is a child-group aggregate, not a corpus-wide aggregate.                                                                             |
| `length_outlier`                                    | Explicitly scheduled in Phase 2. Its length ratio reads only its row; the deferral is consistent with its dependency on the active/in-scope `placeholder_translation` result. It is **not** intrinsically a group rule (`localization-checks.ts:1398`). |
| Native `shared`, `duplicate_source`, `long` signals | Explicit Phase 2 migration. Keep their current behavior in Phase 1. `long` is row-local, despite sharing this scheduled migration.                                                                                                                      |

## STOP: the rename fix needs an IR operation

Stopped before implementation under the brief's rule-expression STOP condition and Plan 059's
corresponding condition. This is an expressiveness issue, not an observed corpus disagreement.

`format_argument_renamed` is a Phase 1 rule. Preserving its current behavior includes its
`suggestedChange` and the report's change set, not just its detection predicate.

Verified implementation:

- `packages/game-text/src/localization-checks.ts:118`: `renameArgument` reparses the input,
  replaces argument spans, recursively rewrites plural/ordinal/gender form strings, excludes
  `hpp` forms, serializes changed forms with `JSON.stringify`, and applies replacements from
  right to left.
- `packages/game-text/src/localization-checks.ts:1293`: fix eligibility includes one missing and
  one added name, manifest presence and absence of duplicate-identity reasons. The rewritten
  translation is parsed again, and its argument set must equal the source's before a fix is
  emitted. These conditions are rule policy and must stay in the rule document.
- `packages/game-text/src/localization-checks.test.ts:61` and `:88`: existing tests require the
  fix and its PO preconditions, including a rename inside plural forms. Both tests passed here.
- `scripts/game-text-corpus-plan.ts:411` plants `format-renamed` with its exact finding evidence
  and the absence of `localization.format_arguments`. The corpus finding contract currently
  compares check/actual/expectation, not fixes (`game-text-corpus-contract.ts:18`), so dropping
  the fix could escape that corpus assertion while breaking the existing public behavior.

Concrete existing regression:

```text
source:      {N}|plural(one="{Owner} has one",other="{Owner} has many")
translation: {N}|plural(one="{Wrong} hat eins",other="{Wrong} hat viele")
required:    {N}|plural(one="{Owner} hat eins",other="{Owner} hat viele")
```

Plan 059's expression vocabulary provides a format tokenizer and token comparisons. It does
not define a string/token rewrite or serialization expression; recursion and user-defined
functions are explicitly excluded (`plans/059-game-text-query-and-rule-engine.md:174-220`).
The rule's optional `fix` field names an output, but does not supply the missing transformation.
Copying `renameArgument` into Rust and exposing it only to this rule would be the rule-specific
native function the brief says to stop on. Retaining its TypeScript implementation would also
violate this phase's deletion requirement.

The two options required by the brief are:

1. **An Unreal fact/base function.** If supported-engine source verification establishes an
   engine-defined format transformation, expose that reusable operation alongside the tokenizer.
   Keep eligibility, pairing and whether to offer a fix entirely in JSON policy. The existing
   UE Shed helper alone is not evidence that such a transformation is an Unreal fact; this
   option needs source verification before implementation.
2. **Change the IR.** Add general typed token-edit and serialization expressions, with explicit
   behavior for nested quoted forms, escaping, UTF-16 offsets, edit overlap and bounds. A rule
   can then construct substitutions from token comparisons, rewrite, reparse and validate.
   A bounded token representation can keep arbitrary recursion out of the authored language.

Recommendation: settle the general edit expression contract before publishing the v4 schema
or implementing a native fix hook. No exception or engine behavior has been invented here.

## Additional contract issue: source-rule subjects and identity

`quality.ts:83` groups role-matching occurrences by exact source within each raw unit.
`quality.ts:182` emits findings for those groups; `quality.ts:269` evaluates raw units.
This differs from evaluating one joined line's chosen source. A conflicting unit can produce
findings for several source variants with different affected-occurrence subsets. Source rules
also work without a localization target.

The plan permits `line` and `line_culture` rule subjects (`Plan 059:230`). Before moving the
two source kinds, specify how these unit/source groups are represented and emitted. A general
structural `unit_source` relation/subject, with its unit ID and member occurrences, is one
possible extension. It must preserve role-filtered evidence and multiple term matches; a
single boolean per joined line cannot itself describe their evidence multiplicity.

There are also **two existing finding-ID contracts**, not one shared formula:

- Localization findings (`localization-workspace.ts:488-531`): canonical JSON of
  `[lineId, culture, ruleId, kind, actual, expectation]`, object keys sorted, array order retained.
  Hash each JavaScript UTF-16 code unit through the existing two 32-bit lanes. Serialize as
  `localization-finding:` plus two eight-digit hexadecimal halves. Severity is excluded.
- Source findings (`quality-query.ts:335`): the existing 64-bit evidence hash of ordinary
  `JSON.stringify([ruleId, role, textUnitId, kind, actual, expectation, sortedOccurrenceIds])`.
  Serialize with the existing variable-width `quality-finding:` form. The occurrence IDs and
  role are identity inputs. Applying the localization formula, or newly sorting source
  evidence object keys, would change these IDs.

Both can remain adapters over one native evaluator; a second rule engine is unnecessary.
No identity has been changed. The source contract needs to be retained explicitly when the
native finding envelope is defined. The selected existing identity suite passed.

Row-local rule dependencies also need deliberate lowering: argument renames suppress part of
`format_arguments`; dropped tags suppress part of `rich_text_tags_added`; `placeholder_text`
records overlap with source terminology. Rule references are scheduled for Phase 2. Reusing
generic expression subgraphs with the referenced rule's resolved enabled/scope/params values
may preserve these semantics in Phase 1; hard-coded check-ID branches in Rust would not.

## 1. Commits and workspace

The branch started clean at `8b4ce3a4` on `feat/game-text-engine-phase1`.
This report is the sole documentation checkpoint; there are no implementation commits.
Its commit ID is supplied in the handoff message.

The implementation was stopped before any source, fixture expectation, defect pin, public API,
renderer or protocol change. Work and generated package outputs stayed in the designated worktree.
No push, PR, Perforce command, benchmark or Unreal run was performed.

## 2. Rule list

The complete Phase 1/Phase 2 inventory is at the top of this report. It distinguishes explicit
phase scheduling from actual cross-row requirements rather than labeling every deferred check
a group rule.

## 3. IR, evaluator and findings layer

**Not implemented because of STOP.** The required shape remains:

- Validate and type the JSON IR once; compile an expression graph into column operations over
  the selected subject relation. Execute each operation across the column rather than traversing
  an expression tree for each row.
- Cache text measures, character predicates, tokenization and regex/term results by operation
  arguments and distinct dictionary string ID. Culture-sensitive parsing also keys by culture.
  Gather these results to subject rows and combine predicates as bitsets.
- Let sparse evidence represent multiple findings for a subject, such as source and translation
  modifier issues or repeated term matches. The rule bitset represents membership, not evidence
  cardinality.
- Publish a versioned layer keyed by joined key, canonical rule-set hash and host overlay hash,
  with sparse evidence/fixes and rule/culture/severity counts. Use the existing atomic root
  publication, reader pinning and compaction remapping lifecycle.

This describes the brief's intended design, not measured or implemented behavior. There is no
performance change to report. Default selection and renderer rule storage have not been altered.

## 4. Defects

**None fixed; all existing pins remain unchanged because implementation stopped.**

| Defect pin                     | Required disposition on resumption                                                                                                                                 |
| ------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `empty-translation-whitespace` | Phase 1 row-rule fix; remove its pin after parity.                                                                                                                 |
| `reference-missing-key`        | Phase 1 facts fix to `string_table_entry_missing`; remove its pins.                                                                                                |
| `native-source-override`       | Phase 1 facts split candidate; resolve against native-archive source behavior and remove fixed instances.                                                          |
| `compiled-copy-differs`        | Phase 1 facts split candidate; preserve stale runtime copies as copies rather than conflicting authored places.                                                    |
| `collapse-mode-identity`       | Phase 1 facts split candidate; unique namespace/source pairs must not receive target-wide ambiguity.                                                               |
| `deleted-package-not-found`    | Also present in the pin code for fuzz edits; verify complete-inventory absence while rewriting facts in Phase 1. It has not been dismissed as a later-phase issue. |
| `wired-pin-shared`             | Remains pinned for Phase 2 as the brief directs.                                                                                                                   |
| `detail-culture-scope`         | Remains pinned for Phase 3 as the brief directs.                                                                                                                   |
| `manifest-notes-filter`        | Remains pinned for Phase 3 as the brief directs.                                                                                                                   |

The first six are still Phase 1 work, not accepted permanent deferrals. No expectation was
changed to hide a disagreement.

## 5. Corpus and fuzz results

| Required run                        | Result                     |
| ----------------------------------- | -------------------------- |
| UE 5.8 canonical corpus comparison  | Not run after design STOP. |
| UE 5.7 canonical corpus comparison  | Not run after design STOP. |
| Corpus integration test             | Not run after design STOP. |
| New-seed 10,000-line fuzz on UE 5.8 | Not run after design STOP. |

No corpus parity, zero-unexpected/zero-stale, or fuzz pass is claimed. No heavy run was started,
so the shared Unreal lock was neither acquired nor modified. Its existence did not cause STOP.

## 6. Checks run

All Node commands used **Node 26.12.0**, with `RAYON_NUM_THREADS=16`,
`CARGO_BUILD_JOBS=8` and `UE_SHED_UNREAL_LOCK=E:\es-id-repairs-scratch\unreal.lock`.
Dependency/cache/temp paths used for this work were kept inside the worktree.

- `pnpm install` with worktree-local store/cache directories: passed, lockfile unchanged.
- Plan 059 drift check against `origin/main`: no scoped drift before work.
- `pnpm --filter '@ue-shed/game-text...' --recursive --if-present run build`: passed.
- `node scripts/test.ts --without-uasset packages/game-text/src/localization-checks.test.ts packages/game-text/src/localization-finding-ids.test.ts packages/game-text/src/quality.test.ts --maxWorkers=1`:
  **3 files, 19 tests passed**, zero failures. This checks existing behavior; no native executable
  or native auto-build was used.
- Report formatting and Git whitespace checks: run before committing this report; results
  supplied in the handoff.

The requested Rust tests/Clippy, repository-wide typecheck/lint/format, architecture/public API
gate and broad host/extension suites were not run after STOP. No engine implementation or
completed Phase 1 gate is claimed.

## 7. Deletions

None. The TS checks, reference oracles and dead native paths remain until an implemented and
verified replacement can be committed. Removing them at this STOP would break existing behavior.

## 8. Open decisions and suggested cut

1. Choose and specify the general fix expression, or verify and approve an Unreal base operation.
   This is the triggering STOP decision.
2. Specify the subject/emission representation for the two source-rule kinds and preserve their
   separate identity formula, including occurrence IDs.
3. Decide whether row-local rule dependencies lower to shared expressions in Phase 1 or whether
   the minimal dependency-reference surface should move forward from Phase 2.

The smallest useful next cut is the v4 contract and representative rule definitions: the rename
rule including its nested-form fix, plus a conflicting-unit budget and a repeated terminology
match. Resolve their subjects, evidence and fix expressions before the native evaluator or host
switch. Facts and dead-code cleanup can then form their own logical implementation commit,
followed by column execution, findings publication and host adoption. Phase 1 remains incomplete.
