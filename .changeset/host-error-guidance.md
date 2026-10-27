---
"@ue-shed/cli": patch
"@ue-shed/site": patch
"@ue-shed/workbench": patch
"@ue-shed/extension-asset-audits": patch
"@ue-shed/extension-camera-review": patch
"@ue-shed/extension-content-observatory": patch
"@ue-shed/extension-game-text": patch
"@ue-shed/extension-input-atlas": patch
"@ue-shed/extension-niagara-preview": patch
"@ue-shed/extension-project-custodian": patch
"@ue-shed/extension-scenarios": patch
"@ue-shed/enhanced-input": minor
"@ue-shed/ui": patch
---

Breaking: Enhanced Input reports malformed scan options as `invalid_options` and requires `nextStep` on public failures. Preserve recovery decisions through host and transport adapters and share the protocol error guidance schemas. CLI plugin installation failures distinguish input fixes, transient safe retries and escalation. CLI localization output retains command hints while libraries use host-neutral guidance.
