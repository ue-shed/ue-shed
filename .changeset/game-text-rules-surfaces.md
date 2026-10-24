---
"@ue-shed/cli": minor
"@ue-shed/workbench": minor
---

`ue-shed loc check` takes `--rules <file>` to check with that file in place of the project's own,
so a read-only project can be checked. Without either, it runs no checks and says so on stderr. It
prints the report in parts with the same bytes, so a large project's report no longer exceeds
Node's string limit.

Workbench's Quality checks tab shows "No quality rules for this project", with **Create rules
file** and **Choose a rules file…**, when the project has no rules file: nothing is checked
without one.
