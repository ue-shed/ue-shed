---
"@ue-shed/unreal-assets": patch
"@ue-shed/uasset": patch
"@ue-shed/uasset-win32-x64": patch
---

Project Index status no longer starts a process for each check. The `uasset` protocol session now
answers `project_index_status`, and the process-backed `ProjectIndex` reads status through its
existing reader session, falling back to a one-off process for an older reader.
