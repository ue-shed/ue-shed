---
"@ue-shed/uasset": patch
"@ue-shed/uasset-win32-x64": patch
"@ue-shed/game-text": patch
---

Cancelling a Game Text quality check now stops it promptly, while it prepares its columns, and the
reader stays usable for the next request. Before, a check cancelled during that step could run past
the cancellation deadline, and the reader was restarted. Results of checks that finish are
unchanged.
