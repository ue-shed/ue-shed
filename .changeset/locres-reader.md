---
"@ue-shed/localization": minor
---

The localization readers now decode compiled `.locres` files, versions 0 to 3 (legacy, compact,
CRC32 and CityHash64), with `parseLocres`, which is also exported from `@ue-shed/localization/browser`.
Each entry has its namespace, key, text and the hash of the source string it was compiled from.
`LocalizationEvidence.readResource({ projectRoot, target, culture })` reads one culture's resource
from the target's configured output path and returns it as `ResourceFileEvidence`, with provenance,
or as a typed failure such as `file_missing`. The new failure code is `malformed_locres`.

A `.locres` holds what the game actually shows. That is the only record of the translations for a
project whose own tools write `.locres` directly, without archives. Where a translation is stale or
empty, Unreal compiles the current source text instead.

`LocalizationEvidenceApi` has a new required member, so a custom implementation needs
`readResource` too. Layers built by spreading the live service pick it up unchanged.
