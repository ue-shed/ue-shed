---
"@ue-shed/enhanced-input": minor
"@ue-shed/cli": minor
"@ue-shed/extension-input-atlas": minor
---

Enhanced Input scan schema 2 and usage and conflict analysis. Actions, mappings and contexts gain
the saved properties the scan skipped, as optional evidence; triggers and modifiers carry their
saved parameters, so a chord is an action-to-action edge. Player mappable input config assets are
projected, so a project with one no longer reports a false `unsupported_asset` and a partial scan.
Schema 1 reports still decode. Co-activation sets from the project's default contexts, config
assets or a host document classify contested keys as shadowed, ambiguous priority, qualified or
cross-context; without one, only contested is claimed. New `ue-shed input atlas`, `conflicts`,
`unused`, `platforms` and `export` commands, and the Input Atlas route gains a conflict-class
filter and an in-project platform view.
