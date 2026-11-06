---
"@ue-shed/protocol": minor
"@ue-shed/localization": minor
"@ue-shed/game-text": minor
---

Game Text shows a culture's translations from its compiled `.locres` when the culture has no
archive.

- The native localization import reads compiled resources (format `"locres"`), versions 0 to 3:
  an archive-shaped layer with each entry's display string and the hash of the source it was
  compiled from (`entry.source-hash`). Malformed resources fail with the typed `malformed_locres`
  and recovery guidance. The hash is verified against Unreal-compiled version 3 resources; for
  versions 0 to 2 it is exposed but marked unverified.
- A culture whose archive is missing reads its resource. Against the manifest source, or the saved
  source without a manifest, it is `translated`, `not_translated` (the source or native text was
  compiled in) or `needs_update` (the source changed since the compile). An entry the resource
  lacks is `not_translated` with a manifest and `unknown` without one.
- The shipped translation's origin can be `"locres"`, culture states carry the `locres` entry, and
  rules read it as `latest` with `latestOrigin: "locres"`.
- In a project with no gather configs, target discovery finds compiled resources by Unreal's runtime
  convention, `Content/Localization/<Target>/<culture>/<Target>.locres`. A Dashboard target of the
  same name gets them; another name becomes a `resource_files` target. Both are marked
  `resourcesDiscovered`, and the Workbench labels them "discovered".
