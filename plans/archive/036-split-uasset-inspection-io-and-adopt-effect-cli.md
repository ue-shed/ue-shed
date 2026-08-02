# Plan 036: Split UAsset inspection and IO, and adopt Effect CLI

> Executor instruction: read this whole plan before editing. Re-run Phase 0 drift checks and preserve
> all unrelated work in every checkout.

## Status

- State: DONE — portable, packed-consumer, release, benchmark, and UE 5.7 evidence passed
- Priority: P1
- Effort: XL
- Risk: HIGH
- Category: architecture migration
- Depends on:
    - ADR 0004
    - archived Plans 022 and 025
    - explicit Plan 033 handoff for every overlapping behavior or file

## Outcome

Replace the accidental two-part design—TypeScript orchestration around a broad Rust parser
package—with four explicit responsibilities:

1. uasset-parser: bounded package bytes to parsed Unreal package structures.
2. uasset-inspection: parsed structures to generic inspection, authoring, text, texture, and
   saved-world results.
3. uasset-io: filesystem access, project discovery, signatures, cache participation, bounded
   concurrency, and project-scale execution.
4. uasset: a thin Rust executable over uasset-inspection and uasset-io.

The public JavaScript CLI stays the product CLI and migrates from its hand-written parser to
Effect CLI. JavaScript and Rust do not duplicate command trees; they synchronize through one
versioned, language-neutral uasset-io request/event protocol used by @ue-shed/unreal-assets.

This plan preserves existing public behavior while changing ownership. It does not authorize
renaming commands, altering default scan behavior, or putting product policy into Rust.

Plan completion now also gates publication of the portable inspection binding. The first public
WASM surface is an npm package named `@ue-shed/uasset-inspection-wasm`; it accepts host-supplied
package bytes and exposes the existing generic inspection plus compact text/texture projections. It
does not expose filesystem discovery, project scans, catalog caching, native concurrency, or the
complete `@ue-shed/unreal-assets` service. Protected publication must not begin until this plan is
DONE and its release evidence is attached to the exact candidate.

## Plan 033 handoff

Recorded 2026-07-30 from the user's authorization to begin this work:

- Plan 036 owns the structural migration: crate extraction, the generic request/event protocol,
  the shared native-process adapter, Effect CLI migration, and build/release ownership changes.
- Plan 033 retains semantic ownership of compact text/texture extraction, its fixture coverage,
  comparative benchmarks, and the persistence decision. This plan must preserve those contracts
  while relocating their implementation.
- Neither plan may add a second project enumeration, make an empty candidate list scan Content, or
  replace compact extraction with generic full-inspection transport.
- Any change to text/texture result semantics, coverage accounting, benchmark budgets, or
  persistence remains a Plan 033 decision and requires its explicit review.

## Phase 0 inventory

The frozen implementation surface at the start of this plan is:

| Area              | Current implementation                                                                                                                                                                                       | Migration constraint                                                                    |
| ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------- |
| Native executable | crates/uasset-parser/src/bin/uasset.rs contains inspect, authoring, scan, saved-world, text/texture projection output, path-list transport, cache, discovery, concurrency, progress, help, and exit handling | Preserve commands and legacy exits while removing non-parser implementation             |
| Portable Rust     | crates/uasset-parser/src/projection.rs and saved_world.rs already hold portable projection logic                                                                                                             | Preserve Plan 033 semantic fixtures and restore WASM reuse through a library dependency |
| WASM              | crates/uasset-parser-wasm/src/lib.rs includes executable source for generic inspection                                                                                                                       | Remove the source inclusion without changing byte-to-inspection semantics               |
| TypeScript reader | packages/unreal-assets/src/index.ts has inspect/authoring execFile and separate saved-world, scan, and extraction spawn/NDJSON paths                                                                         | Replace only after real-process parity and cancellation tests exist                     |
| Public CLI        | apps/cli/src/command.ts manually parses command tokens; application.ts dispatches the tagged union                                                                                                           | Preserve command variants, options, help, JSON arguments, and usage exit 2              |
| Delivery tooling  | workspace, native-tools, packaging, WASM, benchmark, conformance, and release scripts build uasset-parser as the executable owner                                                                            | Update together with the binary move; retain public launcher package names              |

Current output contracts to preserve during the migration are generic inspection/scan schema 8,
compact text/texture event schema 1, and the Effect-owned saved-world contract. Existing native
exit codes are 0, 2, 3, 4, 5, 6, 7, and 64; the protocol command will not reinterpret those human
command exits.

## Why this exists

The current ownership split has stopped being honest:

- crates/uasset-parser/src/bin/uasset.rs is about 4,700 lines and owns parsing, inspection,
  traversal, filtering, concurrency, output, cache-related behavior, and CLI concerns.
- packages/unreal-assets/src/index.ts is about 2,200 lines and owns public schemas, Rust process
  invocation, progress parsing, exit-code interpretation, and higher-level orchestration.
- apps/cli/src/cli.ts is about 930 lines of hand-written argument and help behavior before the
  planned command surface is complete.
- the WASM package source-includes the Rust binary module to reuse inspection logic.
- build, packaging, benchmark, and release scripts assume the executable belongs to the parser crate.

The repeated response to a slow JavaScript loop has been to move that one loop to Rust. This plan
instead makes the ownership rule clear: parser and inspection interpret data; IO owns machine and
project work; Effect services and the public CLI own product workflow and presentation.

## Fixed decisions

- Use the plain names parser, inspection, and IO. Do not introduce abstract collection or
  proof-oriented module names.
- The Effect CLI is the public product CLI. Rust human commands are diagnostic and compatibility
  tools, not a peer product CLI.
- Complete the parser/inspection/IO split, protocol adapter, parity tests, and baseline benchmarks
  before migrating `apps/cli` to Effect CLI. Those prerequisites are complete; the declarative
  parser has landed, while direct Effect workflows and compatibility-adapter removal remain.
- Do not mirror commands between the TypeScript CLI and Rust.
- Synchronize languages through a versioned request/event protocol.
- Use explicit discriminated operation and event unions in version 1. Do not add dynamic operation
  registries, plugin registries, or generic payload escape hatches.
- Pure transformations remain ordinary functions. Effect owns workflows, resources, typed failures,
  concurrency, configuration, and telemetry.
- Parser and inspection stay portable and WASM-compatible.
- The first public WASM package preserves generic inspection schema 8 and compact projection schema
  version 1. A columnar table-read boundary requires a separate measured contract decision and is
  not a prerequisite for this release.
- Keep `crates/uasset-inspection-wasm` private to Cargo publication. The npm package is the supported
  distribution boundary; crates.io publication requires a separate consumer need and release plan.
- Filesystem traversal, caches, native concurrency, and project scheduling never leak into parser
  or inspection.
- Keep the public AssetReader API while replacing its internal transport.
- Preserve existing CLI syntax, machine output, and usage-exit behavior during the CLI migration.
- Version 1 uses one scoped process per operation. A persistent worker requires measured evidence and
  a later design.

## Target dependency shape

    apps/cli
      -> Effect command handlers and product services
      -> @ue-shed/unreal-assets
      -> uasset-io request/event protocol
      -> uasset executable
      -> uasset-io
      -> uasset-inspection
      -> uasset-parser

    @ue-shed/uasset-inspection-wasm npm assembly/wrapper
      -> generated browser and Node bindings
      -> uasset-inspection-wasm
      -> uasset-inspection
      -> uasset-parser

Nothing in parser or inspection may depend on Node, Workbench, a product command, filesystem roots,
or studio conventions.

## Target layout

    crates/
      uasset-parser/
        src/lib.rs
      uasset-inspection/
        src/lib.rs
      uasset-io/
        src/lib.rs
        src/bin/uasset.rs
      uasset-inspection-wasm/
        src/lib.rs

    packages/
      protocol/contracts/uasset-io/v1/
      uasset-inspection-wasm/
      unreal-assets/

    apps/cli/

Rename the existing uasset-parser-wasm package to uasset-inspection-wasm. The WASM package must use
normal library dependencies; it must not include executable source.

`packages/uasset-inspection-wasm` owns npm metadata, JavaScript-side preflight limits, browser and
Node loading, generated-artifact assembly, public documentation, and release integration. It does
not duplicate parser or projection behavior. `publish = false` on the Rust crate and its exclusion
from the root Cargo workspace do not block npm publication and must not be changed merely to make an
npm tarball.

### uasset-parser

Owns bounded byte readers, Unreal package decoding, summaries, names, imports, exports, properties,
parser limits, and parse diagnostics. It has byte-oriented inputs and has no path-reading
convenience API.

It does not own paths, discovery, project configuration, caches, threads, CLI parsing, output
projection, or product workflows.

### uasset-inspection

Owns generic projections of parsed packages: inspection, authoring, text, texture, saved-world,
header/full inspection modes, deterministic projection logic, and inspection-specific typed
failures.

It accepts parsed package values, bounded byte inputs when parsing is part of one operation, and
explicit supplemental inputs such as companion bulk data. Limits are values, not ambient state.

It does not open files, traverse folders, choose caches, own a thread pool, emit process output, or
know product workflow and UI concepts.

### uasset-io

Owns project and path discovery; bounded package and companion reads; package signatures and
cache-key material; cache participation; stable path ordinals; bounded concurrency and backpressure;
cancellation checkpoints; typed IO request execution; and conversion of progress/results into
protocol events.

Its library API is typed Rust. NDJSON serialization is an executable adapter concern.

### uasset executable

Owns human compatibility/diagnostic commands, the protocol transport command, stdin/stdout/stderr
setup, translation to IO requests, human/protocol output adaptation, and documented exit behavior.

It must not regain traversal, decoding, inspection, cache, or scheduler logic.

## Version 1 request/event protocol

### Authority

Add the language-neutral contract here:

    packages/protocol/contracts/uasset-io/v1/
      README.md
      request.schema.json
      event.schema.json
      fixtures/
        valid/
        invalid/

JSON Schema and shared fixtures are the cross-language authority. @ue-shed/protocol provides Effect
schemas and inferred types that conform to that contract. Rust uses serde types and passes the same
fixtures. Neither TypeScript declarations, Rust structs, nor generated help are independent sources
of truth.

### Transport

The uasset protocol command:

- reads exactly one bounded JSON request from stdin;
- writes newline-delimited JSON events to stdout;
- uses stderr only when it cannot speak the protocol;
- exits after exactly one terminal event;
- is cancelled by terminating the scoped child process.

Version 1 excludes a persistent worker, multiplexed requests, and explicit cancel frames.

### Request

Every request has:

- contract: exact contract identifier;
- version: 1;
- requestId: opaque caller-provided identifier;
- operation: a discriminated value;
- explicit operation resource limits.

Initial operations must cover every current AssetReader behavior:

- inspect one or more explicit packages;
- authoring inspection;
- header scan over explicit paths or explicit project root;
- full scan over explicit paths or explicit project root;
- text extraction;
- texture extraction;
- saved-world inspection.

Use the existing public domain vocabulary for the exact operation names. Do not define one
operation per public CLI command.

Large path lists travel over stdin. An explicit empty path list performs zero work; it never falls
back to scanning a root.

### Events

Every event has contract, version, requestId, strictly increasing sequence, and a discriminated kind.
Version 1 includes:

- accepted;
- progress;
- typed operation results;
- inventory/summary results when already supported;
- structured diagnostic;
- completed;
- failed;
- rejected.

No event contains an untyped map or a field that callers must parse as human text for control flow.

### Stream and exit invariants

Conformance tests prove:

- accepted is first for valid supported requests;
- requestId and version never change inside a stream;
- sequence starts at its documented value and strictly increases;
- stable ordinals/final output are unchanged by concurrency level;
- work in flight stays bounded;
- exactly one terminal event occurs and it is last;
- no late event is emitted after cancellation completes;
- partial per-file results remain typed values;
- invalid envelopes are rejected before file work begins.

For uasset protocol, exit 0 after every valid terminal event—including typed expected failures or
partial results. Use non-zero only when the executable cannot establish or complete the protocol,
such as bad framing, failed stdout, panic, or startup failure. Existing human Rust commands retain
their current exit behavior until separately deprecated.

### Compatibility

- Additive optional fields and new variants require contract review and fixtures.
- Unsupported versions are rejected before work starts.
- Breaking semantics or fields create v2; they do not reinterpret v1.
- Keep versions required by supported public packages.
- Release notes identify bundled protocol versions and binary compatibility.

## TypeScript integration

Keep the public AssetReader interface. Inside @ue-shed/unreal-assets, replace command-specific
spawn loops and stderr parsing with one internal streaming process adapter:

    run(request: UAssetIoRequest)
      -> Stream<UAssetIoEvent, UAssetTransportError | UAssetContractError, UAssetProcess>

Use the installed Effect v4 APIs. The adapter acquires/releases a child process; writes the bounded
request; incrementally decodes stdout; validates every event at the process seam; terminates the
child on interruption; emits structured spans and metrics; and maps protocol results back to current
AssetReader values.

Do not expose a new generic protocol service as public product API solely because this adapter is
generic.

## Effect CLI

Use:

- effect/unstable/cli from effect 4.0.0-beta.98;
- matching @effect/platform-node 4.0.0-beta.98;
- workspace catalog entries to prevent version drift.

Do not install Effect v3 @effect/cli or a mismatched stable platform package.

Target source shape:

    apps/cli/src/
      main.ts
      cli/
        command.ts
        runtime.ts
        errors.ts
        output.ts
        commands/

Build the Effect command tree and typed options first. Initially, leaf handlers may adapt the
existing CliCommand/executeCommand behavior. Then move them to direct Effect services and delete
the manual token parser, help assembly, and monolithic dispatcher only after compatibility tests
pass.

Preserve command names, aliases, flags, defaults, repeated flags, flexible flag placement, --
behavior, JSON arguments, machine output, Git Bash leading-slash handling, and exit 2 for usage
errors. Keep stdout results and stderr diagnostics/progress consistent with the existing public
contract. No Rust command is added merely because a TypeScript command exists.

## Execution

### Phase 0 — Reconcile ownership and freeze behavior

- [x] Read Plan 033 fully and list overlapping files, schemas, commands, benchmarks, and contracts.
- [x] Obtain and record an explicit handoff for every overlap in both plans.
- [x] Inspect the dirty state of every relevant worktree; preserve user-owned changes.
- [x] Inventory AssetReader methods and all native commands they currently invoke.
- [x] Inventory public CLI commands, aliases, options, defaults, output, and exit behavior.
- [x] Inventory build/release/benchmark references to uasset-parser, uasset binary paths, and
      uasset-parser-wasm.
- [x] Capture command/native process golden tests before migration.
- [x] Record baseline timing for startup + one package, explicit-path batch, header/full scans,
      text/texture extraction, saved-world inspection, and CLI startup/help.

Record package count, byte count, cache state, concurrency, machine, and command for every baseline.

Gate: no code move begins while Plan 033 ownership is ambiguous. Existing behavior is frozen in
goldens, including awkward but public behavior.

### Phase 1 — ADR, docs, and protocol schema

- [x] Add an ADR for parser/inspection/IO/product ownership and dependency direction.
- [x] Update architecture docs and the documentation map.
- [x] Add request/event JSON Schemas plus valid and invalid fixtures.
- [x] Add Effect schemas/inferred types in @ue-shed/protocol.
- [x] Add Rust serde types and shared-fixture conformance.
- [x] Route unreal-assets schema decoders and public types through @ue-shed/protocol.
- [x] Add bidirectional TypeScript/Rust contract compatibility tests.

The shared fixture suite covers request, lifecycle, and every typed result frame in both languages.
The JSON Schemas and fixtures remain authoritative; TypeScript uses Effect decoders and Rust uses
explicit serde enums and structs without an opaque result field.

Invalid fixtures cover missing discriminants, wrong versions, invalid limits, malformed paths,
conflicting root/path selection, and illegal terminal sequences.

Gate: both languages accept valid fixtures and reject invalid fixtures; no protocol field is opaque.

### Phase 2 — Extract inspection and fix WASM ownership

- [x] Create crates/uasset-inspection.
- [x] Move generic projections from the executable into inspection modules without behavior change.
- [x] Keep parsing/data structures in uasset-parser.
- [x] Replace executable-source inclusion in WASM with a normal library dependency.
- [x] Rename to uasset-inspection-wasm and update workspace metadata, tests, and scripts.
- [x] Add architecture checks forbidding filesystem/process/cache dependencies in parser/inspection.
- [x] Keep unit/fixture coverage at the cheapest truthful layer.

Extraction order:

1. Shared result types.
2. Header and generic inspection.
3. Authoring projection.
4. Saved-world projection.
5. Text extraction.
6. Texture extraction.
7. WASM adapter.

Gate: parser and inspection compile for supported WASM; no executable source inclusion remains;
frozen native fixtures preserve schema-equivalent output.

### Phase 3 — Extract IO and thin executable

- [x] Create crates/uasset-io with library plus uasset binary target.
- [x] Move discovery/root handling, file/companion reads, signatures, cache participation,
      concurrency, stable ordinals, and collection into IO.
- [x] Express supported work as typed IO requests.
- [x] Expose typed generic inspection values for native executors instead of decoding their JSON
      projection back into Rust structs.
- [x] Adapt human Rust commands to call the same typed direct executors; `legacy.rs` is now only a
      CLI parsing and presentation adapter.
- [x] Remove the binary target from uasset-parser.
- [x] Add source/dependency checks that keep the executable thin.

Gate: no filesystem, cache, thread-pool, or process-output work remains in parser/inspection;
concurrency cannot change order; explicit empty paths do zero work; human command behavior remains
compatible.

### Phase 4 — Implement protocol executable mode

- [x] Decode one bounded request from stdin.
- [x] Reject unsupported versions before any file operation.
- [x] Execute only through uasset-io.
- [x] Emit validated NDJSON with stable sequences and exactly one terminal event.
- [x] Keep stdout protocol-only.
- [x] Route every protocol operation through a typed direct executor, including filtered/header
      scans, cache, inventory, authoring, compact projections, and saved-world inspection.
- [x] Add cancellation checkpoints at discovery, read, parsing, inspection, and event emission.
- [x] Add process tests for malformed input, early consumer close, output limits, interruption,
      partial per-file failures, path/resource limits, cache/filter/inventory behavior, and
      saved-world ordering.
- [x] Fuzz/property-test framing and event-sequence validation.

Gate: consumers never parse stderr or magic exit codes for expected outcomes; interruption leaves no
child work running; output stays bounded by configured limits/downstream demand.

### Phase 5 — Switch unreal-assets to the protocol adapter

- [x] Add one scoped Effect process service.
- [x] Stream-decode and validate protocol events.
- [x] Replace stderr progress parsing with typed progress events.
- [x] Replace expected-failure exit-code branching with terminal events.
- [x] Map events to current AssetReader returns.
- [x] Migrate one operation at a time under parity tests.
- [x] Delete superseded spawn loops/argument chunking after all operations migrate.
- [x] Add spans/metrics for queue time, startup, discovery, read bytes, inspected files, cache
      outcome, partial failures, cancellation, and terminal state.

Order: single-package inspect; explicit batch; header/full scan; saved world; text; texture;
authoring.

Gate: AssetReader behavior stays compatible; malformed output is a typed contract failure;
interruption terminates native work; production TypeScript parses no native stderr.

### Phase 6 — Move apps/cli to Effect CLI

- [x] Add matching Node platform package through the workspace catalog.
- [x] Add runtime layer, output service, and typed top-level error rendering.
- [x] Recreate current command tree, options, arguments, aliases, and help with Effect CLI.
- [x] Route initial leaves through compatibility adapters.
- [x] Convert leaves to Effect workflows/layers.
- [x] Add command/external-operation spans and scoped signal handling.
- [x] Delete manual parser/help/dispatcher once goldens and integration tests pass.
- [x] Split the former monolith into command modules without circular dependencies.

Completion note: the declarative Effect CLI tree owns token parsing, typed flags, generated help,
usage failures, direct Effect workflows, observability, and scoped signal handling. The former
monolithic compatibility dispatcher has been removed and the command/workflow module graph is
acyclic. Generated help/error wording and machine output remain covered by compatibility tests.

Gate: frozen command compatibility passes; text-only help changes receive explicit review;
machine-readable output is unchanged unless versioned; Rust command mirroring is not introduced.

### Phase 7 — Build, package, install, release

- [x] Replace cargo build -p uasset-parser assumptions with the IO/binary package.
- [x] Update root scripts, native-tools, package assembly, benchmarks, and release checks.
- [x] Retain @ue-shed/uasset and supported platform package names unless a separate release
      decision changes them.
- [x] Freeze the public WASM contract as bytes-in generic inspection schema 8 plus compact
      text/texture projection schema 1, with explicit partial, unsupported, malformed, and resource
      limit results. Record discovery, scans, caches, and columnar table values as unsupported or
      deferred rather than implied package behavior.
- [x] Add `packages/uasset-inspection-wasm` as the npm assembly/wrapper package. Keep the Rust crate
      private to Cargo publication and use the scoped npm name in all manifests and documentation.
- [x] Produce package-local browser and Node release outputs from the same locked Rust source. Pin or
      record Rust, `wasm-pack`, `wasm-bindgen`, and optimizer identities; reject generated manifests
      containing local paths, workspace protocols, or unpromised files.
- [x] Enforce a default maximum input size in JavaScript before `wasm-bindgen` copies bytes into
      linear memory. Carry explicit parser/projection limits through Rust so excessive exports,
      nesting, allocation, or serialized output cannot become an unbounded browser operation.
- [x] Extend structural native/WASM parity across minimal and large DataTables, Enhanced Input,
      Texture Audit, Game Text, one representative level, deliberately unsupported input, malformed
      packages, nesting/count limits, and oversized input. Keep Unreal-produced fixtures as the
      semantic authority.
- [x] Add a real browser smoke test and a Node smoke test for initialization, inspection, typed
      failures, and repeated calls. Add `pnpm test:uasset-wasm:browser` as the portable browser lane;
      keep `pnpm test:uasset-wasm` as native/WASM semantic parity.
- [x] Pack the npm tarball and install it in a clean consumer with no repository or `target` fallback.
      Verify exports, declarations, `.wasm` loading, package contents, schema versions, and checksums.
- [x] Add `@ue-shed/uasset-inspection-wasm` to the exact public package graph, candidate dry-run and
      protected-publish lists, license inventory, checksums, candidate manifest, and provenance
      attestation. Because npm cannot configure trusted publishing for a package that does not yet
      exist, permit exactly one bootstrap publication from the protected GitHub environment with
      human approval, a narrowly scoped short-lived token, the exact attested candidate, and
      `--provenance --access public`. Immediately revoke the token, configure the package's trusted
      publisher, and require OIDC with token authentication rejected for every subsequent release.
- [x] Publish inspection/projection compatibility and supported runtime metadata in release evidence.
      Correct stale schema-v7 WASM documentation to schema 8.
- [x] Bind the publishable candidate to a successful Trusted Unreal parser-conformance run. A
      portable dry run may omit that evidence; an actual publication may not.

Gate: no live script assumes parser owns the executable; the native packages and WASM package work
from clean packed consumers; browser and Node runtimes produce schema-equivalent evidence; limits
are enforced before and during decode; and candidate provenance covers every generated JS, type, and
WASM artifact. Actual npm publication begins only after Plan 036 is DONE, from an exact protected
tag with human approval. The bootstrap exception exists only to create the npm package so its trusted
publisher can be configured; it is not a reusable token-publishing path.

### Phase 8 — Measure both current CLI surfaces

- [x] Re-run all Phase 0 benchmarks on the same fixture set and machine for the existing
      TypeScript/public CLI path and the Rust human/diagnostic CLI path.
- [x] Separate startup, discovery, reads, parsing, inspection, serialization, and TypeScript mapping
      where measurable.
- [x] Compare cold/warm cache and concurrency levels while checking stable output.
- [x] Measure startup/help and memory high-water marks for both CLI paths.
- [x] Compare output parity, failure behavior, and cancellation behavior between both CLI paths.
- [x] Add regression thresholds only for stable reproducible measurements.

Results decide follow-up work:

- Material per-request startup cost may justify a separately designed persistent worker.
- Dominant serialization may justify a versioned transport improvement, never unvalidated output.
- A measured generic/project-neutral JavaScript loop may move to IO.
- An Effect CLI startup regression must be profiled before changing frameworks.

Gate: representative workloads remain within an accepted budget, with reproducible commands and
fixture descriptions.

No timing threshold was added: the current committed corpus is suitable for repeatable comparative
evidence but not yet stable and representative enough for a non-flaky release threshold. The
recorded closure run covers concurrency 1/4 and cold/warm cache behavior with stable output.

### Phase 9 — Cleanup and final gates

- [x] Update docs map, architecture docs, package READMEs, CLI docs, and contributor guidance.
- [x] Add a short “where does this code go?” table.
- [x] Delete source inclusion, process parsing, manual CLI parser code, and superseded prose.
- [x] Search stale crate names/paths/binary ownership assumptions/command invocations.
- [x] Record retained compatibility adapters and their removal conditions.
- [x] Run the complete repository check and rerun it immediately before handoff.

Required final commands:

    rg -n "uasset-parser-wasm|cargo build -p uasset-parser|src/bin/uasset.rs" .
    pnpm run test:uasset-wasm
    pnpm run test:uasset-wasm:browser
    pnpm run test:release:packages
    pnpm run check:precommit
    pnpm check

Before actual publication, also run or bind the exact protected candidate to:

    pnpm check:unreal

Closure evidence on 2026-08-02: portable `pnpm check`, native/WASM parity, real Chromium, clean
packed-consumer, package/release, CLI parity/cancellation, and benchmark lanes passed. UE 5.7
parser conformance passed 3/3, authoring passed 1/1, and the live Remote Control review suite passed
13/13. Protected publication still requires the workflow to attach that Trusted Unreal result to
the exact candidate; the first npm publication also follows the documented one-time protected
bootstrap before normal OIDC-only trusted publishing.

The search may match historical plans or explicit migration notes. It must not find a live build
assumption, source inclusion, or executable owned by uasset-parser.

## Where does this code go?

| Work                                                          | Owner                     | Reason                                       |
| ------------------------------------------------------------- | ------------------------- | -------------------------------------------- |
| Decode names, imports, exports, properties from bounded bytes | parser                    | Package meaning                              |
| Derive generic authoring, text, texture, saved-world results  | inspection                | Interprets content without machine access    |
| Discover files/project root                                   | IO                        | Chooses machine work                         |
| Read package or companion files                               | IO                        | Owns external resources                      |
| Compute signatures/cache lookup                               | IO                        | Depends on file identity and execution state |
| Bound concurrency, ordinals, backpressure                     | IO                        | Schedules project-scale work                 |
| Serialize protocol frames                                     | thin executable adapter   | Adapts typed IO execution to a process       |
| Decide product workflow                                       | Effect service/public CLI | Product orchestration                        |
| Render help/progress/JSON/human output                        | public CLI                | User presentation                            |

If work spans rows, split it at the typed interface. Do not choose an owner merely because one
language happens to be faster or more convenient.

## Retained compatibility pieces

- `crates/uasset-io/src/legacy.rs` retains the human Rust commands and their established exit
  behavior. It is a compatibility adapter over the new crate boundary, not a second product CLI.
- `crates/uasset-io/src/protocol_adapter.rs` routes every operation through typed direct executors;
  it owns only request framing, event sequencing, progress/diagnostic envelopes, and final JSON
  serialization. There is no child worker or duplicate protocol implementation.
- `apps/cli` remains the public TypeScript command surface. Its declarative Effect CLI tree now
  owns parsing and presentation; leaf execution temporarily crosses the existing
  `CliCommand`/`executeCommand` compatibility adapter. Remove that adapter after direct workflow
  handlers, command spans/signal handling, and the command-module split are complete.

## Test matrix

| Concern                   | Cheapest truthful test                           |
| ------------------------- | ------------------------------------------------ |
| Byte decoding/limits      | parser unit, fixture, fuzz                       |
| Inspection projections    | pure fixtures/property tests                     |
| Discovery/stable order    | IO integration test over temporary project tree  |
| Concurrency/backpressure  | IO bounded-instrumentation test                  |
| Cache keys/invalidation   | IO integration with controlled file changes      |
| Request/event schema      | Rust + TypeScript shared fixtures                |
| Stream invariants         | executor + process protocol test                 |
| Cancellation              | process test proving termination/no late events  |
| AssetReader compatibility | TypeScript integration against real binary       |
| CLI parsing/help/errors   | golden CLI test                                  |
| WASM semantic parity      | structural native/WASM fixture comparison        |
| WASM limits               | wrapper preflight + parser/projection limit test |
| WASM runtime loading      | real browser + Node smoke tests                  |
| Public installation       | clean packed-artifact consumer tests             |
| Unreal compatibility      | existing UE 5.7 gates                            |
| Scale/performance         | reproducible benchmark suite                     |

Mocks may isolate rendering or rare process faults. They do not replace real binary, filesystem,
package, and interruption tests.

## Done when

- parser, inspection, IO, and executable have the stated ownership/dependency direction;
- parser and inspection remain portable/WASM-compatible;
- WASM depends on libraries, never executable source;
- `@ue-shed/uasset-inspection-wasm` is a checksummed, provenance-attested npm artifact with explicit
  bytes-only capability and limit documentation;
- clean browser, Node, and packed-consumer tests prove the generated binding without repository or
  `target` fallback;
- native and WASM inspection/projection results remain structurally equivalent over the committed
  fixture and malformed-input matrix;
- executable is thin over uasset-io;
- v1 contract schemas and cross-language fixtures are authoritative and passing;
- unreal-assets uses one typed streaming process adapter;
- production TypeScript parses neither native stderr nor expected-failure exit codes;
- AssetReader stays compatible;
- existing public and Rust diagnostic CLI compatibility tests pass;
- both current CLI paths have reproducible benchmark results recorded;
- build/package/install/release/benchmark tooling uses new ownership;
- docs answer where new work goes;
- benchmark results are recorded and accepted;
- pnpm check passes immediately before handoff.

## STOP conditions

Stop and request direction if:

- Plan 033 still owns overlap without explicit handoff;
- version 1 cannot represent a current AssetReader operation without an opaque field;
- preserving public CLI behavior conflicts with Effect CLI and needs a breaking change;
- inspection needs filesystem, process, cache, or scheduler access;
- IO needs product workflow or presentation policy;
- a crate move would change public schema meaning rather than ownership;
- the WASM npm package would imply filesystem, project-scan, cache, or `AssetReader` parity;
- input cannot be rejected before crossing the JavaScript/WASM allocation boundary;
- browser and native producers cannot converge on the same versioned inspection/projection evidence;
- matching Effect v4 Node platform package cannot install;
- a release artifact depends on old crate identity beyond the Phase 0 inventory;
- benchmarks materially regress without an understood cause;
- pnpm check fails due to concurrent work that cannot be separated safely.

## Deferred

- persistent/multiplexed Rust workers;
- bidirectional cancellation frames;
- dynamic operation/plugin registries;
- making Rust human commands a product peer of Effect CLI;
- removing the `apps/cli` compatibility dispatcher before direct workflow handlers and command
  parity evidence are complete;
- public command/output schema changes;
- columnar or zero-copy WASM table values beyond the schema-8 compatibility release;
- crates.io publication of parser, inspection, or WASM crates without a demonstrated Rust consumer;
- filesystem discovery, project scans, caches, or native scheduling in the WASM package;
- editor/Workbench-only Rust APIs;
- write support beyond separately approved authoring contracts;
- cache persistence policy changes not handed over by Plan 033;
- unmeasured native rewrites based only on the assumption that Rust will be faster.

## Maintenance

As phases complete, mark checkboxes, record material decisions/benchmark links, update the active
plan status row, and keep Plan 033 handoff references current. When all done criteria pass, move the
plan to archive and retain the ADR/protocol compatibility policy as living guidance.
