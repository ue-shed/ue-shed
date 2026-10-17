# Effect audit and native index rollout evidence

This records the October 18 implementation and acceptance evidence for the TypeScript Effect/error
audit and production native Game Text builder. Validation is in progress on the implementation
branch; the final gate and measurement results are recorded here before merge.

## Scope

The Effect audit follows Plan 058 D4–D8, D11 and D12. Guidance enforcement now covers all production
packages/apps/extensions. All 88 remaining raw exported decoder exceptions are removed, preserving
schema issues behind unary domain parsers. Tagged-class matching exceptions are removed. Public
documentation is enforced for protocol, Unreal connection and focused Game Text APIs; the eight
reviewed SDKs use named entry points. Obsolete service Shape aliases and two private Game Text
constructors are removed with migration notes.

The native rollout builds on the parser/IO audit in #123 and the C++ error-contract work merged
in #126, and closes the omitted index crate and WASM adapter. It classifies errors by stable codes,
preserves causes and scopes cancellation; this change does not modify C++ plugins. A1/D3 physical
package identity/path brands, graph pin support and other feature-policy roadmap items remain
separate work.

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

## Validation record

- Native index Rust tests: 24 passed, including malformed dictionary count rejection and stable
  error-code/source evidence. Strict native and WASM Clippy checks run with warnings denied.
- Targeted runtime tests: 110 passed, including 32 native lifecycle cycles, Remote Control decode
  recovery, editor foreground/map control and real owned-process fixtures.
- Architecture tests: 24 passed, including named public export/documentation and browser boundary
  checks. A prose `process.` example no longer triggers the code-only browser restriction.
- Further portable, packed-consumer, adoption and dual-engine results are recorded after their
  final runs; passing targeted checks alone does not establish complete acceptance.
