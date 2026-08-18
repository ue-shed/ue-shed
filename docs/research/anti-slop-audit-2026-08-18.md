# Anti-slop audit — 2026-08-18

## Scope

This audit used David Mulroy's
[`dmmulroy/anti-slop`](https://github.com/dmmulroy/anti-slop) Oxlint plugin on branch
`audit/anti-slop`. The plugin source is vendored at `tools/oxlint/anti-slop`, and
`oxlint.config.ts` enables every available anti-slop rule at error severity.

The audit runs with `oxlint` 1.78.0 and `@oxlint/plugins` 1.78.0. Agent configuration
directories and the vendored plugin implementation are excluded; product, test, fixture, script,
and build-configuration TypeScript and JavaScript remain in scope.

## Baseline

An isolated scan of the branch's pre-audit `HEAD` found 1,923 anti-slop diagnostics across 586
files. The default Oxlint rules also reported three existing diagnostics, which were repaired in
the same pass.

| Rule                                        | Baseline |
| ------------------------------------------- | -------: |
| `no-shape-in-symbol-names`                  |      672 |
| `require-safety-comment-for-type-assertion` |      398 |
| `no-conditional-empty-object-spread`        |      307 |
| `no-unknown-returns`                        |      159 |
| `no-runtime-typeof`                         |      141 |
| `no-unknown-parameters`                     |      117 |
| `no-known-value-widening`                   |       57 |
| `no-unsafe-dictionary-type`                 |       48 |
| `no-chained-type-assertions`                |       22 |
| `no-object-parameters`                      |        2 |
| `no-module-mocking`                         |        0 |
| `no-reflect-apply`                          |        0 |
| `no-reflect-get`                            |        0 |
| `no-unknown-type-aliases`                   |        0 |
| `no-widen-then-assert`                      |        0 |

## Remediation

- Replaced shape-oriented names with domain names while preserving external wire keys where they
  are contractual.
- Replaced unknown input and return surfaces with schemas, generics, discriminated contracts, or
  precise JSON types at boundaries.
- Replaced runtime `typeof` branching and broad dictionary types with schema validation and typed
  domain models.
- Removed chained assertions, known-value widening, and conditional empty-object spreads.
- Narrowed the Workbench preload and IPC boundary to an exact shared contract.
- Added specific `SAFETY:` explanations to the small set of assertions that remain necessary at
  library or platform boundaries.
- Fixed the three default Oxlint findings: two unsafe `finally` flows and one unassigned variable.

No anti-slop rule was disabled or downgraded, and no source-level lint suppression was added.

## Result

The final scan covers 589 files with 111 active Oxlint rules and reports zero diagnostics. The
following repository gates pass:

```text
pnpm exec oxlint --config oxlint.config.ts . --format json
pnpm typecheck
pnpm check
```
