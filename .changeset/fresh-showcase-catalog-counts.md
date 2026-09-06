---
"@ue-shed/protocol": minor
"@ue-shed/unreal-assets": minor
"@ue-shed/uasset": minor
---

Add generation-bound Project Index counts through
`countProjectIndex({ projectId, expectedGeneration, filters })`. Supply 1–16 `ProjectIndexFilter`
values for maps, exact classes, class prefixes, class-name suffixes, or serialized names. Each
value-based filter requires 1–64 non-empty values; empty filter lists are rejected. Overlapping
matches count each package once. The production binary Catalog reads checked snapshot postings
without transferring candidate headers, and the public helper validates result identity and generation.
