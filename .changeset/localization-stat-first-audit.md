---
"@ue-shed/localization": minor
---

The write audit around a localization commandlet run no longer reads the whole project. It records
every file's size and modification time, hashes the plan's own files, and after the run hashes only
files that are new or whose size or modification time changed. A write outside the plan is still
reported. On a 35,000-file, 15.7 GB project the audit used to fail with `limit_exceeded` after 10
seconds, so no gather or compile could run; its first snapshot now takes 2.6 seconds.
`LocalizationAuditLimits.maxFileBytes` and `maxTotalBytes` now bound only hashed bytes, and the
default `maxEntries` is 1,000,000. A change found by size or modification time alone carries
`beforeUnread: true`, because the file's earlier content was not hashed.
