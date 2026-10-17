---
"@ue-shed/engine": minor
"@ue-shed/world": minor
"@ue-shed/plugin-distribution": minor
"@ue-shed/localization": minor
"@ue-shed/observatory": minor
"@ue-shed/niagara": minor
"@ue-shed/config-explorer": minor
"@ue-shed/map-history": minor
"@ue-shed/project-custodian": minor
"@ue-shed/protocol": minor
---

**Breaking:** the remaining packages' tagged errors gain the shared guidance shape from the first D4 slice: `message`, `recovery`, `retrySafe` and a typed `nextStep` (`"fix_input" | "retry" | "reconcile" | "escalate"`) beside their existing context fields. `nextStep: "retry"` appears only when `retrySafe` is true.

Migration: read `nextStep` instead of parsing `message`. Code that constructs these errors itself (test doubles, custom layers) must pass `recovery`, `retrySafe` and `nextStep` where they are new.

- Indeterminate session Apply failures require `reconcileSession` even when a lower-level port can safely replay a request. Pre-dispatch connection failures, Apply-result lookup and repeat-safe pending Save recovery retain their own guidance.
- Compiled plugin builds require confirmed owned-process cleanup before advertising a safe repeat. Failed cleanup reports reconciliation and retains the termination failure; pure validation failures remain repeat-safe.
- World preparation lease identity conflicts require reconciliation instead of retrying unchanged acquisition requirements.
- Editor readiness preserves the prior slice's recovery actions and retry policy. Newly merged domain-parser errors also adopt the guidance fields.
