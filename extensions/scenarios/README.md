# Scenario Studio

A host-neutral, interactive timeline for the portable `@ue-shed/scenarios` document. The experimental
route makes the input-to-outcome ladder visible, supports semantic timing edits and playback preview,
plans checkpoint-backed seeking, and aligns captured evidence and divergence with authored intent.

The seeded Movement Gym document is deliberate dogfood, not proprietary UI state. Workbench merely
composes the extension; headless consumers can inspect and edit the same schema and operations.

Run `pnpm --filter @ue-shed/extension-scenarios dev` for the standalone visual iteration harness.
