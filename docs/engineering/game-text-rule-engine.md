# Game Text rule engine: Phase 1 specification

This is the Phase 1 specification for [Plan 059](../../plans/059-game-text-query-and-rule-engine.md). It decides the API, the formats and the module boundaries. The implementer follows it, and doesn't redesign it.

Behaviour is defined by today's TypeScript, cited as `file:line` under `packages/game-text/src/`. The [fixture](game-text-corpus.md) (`pnpm corpus:compare`) is the oracle. Where this spec and today's code disagree on a value, today's code wins unless a pinned defect or a numbered decision in Plan 059 says otherwise.

"Today's code" means the code after the Phase 1 fact repairs (`0ffdb2bf`). Line numbers drift as the work goes on, so re-check a citation before implementing it.

## 1. Scope

### Rules in Phase 1

Every rule that reads only its own row, plus references to other rules on the same row.

**On `line_culture` (16):**

- `format_arguments`, `argument_modifiers`, `rich_text`, `po_escape_safety`, `whitespace`, `empty_translation`;
- `format_argument_renamed`, `rich_text_tags`, `rich_text_tag_case`, `line_breaks`, `segment_separator`;
- `outdated_translation`, `rich_text_tags_added`, `source_line_endings_changed`, `placeholder_translation`;
- `length_outlier`. It reads its own row plus a reference to `placeholder_translation`, so it moves up from Phase 2.

**On `line` (7):**

- `missing_translator_notes`, `placeholder_text`, `source_whitespace`, `source_markup`, `number_only_text`;
- `string_table_key_collision`. It is a child aggregate over the line's own occurrences, so it also moves up from Phase 2.
- `string_table_entry_missing`. It reads the line's own String Table references, so it also moves up from Phase 2.

**Authored kinds (7):**

| Kind                                                              | Subject                                                               |
| ----------------------------------------------------------------- | --------------------------------------------------------------------- |
| v1 `character_budget`, v1 `terminology`                           | `unit_source`                                                         |
| v2 `localization_character_budget`, v2 `localization_terminology` | `line_culture`                                                        |
| v3 custom `pattern`, `length`, `forbidden_term`                   | `line` for subject `source`, `line_culture` for subject `translation` |

**Phase 2 keeps:** `duplicate_source`, `inconsistent_translation`, `culture_invariant_text` (corpus census), and the native `long`, `shared` and `duplicate_source` signals.

### Not in Phase 1

- Browse chips: Phase 3, with findings as query fields.
- The compiled `.locres` stage.
- Default changes and the host overlay: Phase 2. Phase 1 keeps today's effective selection, and hashes an empty overlay.
- Sorting, paging and counting findings in the engine: Phase 3. They stay in TS in Phase 1.

### Collation

Wherever today's code uses `localeCompare` or `new Intl.Collator()` with no locale, the engine uses an icu4x `icu_collator` for the host's locale:

- The host passes `new Intl.Collator().resolvedOptions().locale` in `findings_evaluate`.
- The locale is part of the findings-layer key.
- A locale icu4x doesn't support falls back to root, and the engine reports that in the response.

This covers:

- the order of `formatModifiers` (`localization-checks.ts:110-116`), which is part of identity;
- `sourceCulture` (`:345`);
- the culture loop order (`:859`);
- occurrence order by ID (`:775`, `localization-custom-checks.ts:137`, `localization-policy.ts:71`);
- `unit_source` group order (`quality.ts:95`).

A test pins the Rust collator against Node's `localeCompare` for `en` and `sv` on a sample that includes case, diacritics, punctuation, CJK and astral characters.

## 2. Subjects and their fields

The evaluator sees three relations.

- Field names are the public IR names; how they map to physical columns is the implementer's choice.
- Strings are WTF-8 in the store, with UTF-16 semantics for every length, offset and comparison.

### `line`

One row per joined line, keyed and keyless. Fields:

| Field                       | Type                       | Definition                                                                                                     |
| --------------------------- | -------------------------- | -------------------------------------------------------------------------------------------------------------- |
| `lineId`                    | string                     | The line ID.                                                                                                   |
| `identity`                  | `{namespace, key}` \| null | Null for a keyless line.                                                                                       |
| `source`                    | string                     | The line's saved source.                                                                                       |
| `manifestSource`            | string \| null             | `line.manifest[0].source.Text`.                                                                                |
| `comparisonSource`          | string                     | `manifestSource ?? source` (`localization-checks.ts:937-938`).                                                 |
| `sourceVariants`            | string list \| null        | See below.                                                                                                     |
| `comparable`                | bool                       | `sourceVariants == null \|\| manifestSource != null` (`:945`).                                                 |
| `checkable`                 | bool                       | `identity != null` and not (both `comparisonSource` and `source` blank after JS `trim`) (`:901, :940`).        |
| `sourceCulture`             | string \| null             | `localizationSourceCulture` (`:337-349`), with root collation.                                                 |
| `sourceLatestOrigin`        | string                     | `latestOrigin` of the `sourceCulture` row. `"absent"` when there is none (`:977`).                             |
| `nativeCulture`             | string \| null             |                                                                                                                |
| `gathered`                  | bool                       | `manifest.length > 0`.                                                                                         |
| `bytecodeOnly`              | bool                       | `:950-952`.                                                                                                    |
| `manifestNotes`             | string list                | `localizationManifestNotes` over every manifest entry, flattened.                                              |
| `manifestLocations`         | string list                | Unique and sorted by code unit (`:946`).                                                                       |
| `originKind`                | string                     | `line.origin.kind`.                                                                                            |
| `stringTables`              | string list                | `localizationStringTables` (`:203`), or the native equivalent `context.stringTables` uses.                     |
| `missingStringTableEntries` | `{tableId, key}` list      | The line's String Table references whose table is known (a resolved entry names it) but whose entry is absent. |

`sourceVariants` is null unless the line has `conflicting_source`. Then it is the distinct `source` values of the authored (non-String-Table) units' occurrences, or of every unit's occurrences when none is authored, sorted by code unit. It is null when fewer than two remain (`:751-761`).

Child relation `occurrences`, the saved places, ordered by `id` with root collation (`:775`):

| Field                                     | Definition                         |
| ----------------------------------------- | ---------------------------------- |
| `id`, `packageFile`, `source`, `devNotes` | As today.                          |
| `location`                                | As `TextLocation`.                 |
| `unitStatus`                              | The owning unit's identity status. |

### `line_culture`

One row per line × target culture, without `outside_target` cultures. Rows are ordered by line, then culture with root collation. Each row can read its parent's fields as `line.<field>`, plus:

| Field                   | Type                                | Definition                                                                                                                                                                                                                                                                                                                                      |
| ----------------------- | ----------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `culture`               | string                              |                                                                                                                                                                                                                                                                                                                                                 |
| `state`                 | string                              | The localization state.                                                                                                                                                                                                                                                                                                                         |
| `facts`                 | string list                         |                                                                                                                                                                                                                                                                                                                                                 |
| `unknownReasons`        | string list                         |                                                                                                                                                                                                                                                                                                                                                 |
| `reducedSourceChecking` | bool                                |                                                                                                                                                                                                                                                                                                                                                 |
| `isNative`              | bool                                |                                                                                                                                                                                                                                                                                                                                                 |
| `isSourceCulture`       | bool                                |                                                                                                                                                                                                                                                                                                                                                 |
| `po`                    | string \| null                      | `msgstr[0]` when a PO entry exists.                                                                                                                                                                                                                                                                                                             |
| `archive`               | string \| null                      | The archive translation `Text`.                                                                                                                                                                                                                                                                                                                 |
| `archiveSource`         | string \| null                      | The archive `source.Text`.                                                                                                                                                                                                                                                                                                                      |
| `latest`                | string \| null                      | `localizationShippedTranslation(...).value`.                                                                                                                                                                                                                                                                                                    |
| `latestOrigin`          | `"po"` \| `"archive"` \| `"absent"` | The same function's `origin`.                                                                                                                                                                                                                                                                                                                   |
| `expectedSource`        | string \| null                      | Exactly what `localizationExpectedSource(...)` returns at the branch head, used by `outdated_translation` and `source_line_endings_changed` (`localization-checks.ts:1112`, `localization.ts:317`). It is computed natively with the same inputs, including the native culture's archive and the metadata comparison. It is a fact, not a rule. |

### `unit_source`

One row per (raw text unit with searchable source, exact occurrence source), with fields `textUnitId` and `source`. It needs no localization target.

Child relation `occurrences`: that unit's occurrences with this `source`, in the unit's occurrence order (`quality.ts:83-97`). The role filter is the rule's `affected` expression.

## 3. The rule document, v4

The engine owns the v4 document: it is defined in Rust (`crates/game-text-index/src/rules/ir.rs`), and its TypeScript types are generated into `packages/protocol/src/game-text-contract.generated.ts`. A Rust test fails when the generated file drifts. The builder, translator and catalogue live in `packages/game-text/src/rules/`, exported as `@ue-shed/game-text/rules`.

```jsonc
{
	"schemaVersion": 4,
	"roles": [
		/* TextRole, unchanged */
	],
	"rules": [
		/* Rule */
	]
}
```

### Rule fields

| Field               | Required | Meaning                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| ------------------- | -------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `id`                | yes      | Unique in the document. References, the layer columns and the canonical order use it.                                                                                                                                                                                                                                                                                                                                                   |
| `ruleId`            | no       | The `ruleId` findings carry. Default `id`; it may repeat across rules. Built-in examples emit `localization.<check>`, and authored rules emit their authored IDs. Today a valid document may hold an authored rule whose ID equals a built-in's, because `SafeIdentifier` allows dots (`quality-schema.ts:7`). The translator then gives the authored rule `id: "<family>:<authored id>"` and keeps `ruleId`, so identity is unchanged. |
| `kind`              | yes      | The finding `kind` hosts see.                                                                                                                                                                                                                                                                                                                                                                                                           |
| `label`             | yes      |                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| `subject`           | yes      | `line`, `line_culture` or `unit_source`.                                                                                                                                                                                                                                                                                                                                                                                                |
| `family`            | yes      | `"builtin"`, `"policy"`, `"custom"` or `"source"`. It decides which list a finding is returned in (§8). The translator sets it.                                                                                                                                                                                                                                                                                                         |
| `enabled`           | no       | Default `true`.                                                                                                                                                                                                                                                                                                                                                                                                                         |
| `severity`          | yes      |                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| `params`            | no       |                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| `scope`             | no       | `LocalizationCheckScope`, with today's semantics. For `line`, the culture tested is `sourceCulture`. For `unit_source`, `cultures` is ignored.                                                                                                                                                                                                                                                                                          |
| `role`              | no       | Recorded on the finding. For `unit_source` it is part of identity.                                                                                                                                                                                                                                                                                                                                                                      |
| `let`               | no       | Named subexpressions, evaluated at most once per row, or per element when they read the element.                                                                                                                                                                                                                                                                                                                                        |
| `each`              | no       | A list expression: one candidate finding per element.                                                                                                                                                                                                                                                                                                                                                                                   |
| `eachAs`            | no       | The element's binding name. Default `item`.                                                                                                                                                                                                                                                                                                                                                                                             |
| `when`              | yes      | Bool. Null counts as false.                                                                                                                                                                                                                                                                                                                                                                                                             |
| `actual`            | yes      | Object. Part of identity.                                                                                                                                                                                                                                                                                                                                                                                                               |
| `expectation`       | yes      | Object. Part of identity.                                                                                                                                                                                                                                                                                                                                                                                                               |
| `fix`               | no       | A proposed translation, `line_culture` only. The engine builds `LocalizationChange` as `:1314-1322` does.                                                                                                                                                                                                                                                                                                                               |
| `affected`          | no       | An occurrence list. Default: every occurrence of the line, in relation order. For `unit_source`, every member.                                                                                                                                                                                                                                                                                                                          |
| `translationOrigin` | no       | Overrides the subject's default: `latestOrigin` for `line_culture`, `line.sourceLatestOrigin` for `line` (`:985`).                                                                                                                                                                                                                                                                                                                      |
| `extra`             | no       | Object. Fields added to the finding but not part of identity: custom `check`/`label`/`subject`, `unreportedMatches`.                                                                                                                                                                                                                                                                                                                    |
| `recovery`          | yes      | String or a string expression.                                                                                                                                                                                                                                                                                                                                                                                                          |
| `counts`            | no       | Default `true`. Not read in Phase 1.                                                                                                                                                                                                                                                                                                                                                                                                    |

### Objects and key order

- Evidence objects keep the key order their `{"object":…}` literal is written in. The canonical JSON keeps it too (`serde_json` with `preserve_order`).
- Only the localization hash input sorts keys (§7).
- A key whose value evaluates to null is left out of the object. `[]` stays. Today's evidence has no explicit null values, and "absent" differs from "empty" (for example `unreportedMatches`, `localization-quality-index.ts:877`).

### Load-time validation

Rule IDs are unique, roles are declared, every expression type-checks, every `param` exists, and the reference graph has no cycles. Failures use `GameTextRuleDocumentError`, with new codes `invalid_expression` and `rule_cycle`.

## 4. Expressions

An expression is JSON.

- **A literal** is `{"lit":<json>}`, for scalars too. A bare scalar is not an expression; the TypeScript builder writes the `lit` for it.
- **A list** is `{"list":[...]}`.
- **An object** is `{"object":{...}}`, and its values are expressions.
- **Every other node** has exactly one key, the operator. Each operator's arity is part of the IR type.
- **Nesting** is bounded by the JSON reader: a document nests at most 127 levels, and deeper input is a typed error, never a stack overflow. The default catalogue document nests 29.

**Types:** `bool`, `int` (i64), `number` (f64), `string`, `list<T>`, `object`, `occurrence`, and `null` (allowed anywhere). Functions return null when a required argument is null, unless they say otherwise. Types are checked at load time.

**Numbers in JSON output** (evidence and hash input) are formatted as JS `Number.prototype.toString` does: `2`, not `2.0`, and `1e+21`. Use `ryu-js`.

### References and bindings

| Operator                                | Meaning                                                                            |
| --------------------------------------- | ---------------------------------------------------------------------------------- |
| `field "latest"`, `field "line.source"` | A subject field.                                                                   |
| `param "name"`                          | A rule parameter.                                                                  |
| `var "name"`                            | A `let` binding, or a list-operator element.                                       |
| `occurrences []`                        | The subject's child occurrences.                                                   |
| `get [obj, key]`                        | `key` is a string expression for one key; a literal dotted path reads nested keys. |

### Logic and comparison

| Operator               | Notes                                    |
| ---------------------- | ---------------------------------------- |
| `and`, `or`, `not`     |                                          |
| `if [c, a, b]`         |                                          |
| `eq`, `ne`             | Deep equality.                           |
| `lt`, `le`, `gt`, `ge` | Numbers, or strings by UTF-16 code unit. |
| `in [v, list]`         |                                          |
| `isNull`, `coalesce`   |                                          |

### Arithmetic

`add`, `sub`, `mul`, `div` (f64), `min`, `max`, `round [x, digits]`. `round` is `Math.round(x*10^d)/10^d`.

### Strings

**Measures, each with an explicit name:**

- `utf16Length`, `codePoints`;
- `visibleLength` (`localization-text-shape.ts:207`);
- `visibleWords` (`:377`);
- `interiorLineBreaks` (`:408`).

**Transforms:**

- `trim` (JS);
- `lower` (JS `toLowerCase`);
- `normalizeLineEndings` (`:426`);
- `slice [s, start, end]`;
- `concat [...]`.

**Tests and searches:**

- `startsWith`, `endsWith`, `contains`;
- `countOccurrences` (`:153`);
- `findAll [s, needles]`: literal, non-overlapping, leftmost-first over the list order, giving `{match, start, end}`.

**Character classes:**

- `anyChar [s, class]`, `allChars [s, class]`;
- `removeClass [s, class]`;
- `trimClass [s, class, side]`;
- `leadingClass [s, class]`, `trailingClass [s, class]`: the edge runs, as strings;
- `runs [s, class, minLength]`: how many maximal runs are at least that long.

**Class values:**

- `{"category":"L"|"M"|"N"|"P"|"S"|"Z"|…}`;
- `"jsSpace"` (`:185`);
- `"textCharWhitespace"`;
- `"wide"` (`:168`);
- `{"chars":"…"}`;
- `{"union":[…]}`.

### Regex and terms

Matches are `{match, start, end}` with UTF-16 offsets. They are returned in order and may be empty; empty matches count toward a cap.

- **`regexMatches [s, pattern, {caseSensitive, cap}]`.** `cap` is an int or null (no cap). It is used by custom `pattern` checks only.
    - **Dialect.** Patterns are JS (`u` flag). The engine parses them and rewrites them for `fancy-regex` (plan 059 decision 2) with JS semantics:
        - `\d` becomes `[0-9]`;
        - `\w` becomes `[A-Za-z0-9_]`, plus U+017F and U+212A when case-insensitive;
        - `\b` and `\B` become lookarounds on that `\w`;
        - `\s` becomes the `jsSpace` set;
        - `.` becomes `[^\n\r  ]`;
        - `^` and `$` match only at the ends.
    - **Lone surrogates stay distinguishable, as in JS.**
        - In the text, each lone surrogate U+D800–DFFF becomes the private-use code point `U+10F800 + (unit − 0xD800)` before matching.
        - In the pattern, `\uD800`–`\uDFFF` escapes that don't form a pair are rewritten to the same code points. Escaped pairs combine into one code point, as JS `u` mode does.
        - Match offsets map back to UTF-16 through the position table: a lone surrogate is 1 unit, the private-use stand-in is 2.
        - Text that already contains U+10F800–U+10FFFF is the only collision. It is documented, and it can't come from Unreal text that matters.
    - **Proof:** a differential test runs a pattern-and-input corpus through Node `RegExp` and the engine, and the results must be equal. The corpus includes lone surrogates and surrogate escapes.
    - **Budget:** a backtrack limit per match. Over budget means no finding plus the existing diagnostic code `syntax_limit` for that line and culture, whatever `report` is. No new diagnostic code and no renderer label.
- **`regexTest [s, pattern, flags]`.**
- **`termMatches [s, term, caseSensitive]`:** `quality.ts:108-134` exactly. No cap.
- **`termListMatches [s, terms, caseSensitive, boundary]`.**
    - `boundary` is `"lmn"` (`[\p{L}\p{M}\p{N}]`, terminology) or `"lmnu"` (`[\p{L}\p{M}\p{N}_]`, placeholders).
    - It finds non-overlapping matches of the alternation of `terms`, leftmost-first in list order, the way JS does with `(?:a|b)` (`localization-text-shape.ts:324-333`).
    - Case folding is JS `iu` when case-insensitive.
- **`sortByStart [matches]`:** stable.

### Lists

| Operator                                               | Notes                                                                                                                                     |
| ------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------- |
| `count`                                                |                                                                                                                                           |
| `filter`, `map`, `flatMap`, `any`, `all`               | Arguments `[list, expr]` or `[list, expr, "name"]`. The element binds as `item`, or as `name`, so an outer element stays readable inside. |
| `flatten`                                              |                                                                                                                                           |
| `distinct`                                             | First-seen order.                                                                                                                         |
| `sortCodeUnit [list, keyExpr?]`                        |                                                                                                                                           |
| `sortLocale [list, keyExpr?]`                          | Root collation, stable.                                                                                                                   |
| `first`, `take`, `drop`, `concatLists`, `minus`, `zip` |                                                                                                                                           |

### Occurrences

- `matchesRole [occurrence, roleId]`: `matchesTextRole` (`quality.ts:56`). The role definitions come from the document.
- `pathHasPrefix [occurrence, prefix]`.

### Unreal grammar: base functions (Unreal facts)

Each has exactly the semantics of the named TypeScript function, and its tests are ported with it.

**The format pattern:**

- `formatPattern [text, culture]` (`unreal-text-syntax.ts:191`).
- `formatArgumentNames` (`localization-checks.ts:105`): distinct and sorted by code unit.
- `formatArgumentOrder` (`:743`).
- `formatModifiers` (`:109-116`): root collation.
- `formatIssues`, `formatCompiled`.
- `formatRenameArgument [text, from, to, culture]` (`:118`). It returns a string or null, and recurses into nested forms inside the function. The IR has no recursion.

**Rich text:**

- `richTextCounts` (`unreal-text-syntax.ts:355`);
- `richTextValid` (`:376`);
- `richTextTagBalance` (`localization-text-shape.ts:106`);
- `compareRichTextTags` (`:40`);
- `withoutOptionalArgumentTags` (`:129`).

**Whitespace:**

- `unrealWhitespace` (`unreal-text-syntax.ts:402`);
- `unrealUnsafeWhitespace` (`:421`).

**Format braces:**

- `formatBraceBalance` (`localization-text-shape.ts:140`).

### Rule references, same subject row only

- `{"finding":"<ruleId>"}` → bool.
- `{"findingField":["<ruleId>", "actual.renamed"]}` → a value from the referenced rule's first finding on this row, or null.

A reference sees the referenced rule as the document resolves it. If that rule is off, out of scope, or has no finding on this row, the reference is false or null. This reproduces today's `active()` gates (`localization-checks.ts:1269, 1327, 1403`, and `:1212-1224` for tags).

### Heuristics are written as expressions

`placeholderTranslation`, `placeholderMatchRanges`, `numberOnlyText`, `sourceWhitespace`, `lengthOutlier`, `lengthOutlierMinimumRatio`, `translationGroupKey`, the `\n`/`\r`/`\t` escapes and the custom kinds are all written in the example rules, using the operations above and no regex.

If one can't be expressed exactly, add the smallest general operation that makes it expressible, and record it in this file.

## 5. Evaluation (native, `crates/game-text-index/src/rules/`)

### Values

- **A column** is typed, with a null bitmap: `Bool` (bitset), `Int(Vec<i64>)`, `Num(Vec<f64>)`, `Str(Vec<StrId>)` or `Val(Vec<ValId>)`.
- **`StrId`** is the store dictionary's ID for a stored string.
    - A string computed during evaluation (`trim`, `lower`, `slice`, `concat`, `formatRenameArgument`, …) is interned into a per-evaluation side dictionary, whose IDs follow the store's.
    - Interning hashes the WTF-8 bytes. Never JSON.
- **`ValId`** indexes a per-evaluation arena of structured values: lists, objects and match records. They are interned by a structural hash of their typed contents.
- **`serde_json::Value` exists only at emission,** when a finding's evidence is built.

### Subject relations

- **Columns over rows, built once per evaluation from the joined layer.**
    - Stored strings are their dictionary IDs; the text isn't copied.
    - Derived fields (`comparisonSource`, `comparable`, `checkable`, `sourceVariants`, `sourceCulture`, `sourceLatestOrigin`, `latest`, `latestOrigin`, `expectedSource`, …) are computed once as columns.
- **`line_culture` reads `line.*` through a row→line index,** with no per-row copy.
- **Child `occurrences` use a CSR layout:** offsets per subject row into a vector of occurrence rows. Occurrence fields are columns over occurrence rows.
    - `matchesRole(o, role)` and `pathHasPrefix(o, prefix)` are computed once per (role or prefix) into a bitset over all occurrences.
    - Scope reads those bitsets.
- **Occurrence JSON** (`TextQualityAffectedOccurrence`) is built only for emitted findings, once per distinct occurrence set. It feeds the `places` table.

### Execution

1. **One DAG per subject.** All of a subject's rules compile into one DAG, and identical subexpressions are one node, as today.
2. **Selections.** A node is evaluated over a selection, which is a sorted row-index vector. Its result is a column aligned to that selection.
3. **Scalar nodes compute once per distinct input tuple.**
    - Build a map from the input-ID tuple (`StrId`/`ValId`/scalars) to a result slot.
    - Evaluate each distinct tuple once, in parallel over tuples with rayon, then scatter.
    - The per-node memo lives for the whole evaluation, so later selections reuse it.
4. **`and`, `or` and `if` narrow the selection** for their later arguments. That is short-circuiting by selection, so expensive tails such as format parses only see rows that passed the cheap gates.
5. **Scope runs before `when`.**
    - The culture check comes first.
    - Roles and path prefixes come from the occurrence bitsets: a row is in scope when any of its occurrences is in the bitset.
6. **`when` produces the rule's mask,** a bitset over subject rows.
7. **Evidence** (`actual`, `expectation`, `fix`, `extra`, `affected`, `translationOrigin`, `recovery`) is evaluated only over the mask's rows.
8. **`each`.**
    - The list column expands into an element relation: a row-index vector plus element `ValId`s.
    - `when` and evidence run over that relation, and `item` (or `eachAs`) reads the element column.
    - Emission order is row, then element.
9. **List operators that bind a variable** (`filter`, `map`, `flatMap`, `any`, `all`, `sort*`) run per row over that row's (small) list.
    - This is the only per-row loop, and it uses typed values, not JSON.
    - Per-element scalar work still goes through the distinct-tuple memo.
10. **References.**
    - Rules evaluate in dependency order.
    - `finding(id)` reads the referenced rule's mask.
    - `findingField` reads the referenced rule's emitted evidence for that row.
11. **Parallelism.**
    - Rayon within `RAYON_NUM_THREADS`, over distinct tuples and over row chunks for per-row list operators.
    - The output is deterministic: findings are ordered by rule, then row, then element.
12. **Diagnostics** (the projection below) are a single pass over columns, not per-row JSON.

### Diagnostic projection

Diagnostics are independent of rule selection and retain the existing gating, multiplicity and order.

- **Gating.**
    - Pass 1 runs for every line, keyless and blank-source ones included.
    - Pass 2 runs only for `checkable` lines.
    - Translation-pattern diagnostics are emitted whenever the line is comparable and `latest` is not null, even when it is blank.
- **Multiplicity:** one diagnostic per issue, duplicates kept.
- **Order: two passes per line, as today.**
    - **Pass 1** (`:860-874`) goes over every culture in order: its unknown reasons, then `reduced_source_checking`.
    - **Pass 2** (from `:962`) goes over every culture in order:
        1. `source_unavailable`;
        2. if not comparable: `translation_unavailable` when `latest` is null, then the next culture;
        3. source-pattern issues;
        4. `translation_unavailable`, then the next culture;
        5. translation-pattern issues.
- **Storage:** in the findings layer, in that order per line. `localization-quality-index.ts:826-834` ranks codes by first sighting.
- **Policy diagnostics** (`rule_culture_not_in_target`, `localization-policy.ts:33-43`) stay in TS.

## 6. The findings layer

Published through `Store::publish_global("findings", key, columns, metadata, &BTreeMap::new(), &[])`.

- The last argument (`removed`, `store.rs:1158-1166`) **must be empty**: anything named there is unpublished.
- The metadata records the joined key the layer was built from. A reader serves the layer only when that key equals the pinned joined layer's. Otherwise it reports `stale`, and the host evaluates again.
- It is pinned and compacted like any global layer.

**The key:**

```
digest("findings-v1" ‖ joined key ‖ canonical document hash ‖ overlay hash ‖ evaluator version)
```

- The canonical document is the v4 JSON with rule order kept, insignificant whitespace removed and disabled rules removed.
- Any other format version rebuilds the layer.

**Per rule `r`:**

| Column                 | Contents                                                                                                                  |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| `r{r}.rows`            | The subject row (u32).                                                                                                    |
| `r{r}.cultures`        | The culture index, for `line_culture` and `line`.                                                                         |
| `r{r}.evidence`        | The string ID (domain `findings`) of the emission-ordered JSON `{actual, expectation, fix?, extra?, translationOrigin?}`. |
| `r{r}.places`          | The ID of an interned occurrence-ID list, in relation order (domain `findings.places`).                                   |
| `r{r}.id0`, `r{r}.id1` | The two finding-ID lanes (§7).                                                                                            |

Findings are ordered by row, then emission order.

**Diagnostics:** `diag.rows`, `diag.cultures`, `diag.codes`, in §5's diagnostic projection order.

**Metadata:** the rule list (`id`, `kind`, `label`, `subject`, `family`, `severity`, `role`), counts by rule × culture × severity, and the evaluator version.

## 7. Finding identity (byte-identical to today)

- **`line` and `line_culture`:** `localization-finding:` (`localization-workspace.ts:488-531`).
    - Input: canonical JSON of `[lineId, culture, ruleId, kind, actual, expectation]`, with object keys sorted by code unit, arrays in order, and numbers in JS form.
    - Hash: each UTF-16 code unit through the two 32-bit lanes.
    - Text form: `localization-finding:` plus two 8-digit hex halves.
    - Severity is excluded.
- **`unit_source`:** `quality-finding:` (`quality-query.ts:335`).
    - Input: `JSON.stringify([ruleId, role, textUnitId, kind, actual, expectation, occurrenceIds sorted by code unit])`.
    - Object keys stay in emission order, which must equal today's literal order.
    - Hash: today's 64-bit hash and text form.
- **Tests** pin both against today's TS on a corpus sample, including CJK, astral characters, lone surrogates and whole-number floats.

## 8. Protocol (ADR 0007: additive, contract minor +1)

**`findings_evaluate {rules, collationLocale}`**

- The host sends the canonical v4 JSON inline, as text the engine reads with lone UTF-16 units preserved. The request frame (4 MiB) bounds it.
- The engine builds or reuses the layer for the pinned joined layer.
- It returns `{key, rules, counts, diagnosticCount, collation}`, where `collation` is the locale actually used.

**Culture selection is applied by the TS adapters, never by the engine.** The engine evaluates every culture. The adapters drop findings of every family, diagnostics and changes whose culture isn't the selected one, as `localization-checks.ts:862, 964` do today.

**`findings_lines {key, rows}`**

- `rows` is at most 5,000 line rows.
- Inline response: `{places: [{id, occurrences: [TextQualityAffectedOccurrence…]}], lines: [{row, builtIns: [...], policy: [...], custom: [...], diagnostics: [...]}]}`.
- **Findings** are in exactly today's host shapes (`LocalizationQualityFinding`, `LocalizationPolicyFinding`, `LocalizationCustomFinding`). Each has every base field filled from facts, plus `places` (an ID into `places`) in place of `affectedOccurrences`, and `id`.
- **Order within each list:**
    - `builtIns`: emission order. TS sorts them.
    - `policy`: rule order, then emission.
    - `custom`: the document's custom order, then emission.
- **Large responses.**
    - A response that would exceed 16 MiB inline is written to a scoped file, and the engine returns `{file}` in its place. TS reads that file with `readFile` and `JSON.parse`, and deletes it.
    - So a single line saved in a huge number of places still works. There is no chunk-halving loop.

**`findings_units {key, units}`**

- `units` is at most 5,000 text unit rows.
- Returns `{places, units: [{unit, findings: [...]}]}` in `TextQualityFinding` shape, with each unit's findings in exactly today's emission order (`quality.ts:182-251`):
    1. rule, by ID order as `prepareTextQualityRules` sorts it;
    2. that rule's role-filtered source groups, ordered by source with the host collator, ties keeping first-seen order after role filtering (`quality.ts:83-97`);
    3. term entry;
    4. match.
- Large responses use the same file fallback.

## 9. TypeScript (`@ue-shed/game-text/rules`)

**Schema and types:**

- `RuleDocumentV4`, `Rule`, `Expr`: types generated from the engine's contract.

**Builder:**

- `rule({...})`;
- `expr.field`, `expr.param`, `expr.lit`, `expr.var`;
- one typed function per operator, named as the operator.
- It only constructs JSON.

**Catalogue:**

- `exampleRules`: the v4 catalogue of every Phase 1 built-in, generated from `localizationCheckCatalogue`'s labels, severities, defaults and recovery texts. That keeps one source for them.

**Translation and canonical form:**

- `translateRuleDocument(document | undefined, options?: {checks?, disabledChecks?}): RuleDocumentV4`. It is the only v1–v3 translator. It reproduces `resolveLocalizationChecks` and `enabledLocalizationChecks` (`localization-checks.ts:482-489`), so `options` disable rules in the document, and references see that.
    - Cross-check parameters are copied into each rule:
        - `placeholder_text`'s markers and phrases go into `placeholder_translation`.
        - The v1 terminology rules (role, `caseSensitive`, discouraged terms) go into `placeholder_text`, so it can compute `unreportedMatches` (`localization-checks.ts:406-417, 427-462`). Rules whose role is missing are dropped (`quality.ts:170-171`).
    - v1 term entries are pre-sorted in TS with today's `localeCompare` order (`quality.ts:138-142`).
- `canonicalRuleDocument(document): string`.

**v4 is internal in Phase 1.**

- Documents on disk stay v1–v3, and `decodeGameTextRuleDocumentJson` doesn't accept v4 yet.
- The rule editor (`extensions/game-text/src/game-text-rule-state.ts`) and report versions (`quality-query.ts:54`) are unchanged.
- v4 becomes a public authoring format in Phase 2, together with the defaults change and the editor work. That work isn't Codex's.

## 10. Host adoption in Phase 1

### The workspace quality indexes

`localization-quality-index.ts` and `source-quality-index.ts` keep their structure: blocks, packed facts, the stored-hash assertion, `keep` and the comparators.

**Their check step becomes an engine call.**

- `check(lines)` (`localization-quality-index.ts:738-788`) calls `findings_lines`.
- Today's code still runs the Phase 2 group checks and merges them into `builtIns`.
- Then, as today: sort `builtIns` with `compareLocalizationFindings`, concatenate policy and custom, apply `keep`, and stable-sort with `compareReportedLocalizationFindings`.
- `source-quality-index.ts:318-349` calls `findings_units` the same way.

**Hydration becomes asynchronous.**

- `hydrate` (`localization-quality-index.ts:1008`) and the source index's equivalent return an `Effect`.
- The model methods that call them (page, focus, items, `:1087`) return Effects.
- Their callers in `localization-workspace.ts` and the source-quality workspace code `yield*` them.
- This stays inside `packages/game-text`. The workspace's public results and the renderer are unchanged.

**Change sets keep each host's current collection point.**

- The workspace collects proposals after `keep`, through `matched(request, eligibleAt)` (`localization-workspace.ts:1241`), as today.
- The CLI report collects changes before accepted findings are removed (`localization-checks.ts:1330` before the acceptance filter), as today.

### The CLI

- **`loc check` moves to the engine.** Today it runs the in-memory `checkLocalizationTarget(...)` (`apps/cli/src/workflows/localization-check.ts:132`). In Phase 1 it:
    1. builds or opens the index;
    2. calls `findings_evaluate`;
    3. reads every line through `findings_lines`, in chunks;
    4. runs the Phase 2 group checks in TS;
    5. assembles the same `LocalizationQualityReport` as today, with the same order, diagnostics, `changes` and `acceptedFindings` count.

    Its JSON output must be byte-identical to today's on both canonical fixture corpora. Check that once, as a verification step, not a test:
    - capture `loc check` JSON from the commit before the change, into a scratch folder outside the repository;
    - diff it against the output after the change.

    Don't commit the captured output. Snapshots of today's output aren't kept as an oracle.

- **`loc gate` is unchanged.** It reads states through `selectLocalizationLines` and `search`, not findings (`localization-gate.ts:317`).
- **`checkLocalizationTarget` is deleted** together with the row-check code. The fixture is the oracle for what it tested.
- **Deleted:**
    - `checkLocalizationLine`'s Phase 1 branches;
    - `sourceTextFindings`;
    - `localizationLinePolicyFindings`;
    - `localizationLineCustomFindings`;
    - `textQualityUnitFindings`;
    - the TS helpers only they used.

    Helpers that the Phase 2 checks or the presentation still use stay until those move.

- **No renderer change.**

## 11. Fixture

- `CorpusFinding.fix` and the comparison of fixes are already in place, from the fact repairs.
- Expectations change only where Plan 059 decides.
- **Phase 1 removes the `empty-translation-whitespace` pin.** The right answer is `empty_translation` only: the `whitespace` example rule doesn't report a translation that is an existing empty entry.
- `manifest-notes-filter` and `detail-culture-scope` stay pinned for Phase 3.

## 12. Order of work, one commit per step at least

1. The v4 schema, types, builder, JSON Schema, canonical form, translator and catalogue, with unit tests (TS only).
2. The native relations and fields, the compiler and evaluator, the base functions with their ported tests, the regex dialect with its differential test, and the collator with its pin test.
3. Every Phase 1 rule in the catalogue, matching today's TS per check on the existing check tests.
4. The findings layer, identity and the protocol actions.
5. Host adoption, and deletion of the replaced TS.
6. Parity:
    - both canonical corpora exact;
    - the integration test;
    - one 10,000-line fuzz run;
    - the identity, collation and regex pin tests.
