# 0012: The native engine is part of the host: one contract, typed through, trusted after one handshake

## Status

Accepted, 2026-10-23, for Plan 059 Phase 1. Settled by a three-member design council (Claude, Codex,
Muse) with spikes, and decided by the owner. The council material is outside the repository.

## Context

UE Shed's TypeScript hosts (CLI, Workbench, and Electroswag through `@ue-shed/*`) run the Rust
`game-text-index` engine as a child process. They are one system, shipped in one build. The
boundary between them was nonetheless treated as a protocol between strangers.

**The host validated its own requests before sending them** (`Schema.decodeUnknownEffect(...,
{ onExcessProperty: "error" })`), then Schema-walked every reply. The engine validated again.

**Payloads were encoded several times:**

- JSON strings nested inside NDJSON frames;
- `payload: String` holding JSON inside the JSON request;
- the rule document written to a temporary `rules.json` and sent as a path;
- bulk results written to files with a `{"bytes": n}` reply, and a 16 MiB file fallback.

**Inside the engine, rules were JSON-shaped:**

- the compiled program was `op: String` with `serde_json::Value` parameters;
- kernels converted every input into a JSON-like `Value` and back;
- evidence was stored as JSON text, then parsed and rebuilt for every read;
- shipping code started PowerShell to read process memory.

On the generated 1× project, evaluating 21 rules took 151 s and peaked at 7.8 GiB. A memory
investigation attributed most of the remaining 4.1 GiB peak to JSON-shaped retention:

| Holder                    |    Size |
| ------------------------- | ------: |
| Per-occurrence place JSON | 903 MiB |
| Arena value trees         | 668 MiB |
| Never-evicted raw columns | 607 MiB |

Phase 0 measured the transport itself as cheap. Pipe delivery was 0.52 ms of a 20 ms small round
trip, and 24 ms of 1.45 s at 5,000 rows. Engine compute, column construction and hydration into
JavaScript objects were the cost.

## Decision

### Topology: keep the child process, as part of the host

- Each host runs one long-lived engine session.
- The process boundary exists to **give back memory** and **contain crashes** (a panic, OOM or
  damaged index must not take down the CLI, Workbench or Electroswag's domain server). It is not a
  trust boundary.
- The host can set a memory ceiling, and a session that reaches it is recycled.
- N-API saves fractions of a millisecond where compute dominates. WASM is capped at 4 GiB and has
  no rayon without a threads build. Neither is adopted.

### One contract: Rust owns it, TypeScript types are generated

- The engine defines every message once, in Rust:
    - requests and replies;
    - the rule IR (`Expr`);
    - batch headers;
    - errors.
- `ts-rs` generates TypeScript types from those definitions. The generated files are committed,
  and a Rust test fails if they drift.
- TypeScript adopts the generated types. Its hand-written v4 `Expr` type and v4 Effect Schema are
  deleted.
- Shapes that cannot derive cleanly are hand-written once:
    - WTF-8 text (lone surrogates);
    - absent versus `null`;
    - ordered maps.
- **Types are erased at runtime.** They guarantee only that the shipped JavaScript was checked
  against the engine's contract when it was built.
- **The single runtime check is the handshake.** The engine binary and the host bundle each embed
  `{ buildId, contractHash }`. The host compares them once per engine worker process, before its
  first request, so a restarted worker is checked again and a failed check is retried. A contract
  mismatch is refused as a packaging defect.
    - `buildId` identifies the co-built artifacts.
    - `contractHash` covers the source of everything that decides the wire: the contract types,
      the engine's requests and outcomes, finding construction, and the JSON and UTF-16 encoders.
    - A different `contractHash` is refused. A different `buildId` with the same contract is logged,
      not refused: the host cannot tell a development override with a separately built engine from a
      packaged one, and the wire is the same either way.
- **After the handshake, no message is validated on either side.** A malformed reply is an engine
  bug and surfaces as a defect.
- **Effect Schema runs only on input from outside the system:**
    - user-authored rule documents (versions 1–3), once, when loaded;
    - project and Unreal files;
    - caches written by other builds, which are already keyed by version.
- Effect services sit above the contract. The engine's error enum is generated into a tagged union
  and mapped once to `Data.TaggedError`s.

### Encoding by message class

| Class                                                      | Encoding                                                                                                                                                                                                                                                                                                                          |
| ---------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Requests, small replies, errors, progress, profile, cancel | JSON text with the generated types: `JSON.parse`, no decode. Sub-millisecond at these sizes, and readable in logs. JSON here is only a serialization: each side reads it straight into its typed form. No `u64` crosses; identity lanes are `u32`. Lone surrogates travel as JSON escapes and are read by the WTF-8-aware reader. |
| Bulk rows, findings, export pages                          | Relation-specific columnar batches: aligned little-endian numeric columns, validity and selection bitsets, list offsets, and a string arena. Bounded per frame.                                                                                                                                                                   |
| Export to a file                                           | The engine writes the sink (CSV or JSONL) and replies with a count.                                                                                                                                                                                                                                                               |

**Deleted:** JSON nested in strings, temporary request and reply files, the 16 MiB file fallback,
and Protobuf or any other IDL.

### TypeScript consumes batches with low-level types

- **Columns** are `Uint32Array`/`Float64Array` views over the frame's `ArrayBuffer`. They take
  constant time to create and copy nothing.
- **Filters and selections** are `Uint32Array` bitsets. Sorting and paging permute row indexes.
- **Strings** stay arena indexes until something is shown. Visible cells decode lazily: through
  `TextDecoder` normally, and through a small UTF-16 path for strings the batch flags as containing
  lone surrogates (`TextDecoder` would replace them).
- **Objects** are built only for visible rows and for genuinely external outputs, such as
  `loc check`'s JSON.
- **To the renderer,** buffers are transferred (`postMessage` with transfer, or binary WebSocket
  frames), not copied as JSON objects.
- A batch is scoped like a reader handle, because a view pins its buffer.

### The rule program

- TypeScript validates the authored document once and translates it to the generated `Expr`.
- Literals are always `{"lit": …}` in the IR, so `Expr` is a plain externally tagged enum. Bare
  scalars force serde to buffer and retry each node: 2–22 ms per catalogue in the spikes, with
  useless errors.
- The IR goes inline in `findings_evaluate` as JSON text in a string field, read through the
  WTF-8-aware JSON reader. Phase 1 keeps the NDJSON protocol, whose serde-decoded requests cannot
  carry lone UTF-16 units or raw JSON in a typed field; the text is not re-validated by the host.
- Nesting has one budget: the JSON reader's limit, 127 levels for the whole document (the default
  catalogue document nests 29). Deeper input is a typed error, never a stack overflow, and it is
  tested at 127 and 128 on a 1 MiB stack. Authored documents (versions 1–3) contain no
  expressions, so no user-facing depth error is needed.
- Rust is the only semantic compiler. It lowers the IR to an `Op` enum with typed parameters,
  compiled regexes, classes and term matchers, and fields resolved to column handles.
- Kernels are typed functions that trust the compiler's types. Compile errors are typed (rule,
  path, code).

### Inside the engine, and storage

- Values are interned `StrId`s, typed numeric and boolean columns, and typed arena records. No
  `serde_json` past deserialization.
- Evidence is stored as typed values in the findings layer, never as JSON text. Places are
  occurrence row IDs. Reads project only the stored columns they need.
- **Finding identity is a durable contract.** It is computed from typed values with the existing
  canonical formulas, never from transport bytes.
- Shipping code starts no child processes. Process memory comes from the `process-metrics` crate.

### Errors and observability

- Errors cross as typed values. Process death is a typed engine-unavailable failure that
  invalidates the session's handles.
- Every terminal frame carries the engine's profile: stages, kernels, and memory (private and
  working set). The host turns it into child spans.

## Phasing

**Phase 1 (rule engine and findings):**

- the typed `Expr` → `Op` program, typed kernels and typed evidence storage;
- the IR inline, with `rules.json` deleted;
- generated types and the handshake for the `findings_*` messages;
- no Schema walk on the engine's own requests or replies;
- findings replies stay bounded pages.

NDJSON framing survives Phase 1, so the parity gate does not ride a transport rewrite as well.
Until Phase 3, the shared uasset-io transport still validates each event frame for every
operation, and the engine still bounds each request's allocations (reader handles, row counts);
the frames are small, and the rule IR and finding replies inside them are no longer walked.
The gate is peak private bytes ≤2 GiB and ≤15 s on the 1× index.

**Phase 3 (query engine):** row sets, findings as query fields and response parts, still over
NDJSON. Its specification moved the transport work to Phase 4, so the query paths change shape
once rather than twice.

**Phase 4 (streaming API):** the engine's own binary session with request IDs, columnar batches
and the typed-array consumption model, concurrency, cancellation, progress frames and
engine-written export sinks. Every engine request moves to generated types. Delete
`payload: String`, `output` paths and the JSON response caches. The
[Phase 4 specification](../engineering/game-text-rule-engine-phase-4.md) has the design.

## Measure to confirm

- Turning one 5,000-row findings batch into the visible page: typed-array views against
  `JSON.parse`.
- `loc check` end to end with typed evidence storage, against today's output.
- The Phase 0 failure comparisons that never ran: panic, damaged index and cancellation, on the
  pipe.
- Recycling at the memory ceiling.
