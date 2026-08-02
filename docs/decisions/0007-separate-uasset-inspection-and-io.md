# 0007: Separate UAsset parsing, inspection, and IO

## Status

Accepted for the UAsset implementation split in Plan 036.

## Context

ADR 0004 correctly established a portable UAsset parser library and a versioned native process
seam. The current crate shape no longer reflects that decision. The uasset-parser executable now
contains generic inspection projections, project discovery, file reads, cache participation,
bounded concurrency, path-list handling, NDJSON output, and human command parsing. The WebAssembly
binding includes source from that executable to reuse inspection logic.

This makes the parser module shallow for callers and difficult to evolve safely:

- parser and inspection changes risk changing native project execution;
- machine and scheduling changes cannot be tested without the executable;
- WebAssembly reuse depends on executable implementation details;
- TypeScript has command-specific process adapters that parse progress text and expected exit codes;
- moving a measured JavaScript loop into Rust tends to enlarge the parser module rather than create
  a reusable interface.

Plan 033 already owns compact text and texture extraction semantics, fixture coverage, comparative
measurements, and the persistence decision. Its current implementation must remain behaviorally
compatible while this decision changes where generic work lives.

## Decision

Split the native implementation into the following modules:

1. uasset-parser accepts bounded package bytes and produces parsed Unreal package structures,
   parser diagnostics, and parser resource-limit failures.
2. uasset-inspection accepts parser results and explicit supplemental byte inputs and produces
   generic inspection, authoring, text, texture, and saved-world projections.
3. uasset-io owns project discovery, file and companion reads, signatures, cache participation,
   stable ordering, bounded concurrency, cancellation checkpoints, and project-scale execution of
   typed requests.
4. uasset is a thin executable adapter over uasset-io. It owns command transport and human output,
   not parsing, inspection, traversal, cache, or scheduling implementation.

uasset-parser and uasset-inspection remain portable and buildable for wasm32-unknown-unknown. They
do not receive filesystem roots, process authority, native scheduler authority, or product
workflow/presentation policy.

The Rust executable and TypeScript do not mirror command trees. Their shared seam is uasset-io v1:

- a bounded JSON request is written to stdin;
- validated NDJSON events are written to stdout;
- requests and events use explicit discriminated unions with contract/version/requestId fields;
- expected outcomes, including partial per-file work, are typed terminal events rather than stderr
  text or magic exit codes;
- a consumer interrupts work by terminating its scoped child process in version 1.

The language-neutral JSON Schema and shared fixtures under
packages/protocol/contracts/uasset-io/v1 are authoritative. Effect schemas and Rust serde types
conform to them. A breaking semantic change creates a new contract version.

The public AssetReader interface remains compatible while its implementation becomes one scoped,
streaming Effect process adapter. The public CLI moves to Effect CLI without requiring matching Rust
commands.

## Consequences

The parser, inspection, and IO modules become deep at separate interfaces:

- parsing can evolve and be tested from bounded bytes;
- generic interpretation can be tested and reused in WASM without a native executable;
- all machine/project execution behavior gains one IO implementation and test surface;
- native process lifecycle, framing, cancellation, and telemetry gain one TypeScript adapter;
- the public CLI can grow by product capability rather than carrying its own argument parser.

The migration must preserve existing public commands and AssetReader behavior until explicitly
versioned otherwise. Plan 033 continues to decide compact extraction meaning, benchmark acceptance,
and persistence; this ADR only relocates generic implementation and defines the shared process seam.

The workspace must update build, package, release, benchmark, and installation scripts because the
uasset executable will no longer be owned by the parser crate. A persistent worker, request
multiplexing, dynamic operation registries, and bidirectional cancel frames remain deferred until
measurements justify them.
