# WASM decode boundary

This note records why the decode hot path matters most under WASM, and what the shape of a
WASM-first table read should be. It is exploratory. Nothing here is an accepted decision, and the
central claims about WASM are reasoned from a native measurement rather than measured under WASM.

## What ships today, and how it differs

WASM is not a prerequisite for anything. An external host such as Electroswag consumes the parser
today through the published native artifacts: `@ue-shed/uasset` selects a platform binary,
`@ue-shed/uasset-win32-x64` carries it, and `@ue-shed/unreal-assets` provides the `AssetReader`
service over it. All three are already in the candidate npm allowlist, and the candidate job installs
the packed tarballs into a clean offline consumer, so no new packaging work is required.

The two surfaces differ in capability, not only in speed.

|                                | Native artifact                                                                  | WASM binding (not built)                                                                                      |
| ------------------------------ | -------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| Discovery, scan, catalog cache | Yes                                                                              | No. The core takes bounded bytes and has no filesystem authority, so the host must enumerate and supply them. |
| Decode a package it is handed  | Yes                                                                              | Yes                                                                                                           |
| Platform coverage              | Windows x64 only today; the launcher raises `UnsupportedPlatformError` elsewhere | Platform neutral                                                                                              |
| Per-call process startup       | About 8 ms                                                                       | None                                                                                                          |

So the native artifact is the complete surface and the WASM binding would be a partial one, useful
where bytes are already in hand and startup is worth avoiding. Adding a second platform artifact is a
build-matrix change, not new parser code, and is the more likely near-term need. Both producers must
keep passing the same fixture and conformance assertions so semantics do not fork.

## What was measured

Removing per-property allocation churn from the native decode (`673289e`, parent `9e9e293`) produced
the following on `DT_LargeScalars` (2,402,007 bytes; 10,000 rows; about 9 properties per row).

Decode only, in process, parse-once and decode-many, 60 iterations, result black-boxed:

| Build              | p50      | min      |
| ------------------ | -------- | -------- |
| Before (`9e9e293`) | 45.84 ms | 44.76 ms |
| After (`673289e`)  | 12.03 ms | 11.30 ms |

That is about 3.8x on the decode slice. The same asset through release `uasset inspect --format
json` went from 113.8 ms to 59.9 ms p50, because the CLI number also carries roughly 8.4 ms of
process startup plus a 4,442,445-byte JSON serialization that this change does not touch. Both
figures come from the same machine and fixture; treat them as a local before/after, not a portable
budget.

The timed region constructs and drops the decoded tree each iteration. That cost is identical in
both columns, so it inflates both equally and the ratio is if anything conservative for the
parse-and-populate work alone.

Output was byte-identical before and after (matching SHA-256 over the full JSON), and the real UE
5.7 commandlet conformance lane passed, so the speedup carries no format or semantic change.

`native.inspect.single` in `pnpm benchmark:uasset` did not move, as expected: its fixture is about 3
KB and the scenario is dominated by process startup. Large-table decode wins are invisible there.

## Why WASM has the most leverage

Two independent effects stack, and neither is visible in the native CLI number.

**Allocation churn costs more under WASM.** The removed pattern was allocate, format, drop
immediately. Native allocators optimize exactly that: thread-local free lists recycle a hot block
almost for free, so the native "before" was cushioned. The default `wasm32-unknown-unknown`
allocator has far less of that small-object caching, so the same churn costs relatively more there.
The work removed was cheapest on the surface that optimizes it best and dearest on the surface that
optimizes it least. Additionally, WASM linear memory only grows and is never returned to the host,
so sustained churn fragments the instance and can force `memory.grow`, which is a latency cliff
rather than a smooth cost, and which degrades later allocations in a long-lived tab.

**Decode is a larger share of felt latency under WASM.** In process there is no per-open spawn and
no subprocess JSON framing, both of which diluted the ratio in the CLI measurement. A given absolute
saving converts more directly into a faster table open, and a long-lived session opens many tables
with no startup cost to hide behind.

The honest bound on this: allocator cost gaps are on the order of small multiples, not orders of
magnitude. The larger term is leverage, not raw allocator speed.

## The double decode

Today a table read decodes twice. Rust turns bytes into typed values and serializes them to JSON;
TypeScript parses that JSON and re-validates it with Effect Schema
(`decodeAuthoringTableSnapshot`, over the roughly 13-member `SavedPropertyValueUnion` in
`packages/unreal-assets/src/index.ts`, once per property value).

The second pass exists because the data arrives as `unknown`, and it arrives as `unknown` only
because it crossed a process boundary as a string. Rust is already the parse-don't-validate layer:
`.uasset` bytes genuinely are untrusted, and `property.rs` and `codec.rs` are what reject malformed
input, with `PropertyError` as the typed failure. Effect then re-establishes a property that the
decoder already proved, in the slower language, once per value.

Under WASM that boundary disappears. The decoder's output is a return value, not an unknown string,
so the happy path can be a type assertion rather than a runtime check.

## Proposed shape: columnar, validated at the boundary

The stronger form of the same insight is not "skip the check" but "have nothing per-value to check."

For a 10,000 by 9 scalar table, hand back columns rather than rows: a typed array per numeric column
(`Float64Array`, `Int32Array`), plus a string pool with offsets. There is then no per-value
JavaScript object and no per-value schema check. Object allocation for roughly 90,000 property
objects is a significant V8 cost on its own, independent of validation, and a data grid wants columns
anyway.

Validation does not go away; it moves to where it is cheap and meaningful.

- **Version skew** is the real risk. If the WASM artifact and the TypeScript bundle ship as one
  versioned unit, skew is impossible. If WASM is cached or versioned independently, check one
  protocol tag at the boundary. That is O(1), not O(rows times columns).
- **Genuinely untrusted input** keeps a full schema: user-edited values, network payloads, and
  snapshots written by an older version.
- **The write path** is real user input. Authoring mutations flowing back toward the asset must be
  validated strictly. That direction is not hot.
- **Development and test builds** should keep the full schema check behind a flag, so conformance
  tests continue to prove that the Rust producer and the TypeScript consumer agree. Trust in
  release, verify in CI.

### Tension with an existing engineering rule

`docs/engineering/README.md` rule 2 says to use Effect Schema by default. This note proposes a
scoped exception on one hot path, not a general retreat from it. If the columnar boundary is adopted,
the rule should gain an explicit carve-out naming the condition, which is a trusted in-process
producer whose output is already proven by construction, with the schema retained for untrusted
input, for the write path, and in test builds. Silently diverging from the rule would be worse than
either keeping the schema or amending the rule.

Effect itself offers no WASM story to reach for here. It is TypeScript, with no compile-to-WASM
path, so schema work stays in V8 by construction. That is precisely why the useful move is changing
the data handed to it rather than hoping to accelerate it.

## Open questions, in the order worth answering

1. **Split the second pass.** The roughly 107 ms TypeScript figure quoted in discussion is reported,
   not measured here. Instrument it and separate `JSON.parse` from union dispatch from struct
   decode. The fix priority flips depending on the split.
2. **Measure WASM before betting on it.** The library already compiles for
   `wasm32-unknown-unknown`, so a parse-once decode-many harness is cheap. What does not exist yet
   is the versioned inspection binding and host scenario that
   `docs/engineering/uasset-benchmarks.md` requires. Until then, the WASM reasoning above is
   theory. Running the same before/after by checking out the three files from `9e9e293` would also
   give a real counterfactual for how bad the unoptimized path would have been under WASM.
3. **Check whether the snapshot schema transforms or only validates.** The property union is plain
   `Schema.Struct` with literals, which is structurally identity and therefore removable. If
   `AuthoringTableSnapshot` performs real transformation, that shaping has to move into Rust instead
   of being deleted.
4. **Cheap independent win, valid either way.** `SavedPropertyValueUnion` has two `text` members
   that share `value_kind: "text"` and differ only by `history`. An ambiguous discriminant can force
   try-each-member decoding instead of a constant-time tag dispatch. Giving them distinct kinds, or
   folding them into one member with an optional `history`, speeds up the current architecture and
   is not wasted if the columnar boundary lands later.
