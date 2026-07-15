# UAsset parser work catalog

This catalog tracks the next improvements to the read-only classic-package parser and its
TypeScript process boundary. Priorities are ordered by impact divided by implementation effort.

| Priority | Work                                                              | Impact | Effort       | Status   |
| -------- | ----------------------------------------------------------------- | ------ | ------------ | -------- |
| 1        | Preserve UE5 `FVector` double precision                           | High   | Small        | Complete |
| 2        | Preserve structured parser diagnostics in TypeScript              | Medium | Small        | Complete |
| 3        | Add value-level real-fixture conformance tests                    | High   | Medium       | Complete |
| 4        | Define a language-neutral inspection schema                       | High   | Medium       | Planned  |
| 5        | Add a minimal batched catalog operation                           | High   | Medium       | Planned  |
| 6        | Bound file and stdin input before allocation                      | Medium | Small/medium | Planned  |
| 7        | Expand property and native-struct codecs from a capability matrix | High   | Large        | Planned  |
| 8        | Add fuzz targets and a malformed-package regression corpus        | High   | Medium/large | Planned  |
| 9        | Keep capability and compatibility documentation current           | Low    | Small        | Complete |

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
