# Localization evidence read performance (2026-10-09)

Phase 4 of [Plan 056](../../plans/056-localization-at-real-project-scale.md), measured on
Windows with an AMD Ryzen 9 5950X and Node 24.21.0. All inputs are generated; no real-project
content or paths are included.

The target has 132,606 entries, ten cultures, a 67,919,820-byte UTF-8 PO, a
121,469,836-byte UTF-16LE archive and a 94,196,212-byte UTF-16LE manifest. PO entries include
`msgctxt`, multiline `msgid` continuations, key/reference comments, CRLF, a BOM and U+2028.
The ten cultures use copies of the generated files. Translation strings are not interned across
cultures; matching PO/archive translations share storage only within the same culture.

| Measurement                                     |    Before |     After |
| ----------------------------------------------- | --------: | --------: |
| `parsePO` with CPU profiling                    |   7.080 s |   1.880 s |
| `parseArchive` with CPU profiling               |   2.138 s |   0.984 s |
| `parseManifest` with CPU profiling              |   1.849 s |   0.909 s |
| Node `LocalizationEvidence.read`, ten cultures  | 169.533 s |  58.044 s |
| Heap after evidence read and explicit GC        | 4,169 MiB | 1,121 MiB |
| Additional retained heap above runtime baseline | 4,139 MiB | 1,091 MiB |

Before and after use identical generated files and fresh processes on the same machine.
The baseline evidence process needed `--max-old-space-size=12288`; the final measurement uses
Node's default heap. These are individual measurements, not statistical benchmarks. Evidence
wall time excludes the final explicit GC. Heap is retained heap, not peak RSS or a full asset-scan
measurement. An intermediate compact PO projection alone retained 3,028 MiB; sharing source
context and empty arrays reduced that to 1,525 MiB, before sharing matching translations within
each culture reduced it to 1,121 MiB.

CPU profiles attribute about 42% of PO parse samples to schema validation, 26% to freezing
(including schema predicates) and 11% to GC. Archive/manifest samples attribute about 37–39% to
schema validation, 25–27% to the character-by-character nesting scan, 9% to freezing and 8% to GC.
Attribution groups are inclusive and mutually exclusive; GC also includes the explicit GC outside
the timed parse. The profiles therefore explain the costs rather than exactly partition wall time.

PO parsing now constructs lines, fields, entries and the document directly from syntax-checked
captures. Options, encoding, duplicate fields, required fields, safe plural indices, limits and
identity parsing remain checked. JSON readers retain the full `decodeJson` structural boundary
and depth checks, brand keys there, and omit the second domain-document validation. Nesting uses
an indexed loop; freezing and depth traversal use the object predicate directly instead of
constructing schema predicates repeatedly. Original parser tests, including byte-exact
serialization, remain unchanged.

`LocalizationTargetEvidence` now keeps PO format/source flags and complete decoded entries,
including every comment, flag, plural value and identity. It omits raw lines, endings, field offsets,
headers and trivia. Projection copies strings to release the decoded file's backing string, shares
empty comment arrays, interns repeated source context within one read, and shares source objects
only when their complete JSON content matches. Equal text with differing metadata stays distinct.

Consumer audit:

| Consumer                                              | Required evidence                                                                             |
| ----------------------------------------------------- | --------------------------------------------------------------------------------------------- |
| Game Text join                                        | Entry identity, source/plurals, translations and source-format flag                           |
| Focus page PO context                                 | Decoded comments and flags carried by the join's `POEntry`                                    |
| Checks, reports, edit staging, CLI and Workbench main | Join output, compact entries and file provenance                                              |
| Change-set review and review fingerprints             | Entry identity/source/translation and provenance                                              |
| PO writer                                             | Full `PODocument`, independently of target evidence                                           |
| Change-set apply                                      | Now rereads only each PO being edited, checks its reviewed hash, and parses the full document |

The write port still checks the hash again at atomic replacement. A regression test changes the
file between evidence review and the full-document reread and verifies that it remains untouched.
A pure 50,000-entry PO/archive test has a ten-second combined parsing budget and a twenty-second
test timeout. Tests also cover projection fidelity, culture-specific translations, pending edits
and differing source metadata.

Reproduce after building localization:

```powershell
pnpm --filter @ue-shed/localization run build
node --expose-gc scripts/profile-localization.ts generate
node --expose-gc --cpu-prof --cpu-prof-name=po.cpuprofile --cpu-prof-dir=out/localization-profile scripts/profile-localization.ts po
node --expose-gc --cpu-prof --cpu-prof-name=archive.cpuprofile --cpu-prof-dir=out/localization-profile scripts/profile-localization.ts archive
node --expose-gc --cpu-prof --cpu-prof-name=manifest.cpuprofile --cpu-prof-dir=out/localization-profile scripts/profile-localization.ts manifest
node --expose-gc scripts/profile-localization.ts evidence
```

Generated files, profiles and verification logs stay under ignored `out/localization-profile`.
The generator and profiler are scripts, outside the published package.

Verification (final runs; counts are tests unless otherwise indicated):

| Command                                                                                                                              | Result                           |                                         Passed |           Failed | Skipped |
| ------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------- | ---------------------------------------------: | ---------------: | ------: |
| `pnpm --filter @ue-shed/localization run build`                                                                                      | Pass                             |                                        1 build |                0 |       0 |
| `pnpm --filter @ue-shed/game-text run build`                                                                                         | Pass                             |                                        1 build |                0 |       0 |
| `pnpm exec vitest run packages/localization packages/game-text`                                                                      | Pass                             |                                            298 |                0 |       4 |
| `pnpm exec vitest run apps/cli/src` with the release native reader                                                                   | Pass                             |                                             76 |                0 |       0 |
| `pnpm exec vitest run extensions/game-text apps/workbench/src/main`                                                                  | Pass                             |                                            339 |                0 |       0 |
| Node 26.5.0: `node node_modules/vitest/vitest.mjs run packages/localization packages/game-text apps/cli/src` with the release reader | Pass                             |                                            378 |                0 |       0 |
| `pnpm test` with the release native reader                                                                                           | Pass                             |                                          2,028 |                0 |      50 |
| `pnpm run check:precommit`                                                                                                           | Pass                             |      43 architecture tests; other checks clean |                0 |       0 |
| `pnpm test:uasset-engine-matrix`                                                                                                     | Fails on optional UE 5.3         |                                 3 engine lanes |    1 engine lane |       0 |
| `pnpm check`                                                                                                                         | Fails at Data Authoring adoption | 351 Rust and 85 Node tests; 20 packed packages | 1 adoption build |  4 Rust |

`pnpm exec oxfmt` passed on all 24 changed files (zero failures). All four profiling modes passed,
including all 21 evidence files. `pnpm test:localization-processes` passed both engine lanes
(UE 5.7 and UE 5.8; zero failures or skips).

Both builds succeeded. All original parser tests pass unchanged. The package-only run skips
native-reader suites without an explicit executable; the Node 26 run covers them. The complete
Vitest suite prints each environment-gated Unreal/Perforce skip. Formatting was applied with
`pnpm exec oxfmt` to every changed file. Profiling commands above completed before and after,
with all 21 evidence files read successfully.

UE 5.7 and UE 5.8 each passed source generation, fixture generation, localization byte/oracle
checks and native/WASM conformance in the engine matrix. Its optional UE 4.27 lane also passed;
UE 5.3 failed in unmodified engine headers because the installed compiler is too new
(`__has_feature` errors in `ConcurrentLinearAllocator.h`). The full portable gate reached and
passed packed-package conformance, then failed because the unmodified Data Authoring adoption
materializer omits `editor-foreground-responsiveness.ts` while the copied protocol barrel exports
it. Consequently this change is not fully verified against `pnpm check`.

The separate localization process lane passed on both UE 5.7 and UE 5.8, including plans,
supported commandlet operations, audit, process-tree cancellation, review state, PO writes through
`loc apply`, import/compile sync, and carrying a key across a gather. Both lanes use disposable
generated fixture projects.

Earlier overlapping verification runs encountered transient missing build outputs; the affected
CLI and Node 26 runs were repeated sequentially and passed. Intermediate formatting, lint and type
errors in the new files were fixed before the passing pre-commit gate.

Real-project CLI wall time/peak heap and real-project Workbench behavior remain unmeasured: no
real project was supplied for this task. Hosted CI is outside this working-tree implementation.

Changed files:

- Parsers and evidence: `packages/localization/src/{po,json-formats,decode,schema,service,evidence-projection}.ts`.
- Review and writing: `packages/localization/src/{change-set-apply,change-set-review,review-file}.ts`.
- Tests: `packages/localization/src/{scale,po-evidence,evidence-projection}.test.ts`,
  `packages/localization/src/{service,change-set-apply}.integration.test.ts`.
- Game Text consumers: `packages/game-text/src/{localization,localization.test-support}.ts`,
  `apps/workbench/src/main/services/game-text-localization.test-support.ts`,
  `scripts/test-localization-processes.ts`.
- Measurement: `scripts/{profile-localization,localization-scale-data}.ts`.
- Docs/release: `packages/localization/README.md`, this report,
  `plans/056-localization-at-real-project-scale.md`, `.changeset/quick-localization-evidence.md`.
