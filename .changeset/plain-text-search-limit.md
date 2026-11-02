---
"@ue-shed/cli": patch
---

`ue-shed text search` without `--target` prints at most `--limit` matching lines (50 by default), as
it does with `--target`, and reports `total` and `omitted`. It used to print every match, which for a
common word on a large project was too much to read.
