# UAsset parser work catalog

This catalog tracks the next improvements to the read-only classic-package parser and its
TypeScript process boundary. Priorities are ordered by impact divided by implementation effort.

| Priority | Work                                                              | Impact | Effort       | Status                      |
| -------- | ----------------------------------------------------------------- | ------ | ------------ | --------------------------- |
| 1        | Preserve UE5 `FVector` double precision                           | High   | Small        | Complete                    |
| 2        | Preserve structured parser diagnostics in TypeScript              | Medium | Small        | Complete                    |
| 3        | Add value-level real-fixture conformance tests                    | High   | Medium       | Complete                    |
| 4        | Define a language-neutral inspection schema                       | High   | Medium       | Planned                     |
| 5        | Add a minimal batched catalog operation                           | High   | Medium       | Complete                    |
| 6        | Bound file and stdin input before allocation                      | Medium | Small/medium | Planned                     |
| 7        | Expand property and native-struct codecs from a capability matrix | High   | Large        | In progress — LevelSequence |
| 8        | Add fuzz targets and a malformed-package regression corpus        | High   | Medium/large | Planned                     |
| 9        | Keep capability and compatibility documentation current           | Low    | Small        | Complete                    |
| 10       | Add bounded header-only package metadata parsing                  | High   | Medium       | Complete                    |
| 11       | Persist and incrementally invalidate the saved-table catalog      | High   | Medium       | Complete                    |
| 12       | Require a portable `wasm32-unknown-unknown` library build         | High   | Small        | Complete                    |
| 13       | Add a reproducible native/CLI/Unreal benchmark harness            | High   | Medium       | Complete                    |
| 14       | Resolve decode-path names by borrow instead of per-property alloc | High   | Small        | Complete                    |
| 15       | Decide the WASM table-read boundary and value representation      | High   | Medium/large | Planned                     |

## Dependency order

Precision and diagnostic correctness come first. Real-fixture conformance and the shared wire
schema follow because they protect every later codec and compatibility change. Catalog performance
and input bounds can then proceed independently. Broad codec work should be incremental and driven
by checked-in Unreal-generated fixtures. Fuzz failures become ordinary regression tests.

## Current boundary

The supported product boundary is read-only inspection of classic, uncooked, versioned editor
packages. Cooked packages, unversioned properties, IoStore/Zen packages, swapped endianness, UTrace,
and general bulk-data decoding remain out of scope until a product use case changes that decision.

Supporting property tags older than UE5 complete type names is also deferred until UE Shed chooses
an explicit engine compatibility window.

Levels are inside that boundary and always have been. A `.umap` is the same classic package
container as a `.uasset`, and `asset.rs` routes any class it does not specifically claim through the
generic UObject tagged-property decoder, so actors, components, `Level`, `World`, and `WorldSettings`
all decode without a level-specific decoder. Do not read the named class constants in `asset.rs`
(`DATATABLE_CLASS`, `STRINGTABLE_CLASS`, and the rest) as the list of supported asset types:
`is_generic_uobject_class` is a permissive default, not an allowlist. `uasset inspect` on the fixture
level decodes all 16,525 exports across 29 classes, and `test:uasset-conformance` holds that decode
to the property tags Unreal's own serializer emits. See
[UAsset benchmarks](../engineering/uasset-benchmarks.md) for the level lanes and
`fixtures/unreal-project/FixtureExpected/level-decode-gaps.json` for the pinned coverage.

What levels do _not_ get is class-specific native serialization. Classes with a custom
`UObject::Serialize` write binary after their tagged properties, and the parser retains that as
`tail_bytes` rather than decoding it: `UModel` is the clearest case in the fixture level, where BSP
`Bounds`, `Vectors`, `Points`, and `Nodes` are native. That is a genuine boundary, distinct from the
tagged-property coverage above, and it is why `tail_bytes` is non-zero on almost every level export.

`AnimSequence` is the first animation-specific increment under item 7. A UE 5.7-generated fixture
pairs a two-bone `Skeleton` with an uncooked sequence containing two seconds of source motion, two
tracks, and root-motion settings. The parser consumes the sequence's small native trailer and keeps
the package at `status: ok`; it deliberately does not decode cooked compressed tracks or legacy
inline raw tracks. UE 5.7's authoritative source motion lives in separately exported animation-data
model objects, so track/curve summaries belong in a narrow animation projection over the decoded
package rather than in the `AnimSequence` trailer decoder.

`LevelSequence` is the next increment and is intentionally evaluator-independent. The UE 5.7
fixture contains a five-second `MovieScene`, one object binding, a text property track, one section,
and three localized `FMovieSceneTextChannel` keys. The generic UObject decoder already recovers the
export graph and text values; the added native codecs recover `FFrameNumber` arrays and
`FMovieSceneFrameRange`. A compact schema-1 projection then joins binding, track, section, range,
and timed text while retaining unsupported track classes as structural inventory with explicit
coverage gaps. It does not claim Sequencer evaluation, blending, runtime binding resolution, or
complete coverage of every track and channel class.

Catalog discovery now reads only the package header needed for names, imports, exports, and resolved
class paths. It does not decode DataTable rows. A versioned cache stores path, size, modified time,
classification, and diagnostics; changed signatures are the only entries reparsed. Full payload
decoding remains the selected-table operation.

The parser library must remain a bounded bytes-to-evidence implementation that compiles for
`wasm32-unknown-unknown`. Filesystem discovery, subprocesses, native concurrency, and caches are
adapter concerns. The benchmark harness records native parser, TypeScript projection, and optional
fresh Unreal commandlet measurements separately so startup and semantic work are not conflated.

Item 14 removed the per-property `String` allocations the decoder was paying to resolve names, to
compare against the stream terminator, and to build error breadcrumbs that the happy path never
prints. Names now resolve by borrow from the package name map, and breadcrumbs render lazily through
`Display`, so the reader only stringifies a path when a read actually fails. Item 15 is not a parser
change but a boundary decision: whether a WASM table read should hand TypeScript columnar values
from a trusted in-process producer rather than JSON that Effect Schema re-validates once per value.
Both are written up in [WASM decode boundary](wasm-decode-boundary.md), which also lists what still
has to be measured before item 15 can become an accepted decision.
