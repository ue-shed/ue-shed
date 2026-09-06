---
"@ue-shed/protocol": minor
"@ue-shed/unreal-assets": minor
"@ue-shed/uasset": minor
---

Add generation-bound Project Index count queries over the union of class and serialized-name
selectors. Overlapping matches count each package once, empty selectors count zero, and native
SQLite returns one aggregate record without transferring candidate headers. The public
`countProjectIndex` helper validates the result identity and generation.
