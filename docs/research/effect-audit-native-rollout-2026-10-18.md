# Effect audit and native index rollout evidence

This records the October 18 implementation and acceptance evidence for the TypeScript Effect/error
audit and production native Game Text builder. Full local acceptance passed on `e348532c`;
PR #129 tracks the final hosted CI, review and merge state. Package publication remains separate.

## Scope

The Effect audit follows Plan 058 D4–D8, D11 and D12. Guidance enforcement now covers all production
packages/apps/extensions. All 88 remaining raw exported decoder exceptions are removed, preserving
schema issues behind unary domain parsers. Tagged-class matching exceptions are removed. Public
documentation is enforced across all manifest entry points of the eight reviewed SDKs: protocol,
Unreal connection, localization, Unreal assets, engine, cameras, host and Game Text. They use named
entry points. Obsolete service Shape aliases, four transport internals and two private Game Text
constructors are removed with migration notes. AssetReader test ports are complete and explicit;
the seven hidden "not stubbed" operations and implicit configuration are removed. Direct error
translations, helper adapters and nested stringified causes have regression guards. Tagged errors
without an `Error` suffix are included. Reader and index failures retain their classified codes and
recovery guidance instead of being mislabeled as invalid projects. Portable localization boundaries
retain safe classified causes while excluding private installation paths and authored evidence. Schema-only camera migration
fallbacks translate their final failure to the same domain contract error as strict public parsers.

The native rollout builds on the parser/IO audit in #123 and the C++ error-contract work merged
in #126, and closes the omitted index crate and WASM adapter. It classifies errors by stable codes,
preserves causes and scopes cancellation; this change does not modify C++ plugins. A1/D3 physical
package identity/path brands, graph pin support and other feature-policy roadmap items remain
separate work.

## Audit closure

| Plan item | Integrated result                                                                                                                            | Regression enforcement                                                                        |
| --------- | -------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------- |
| D4–D6     | Guidance on every production tagged error; classified reader/index/transport failures; retained structured causes and cancellation guidance  | Global guidance, tag matching, nested cause and adapter/helper checks; recovery/privacy tests |
| D7        | All 88 remaining raw-decoder exceptions replaced by domain parsers, including composed camera parsers                                        | Empty exception baseline; export-binding fixtures; contract parser tests                      |
| D8        | Complete explicit AssetReader test ports; private implementation constructors; dependency requirements composed through layers               | Type checking of 30 migrated fixture ports; layer/factory architecture checks                 |
| D11, D13  | Named manifest entry points and caller documentation across all eight reviewed SDKs; obsolete aliases and transport internals removed        | Public API guard and fixtures for every reviewed package and focused entry point              |
| D12       | Builds on #107 cleanup, current archived Plans 053/054 and documented engineering decisions; errors and imports follow the final SDK surface | Formatting, lint, type checks, architecture and safety-comment rules                          |
| D14       | Builds on #123 parser/IO and #126 C++ contracts; adds the previously omitted native index and WASM error/cancellation work                   | Stable-code/source tests, malformed input and lifecycle conformance, strict Clippy            |

The TypeScript reference builder remains a supported explicit choice. Publication, A1/D3 physical
identity and graph-pin support are not implied by this audit closure.

## Native integration

`GameTextIndexBuilderLive` derives configuration from the existing AssetReader. Library, CLI,
Workbench and packed-consumer conformance use that production layer. The reference TypeScript
layer is explicitly selectable; failures do not switch writers automatically. Format 4 and scoped
pinned readers remain compatible across builder switches.

Native lifecycle integration covers eight rounds each of startup interruption, suspended staging,
publication interruption and worker termination. Every cycle reopens committed bytes, writes again,
and verifies staging/lock/process cleanup. Native/TypeScript regression comparisons cover Unicode
including unpaired UTF-16, query/facet/focus output, policy identity, stale generations, structural
fallback and compaction. PO provenance changes now retain updated evidence during eligible
incremental joins. Fallback reasons are stable diagnostic codes and structured span attributes.

## Measurement method

The generated seed-57 full-scale dataset contains 166,518 inventory packages, 16,500 text packages,
1,028,205 occurrences, 4,800,000 coverage gaps, 132,606 keys and ten cultures. The 0.1x companion
uses the same generator and policy structure. Neither contains studio project data.

`benchmark-localization-import.ts --mode hosts --builder native|typescript --host cli|workbench`
runs production host services, refresh, builder, model publication and queries over retained
generated reader evidence. This excludes native inventory discovery and package extraction. Each
cold sample owns a fresh cache and process under Node's default heap; repeated samples alternate
backends and serialize heavy work. OS caches are warm and are not artificially flushed.

Workbench samples enable production search/quality workers and latest-search ownership. They run
the production Workbench service in Node, not an Electron renderer or browser interaction recording.
CLI samples retain its ordinary worker configuration. Earlier Workbench runs without those options
are diagnostic evidence and are excluded from final production-configuration timing summaries.

Memory artifacts distinguish sampled process-plus-native-descendant RSS from the benchmark process's
main-thread JavaScript heap/ArrayBuffer samples. Search/quality thread heaps are included in process
RSS, not those main-thread heap counters. Samples are not exact peaks. Stage records include event-loop maximum/p99
delay and utilization. A 10 ms callback-gap probe also records the unfinished gap at operation
completion, covering synchronous stalls that prevent even the first scheduled timer from firing.
A real blocking Atomics.wait regression test verifies that case; timer cleanup occurs in finally.
Warm reopen uses a new process immediately after its matching cold/edit sample, before another
sample can change the shared generated PO's modification time.

Parity requires complete query-result hashes plus 171 canonical joined-data checks. The physical
source accelerator can retain obsolete base entries after incremental updates; its effective active
sources and trigram coverage are checked instead of falsely requiring identical cache bytes.
Two early TypeScript runs failed the old physical comparison and are excluded as completed samples;
the corrected canonical comparison passes without dropping logical data or query assertions.

The saved-fixture pipeline separately uses the public reader/source path for actual package
discovery and extraction. Its first-page hashes are a narrower check than the generated canonical
column proof and are reported separately.

## Measured host results

The [raw samples, machine record and validated summary](evidence/effect-native-2026-10-18/summary.json)
retain all 12 cold/edit samples, four new-process warm reopens and both engine fixture comparisons.
The indexing/benchmark implementation is based on `8631c016`; documentation and unrelated error
adapter fixes were applied between samples, and the complete test-port migration followed all
measurements. No measured indexing/query success path changed during the run. Final integration
checks below cover the resulting source, including those audit fixes.

Three-sample median seconds (warm reopen is one additional new-process sample):

| Host              | Builder    | Cold build | Unchanged refresh | One package + PO edit | Warm reopen |
| ----------------- | ---------- | ---------: | ----------------: | --------------------: | ----------: |
| CLI               | TypeScript |      75.30 |              1.64 |                  5.46 |        2.26 |
| CLI               | Native     |      55.67 |              1.79 |                 22.08 |        3.14 |
| Workbench service | TypeScript |      75.99 |              3.30 |                  6.61 |        3.35 |
| Workbench service | Native     |      56.75 |              4.27 |                 22.77 |        4.26 |

Cold native preparation is about 26% faster on this workload. The edited key mixes authored and
StringTable-reference sources, so native eligibility deliberately chooses `reference-source` full
join fallback; TypeScript performs an incremental join. This edit is slower with native and uses
more sampled process-tree RSS. The structural fallback remains necessary for correct joins;
these results do not claim a universal edit or memory improvement. PO-only eligible incremental
behavior is covered by the dedicated regression suite.

Median sampled cold process-tree RSS is 2,259/2,277 MiB for CLI TypeScript/native and 2,227/2,347 MiB
for Workbench. Edit peaks are 1,387/2,642 MiB and 1,935/2,818 MiB respectively. Missing OS samples for
very short query stages are recorded as null, never as zero memory consumption.

Workbench cold-build maximum callback gaps improve from a 535 ms median to 155 ms. Focus still
materializes synchronously in the JavaScript reader: median gaps are 1.82 seconds for TypeScript
and 2.57 seconds for native. This is an observed remaining responsiveness problem, not evidence of
native query acceleration. CLI native cold/edit publication can also block for roughly 2.2–2.4
seconds even though native joining lowers overall event-loop utilization. Moving construction out
of JavaScript does not remove all host-side publication/materialization work.

All query hashes match within each host across builders, repeats and warm reopens. All six CLI
cold/edit samples pass 171 canonical joined-data checks with zero differences; each reads 16,500
text packages on cold construction. Both CLI warm reopens report no rebuild, zero package reads
and zero parsed localization files. Workbench's public result does not expose those counters, so
its warm evidence is successful new-process reopen/query parity and timing rather than an inferred
zero-read count.

The actual saved-engine pipeline reads 65 text packages and seven localization files, returning
143 lines. Median ready times are 3.139/3.182 seconds (UE 5.7, TypeScript/native) and 3.103/3.168
seconds (UE 5.8). Each engine's six alternating samples has one identical first-page hash. On this
small fixture there is no end-to-end native speedup; IO/discovery and fixed overhead dominate.

## Final integration checks

[Validation record](evidence/effect-native-2026-10-18/validation.json) retains the exact source,
engine builds, result counts and local log hashes.

- Full `pnpm check`: passed on `e348532c`, including 397 runtime test files and 2953 tests.
  Capability-gated integrations remain explicit: 16 files and 55 tests skipped; a missing live
  editor/render/Perforce environment is not counted as a conformance pass.
- Game Text responsiveness: all three dedicated tests passed. These bounded regression tests do
  not waive the million-occurrence focus/publication stalls measured above.
- Native index: 24 Rust tests passed; native and WASM Clippy deny warnings and production unwrap/expect.
  Real process conformance verifies malformed join failures retain JSON line/column details with
  stable `invalid_input` classification and unsafe-replay guidance.
- Architecture: 65 tests passed; release checks: 50 passed. The guarded Changesets dry run resolves
  the 20 public packages to 0.17.0 without versioning or publication. All eight SDK public documentation
  guards, zero raw-decoder exceptions, complete test ports, classified causes and privacy regressions
  are covered by the final gate.
- Packed packages: 20 tarballs passed clean offline consumer conformance, including production
  native indexing. Data Authoring source-copy adoption passed independently of repository modules.
- UE 5.7 (5.7.4): passed. UE 5.8 (5.8.3): passed. The retained-fixture matrix performs fresh Unreal
  reflection verification and source/codegen, native/WASM and saved-review comparisons. It does not
  regenerate saved assets or legacy fixtures; no C++ plugin implementation changed in this PR.

The measured slower mixed-reference edit and synchronous reader materialization remain explicit
performance limits. Neither is hidden by fallback to a different writer, by dropped parity checks or
by a native query-speed claim.
