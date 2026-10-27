---
"@ue-shed/config-explorer": patch
"@ue-shed/game-text": patch
"@ue-shed/localization": patch
"@ue-shed/niagara": minor
"@ue-shed/plugin-distribution": patch
"@ue-shed/project-custodian": patch
"@ue-shed/protocol": patch
"@ue-shed/world": minor
---

Add the lightweight `@ue-shed/protocol/errors` subpath with the same error schemas as the root export. This entry point is additive. Reuse the shared guidance schemas across libraries and hosts; plugin distribution retains its independent fields with compile-time equality checks.

Breaking: World preparation errors accept only the documented client and editor failure codes. Each code carries its own recovery guidance. Unknown producer codes fail contract decoding.

Breaking: Niagara preview failures now require `nextStep` so hosts retain the next recovery action.

Preserve Niagara session recovery, retry safety and next steps through preview error adaptation. Classify CLI plugin installation failures as input fixes, safe transient retries or escalation. Keep localization guidance host-neutral and add command hints in CLI output.
