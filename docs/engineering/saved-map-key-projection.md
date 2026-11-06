# Saved map keys and Unreal round trips

A successful saved inspection is not permission to convert every map to a JSON object. Keep
`SavedPropertyValue.Map.entries` as entries with typed keys. A host that needs string keys must
either prove that its supported key subset has the spelling expected by its write codec, or refuse
that projection. `String(object)` collapses distinct keys; JSON serialization does not implement
Unreal export text.

## What the engine requires

The UE 5.7 and 5.8 implementations were checked in `Engine/Source/Runtime/CoreUObject/Private/UObject`:

- `PropertyMap.cpp`, `FMapProperty::ExportText_Internal` and `ImportText_Internal`, delegate each key
  to the actual `KeyProp` with `PPF_Delimited`. Map-key spelling is a property operation, not a
  generic conversion of the decoded value.
- `PropertyStruct.cpp`, `FStructProperty::ExportText_Internal`, delegates to
  `UScriptStruct::ExportText`. Native struct operations can supply their own representation.
- `TextProperty.cpp`, `FTextProperty::ExportText_Internal` and `ImportText_Internal`, use
  `FTextStringHelper::WriteToBuffer`/`ReadFromBuffer`, text history, port flags and namespace/package
  context. The property also distinguishes culture-invariant, transient, empty and string-table
  values when comparing identity. Display text alone is insufficient.
- `StrProperty.cpp.inl`, `ExportText_Internal`/`ImportText_Internal`, treats delimited text
  differently from plain text. Existing host scalar spelling must be audited against the host's
  eventual native write path, including quotes, backslashes, delimiters and empty values.

The source investigation did not launch Unreal. It establishes the required boundary; it is not a
live round-trip certification.

## Metadata available from saved inspection

Rust owns these contracts in `crates/uasset-inspection/src/saved_inspection.rs` and `authoring.rs`.

| Evidence                   | What it preserves                                                          | Why it cannot establish universal export text                                                                               |
| -------------------------- | -------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| Saved map entries          | Ordered typed key/value entries, including nested structured values        | They have no key `FProperty`, map key type descriptor or export context.                                                    |
| Saved struct/native struct | Named child fields, and property type names for ordinary struct properties | A map key has no owning struct identity; native fields do not identify custom import/export operations.                     |
| Saved text                 | Display/source text, projected history and optional namespace/table/key    | Formatted histories are projected through their format identity; full history, arguments and text flags are not retained.   |
| Saved integers             | An `f64` number                                                            | This cannot recover arbitrary original 64-bit integer precision.                                                            |
| Saved object references    | Resolved object path, or null                                              | The exporting property, referenced class and owner/root context are absent; unresolved references can also project to null. |
| Saved non-finite floats    | Missing finite numeric components                                          | This does not distinguish every original non-finite value.                                                                  |

The existing `authoring_value` map branch recursively preserves both keys and values as
`AuthoringMapEntry`. This avoids JSON object-key collisions, but its saved projection is not
universally lossless: its Rust `AuthoringValue::Text` currently contains only `value`; native and
instanced structs become `AuthoringValue::Unsupported`; missing numeric components mark the
projection partial. Do not infer a native text serializer from this projection.

## Host projection refusal

A host's string-key adapter should report its own typed projection failure, for example
`SavedMapKeyUnsupported`, retaining the original saved key and entry as evidence and, where the
host's error model supports it, the original failure identity. Guidance should explain that the
saved package was inspected successfully and direct the user to a live Unreal authoring path for
keys that require native type/history information. Refuse before constructing a lossy record.

`InspectionError` with `unsupported_capability` describes inspection capability failure. It is not
appropriate for successful inspection followed by an unsupported host string-key projection.
`AuthoringValue::Unsupported` is an authoring-value sentinel with reason/byte size and partial
snapshot semantics. It cannot stand in for a host projection error retaining the original map
evidence. Neither existing outcome is a more precise replacement for that host-owned error.

This refusal needs no new wire representation, dependency pin or release. Preserve an existing
primitive spelling only for the explicitly audited subset. Do not advertise that subset as a
universal Unreal round trip, and do not replace a failed conversion with a synthesized key.

## Existing live structured path and future capability

`UEShedAuthoringLibrary.cpp` already serializes maps as structured `AuthoringValue.Map.entries`,
including each key and value, and `AssignPropertyValue` writes them through the real
`FMapProperty::KeyProp`/`ValueProp`, then rehashes the map. Live text serialization includes
identity; assignment uses `TextFromIdentity`. Object and native struct assignment likewise use
their actual Unreal properties. This is a defined native assignment path for its supported
property kinds, not a universal export-text API.

A host adopting that path must migrate its complete read/storage/edit/write codec chain together,
preserve text identity and unsupported states, use the matching property descriptor and producer
contract, and prove its supported keys in both UE 5.7 and 5.8. Native struct kinds outside that
writer's support remain explicitly unsupported. Existing scalar JSON storage is not silently
interchangeable with typed map entries.

A future export-text capability should be owned by the native producer and expose the property's
actual key text plus the descriptor, contract/version and import context needed for its inverse.
If saved-only projection is required, first retain the missing source metadata in Rust-owned
contracts and define a supported subset. Only then design generated protocol changes and consumer
migrations. Publishing and downstream installation are separate release actions.
