---
"@ue-shed/uasset": patch
"@ue-shed/uasset-win32-x64": patch
"@ue-shed/unreal-assets": patch
---

A Project Index refresh told nothing about what changed (a host that starts cold, or one whose
file watcher missed a source control sync) no longer walks the whole project on Windows. Each
generation now records the NTFS change journal position its content was listed at, and the next
such refresh reads the journal, without administrator rights, for the content directories that
changed since, then lists and compares only those, with the same result, change report and
`inventoryDigest` as a walk. On a project of about 800,000 packages an unchanged refresh drops from
about 1 s and 150 MB to about 30 ms and 24 MB, and a one-file edit from about 1.3 s to about 40 ms.
It walks as before when the journal cannot say: another platform or file system, a journal that was
replaced or has wrapped, a directory renamed, moved or deleted below a content root, a changed
content root, or more than 4,096 changed directories; `walked_because` says why. The cache format
is unchanged.
