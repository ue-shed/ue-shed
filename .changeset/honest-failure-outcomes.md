---
"@ue-shed/plugin-distribution": patch
"@ue-shed/cameras": patch
---

Failures no longer read as success or as something they are not:

- **Plugin store:**
    - A lease that cannot be read, or is still being written, keeps its release from being pruned. Only a lease that stays undecodable for 30 seconds is treated as abandoned.
    - A cache lock that cannot be read is treated as held.
- **Resuming a review authoring session:** the Review Set is reported missing only when its file is gone. A Review Set that cannot be read or does not decode fails with its own reason and recovery, so a recoverable session is not discarded.
