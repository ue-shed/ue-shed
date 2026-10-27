---
"@ue-shed/game-text": minor
---

`GameTextWorkspaceContract`, from `@ue-shed/game-text/schema`, is the browser-safe contract of the Game Text workspace: for each `GameTextWorkspaceApi` method a host serves, its params and success schemas, and for `progressChanges` the schema of each event. It names no channels, so a host maps each method to its own IPC, WebSocket or MCP transport, decodes the params and calls the method with them. Methods that only run inside the host (operation admission, `localizationBeforeGather` and `configuredScan`) are left out and listed in its doc comment. The workspace no longer compiles if a method and its entry disagree.

Breaking: every method the contract describes takes at most one argument. `configuredRefresh(refresh?)` is now `configuredRefresh({ refresh? })`, `createStarterRules(loadExisting)` is now `createStarterRules({ loadExisting })`, and `investigationExport(query, format)` is now `investigationExport({ query, format })`.
