---
"@ue-shed/game-text": patch
"@ue-shed/protocol": patch
"@ue-shed/unreal-assets": patch
---

Game Text reads that hydrate rows spend less time in the native engine, with identical answers:

- A localization line export with `fields` builds only the fields it names. Identity and source
  for every line of a 583,507-line target took 21.4 s and now take 3.4 s; a line's whole preview,
  with every culture's mark, was built and discarded for each line.
- A rows-only page (`searchRows`, no counts, facets or groups) walks the display order only until
  its page is full, instead of listing every matching row first. Small source pages take about
  half the time; target pages about two thirds.
- Batch rows serialize their nested values (cultures, manifest entries, places) into one buffer,
  about 7 times faster. Reading 1,000 chosen lines with every field went from 671 ms to 466 ms.
- A line preview reads the manifest's file metadata once per reader instead of parsing it again
  for each manifest location.

A localization page may hold up to the query's 100,000-row page bound. `LocalizationQueryPage`
rejected more than 50 lines, so a larger `pageSize` failed to decode.
