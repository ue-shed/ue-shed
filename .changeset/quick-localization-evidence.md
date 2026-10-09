---
"@ue-shed/localization": patch
---

Speed up localization file parsing and retain compact PO evidence for large targets. Byte-exact PO parsing and serialization remain available; applying translations rereads and checks the file before writing.

Target PO evidence now exposes decoded entries in `value.entries`. Use `projectPOEvidence` to convert a full parsed document when constructing evidence; `parsePO` and `serializePO` keep their existing types and results.
