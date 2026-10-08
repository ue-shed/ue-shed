---
"@ue-shed/protocol": minor
"@ue-shed/uasset-inspection-wasm": minor
"@ue-shed/uasset-win32-x64": minor
---

Read saved Game Text from Unreal 4.27 through 5.3 packages that use legacy property tags. The native
reader and WASM inspection decode legacy tags, containers and text histories alongside the 5.4+
layout. Text coverage gaps add `legacy_container_element_without_type_information`,
`feature_unavailable_for_engine_version` and `property_decoder_rejected` reasons beside
`unsupported_text_history`; consumers that switch exhaustively on the reason should handle them.
