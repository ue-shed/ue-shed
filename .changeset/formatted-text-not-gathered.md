---
"@ue-shed/uasset": patch
"@ue-shed/uasset-win32-x64": patch
"@ue-shed/uasset-inspection-wasm": patch
"@ue-shed/game-text": patch
---

Game Text no longer lists text saved as the result of `FText::Format`, such as a graph node's
title, a split pin's label or a Sequencer track's name. Unreal doesn't gather a formatted result,
because it has no text ID; its pattern is gathered where it is defined. Each filled-in result used
to be listed under the pattern's key, so a pattern used with different arguments showed as **Same
key, different text**. Inspection still shows the decoded result.
