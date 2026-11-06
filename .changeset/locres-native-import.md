---
"@ue-shed/protocol": minor
---

The native localization import reads compiled `.locres` resources (format `"locres"`), versions 0
to 3, as a culture's translations: an archive-shaped layer with each entry's display string and
the hash of the source it was compiled from (`entry.source-hash`). Malformed resources fail with
the typed `malformed_locres` and recovery guidance. The source hash is verified against
Unreal-compiled version 3 resources; for versions 0 to 2 it is exposed but marked unverified.
Game Text does not use resources yet.
