---
"@ue-shed/game-text": patch
"@ue-shed/uasset": patch
---

Add a `translation_key` search filter clause that selects text by the gathered namespace and key
Unreal translates it by: saved FText without its package marker, String Table entries with their
table namespace. Values are `JSON.stringify([namespace, key])`, as the newly exported
`gatheredIdentityKey` writes them. With a target it matches that line; without one, every saved
unit gathered under the key, so Blueprint copies saved under different package markers no longer
need a client-side scan of `conflicting_source` lines. Native search, the TypeScript reference and
counts, facets and groups agree on it.
