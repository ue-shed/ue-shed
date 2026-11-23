---
"@ue-shed/uasset": patch
"@ue-shed/uasset-win32-x64": patch
"@ue-shed/unreal-assets": patch
---

Speeds up cold Project Index builds on large projects without changing the cache format or query
output.

- On Windows, package header reads and whole-file asset reads now open files with
  `FILE_WRITE_ATTRIBUTES` (falling back to plain read access on denied or read-only volumes) and
  suppress NTFS `LastAccessTime` updates on the handle, avoiding per-file MFT metadata writes and
  change-journal churn during cold walks. On a project of about 783,000 packages with cold access
  times, header reading drops from about 26.2 s to about 7.0 s (worker processing from about
  21.8 s to about 3.0 s) while leaving file access times untouched.
- On Windows, content directory discovery now streams 64 KiB `NtQueryDirectoryFile`
  (`FileFullDirectoryInformation`) batches through a thread-local buffer and header observations
  read size and modification time from the open handle via `GetFileInformationByHandleEx`,
  trimming warm directory enumeration by about 8–9% and avoiding redundant path normalization.
- Large catalog commits now build class and serialized-name postings and encode their directories
  in parallel across bounded key ranges with ~32 MiB batch memory, cutting catalog commit time on
  about 783,000 packages by about 21% (from about 1.93 s to about 1.53 s) with byte-identical
  output.
