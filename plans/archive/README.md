# Archived plans

Completed implementation plans. Kept as execution history (intent, STOP conditions, rejected
paths). They are not living guidance — prefer product docs, ADRs, and active plans under
[`../`](../README.md).

| Plan                                              | Title                                                                | Status                         |
| ------------------------------------------------- | -------------------------------------------------------------------- | ------------------------------ |
| [001](001-texture-asset-audit-demo.md)            | Deliver the first Texture Asset Audit demo end to end                | DONE — landed in `c6156f8`     |
| [002](002-authoring-boundary-and-grid-gate.md)    | Freeze the product boundary and approve the grid dependency          | DONE                           |
| [003](003-authoring-contract-and-catalog.md)      | Establish the authoritative schema and DataTable catalog             | DONE                           |
| [004](004-authoring-session-service.md)           | Build the persistent, headless authoring session service             | DONE                           |
| [005](005-peculiar-sheets-draft-editor.md)        | Ship the Peculiar Sheets draft editor and Session Review             | DONE                           |
| [006](006-live-apply-save-pipeline.md)            | Make Apply and Save safe, recoverable authority transitions          | DONE                           |
| [008](008-adopt-effect-v4-core.md)                | Make Effect v4 the repository's application core                     | DONE                           |
| [009](009-effect-schema-errors-contracts.md)      | Make schemas and typed errors the only application contracts         | DONE                           |
| [010](010-effect-infrastructure-services.md)      | Put every external system behind scoped Effect services              | DONE                           |
| [011](011-effect-domain-services.md)              | Make domain workflows Effect services                                | DONE                           |
| [012](012-effect-cli-runtime.md)                  | Run the CLI as one Effect program                                    | DONE                           |
| [013](013-effect-workbench-runtime-ipc.md)        | Make Workbench main and IPC one scoped Effect runtime                | DONE                           |
| [014](014-effect-renderer-solid.md)               | Make renderer and extension clients Effect-native                    | DONE                           |
| [015](015-effect-observability-enforcement.md)    | Close the Effect migration with telemetry and enforcement            | DONE                           |
| [016](016-data-authoring-adoption-seam.md)        | Prove the Data Authoring adoption seam                               | DONE                           |
| [017](017-map-review-realization-and-recovery.md) | Verify realized framing and recover in-progress Map Review authoring | DONE — UE 5.7 fixture verified |
| [020](020-restore-green-release-baseline.md)      | Restore a trustworthy portable release baseline                      | DONE                           |
| [021](021-consume-published-unreal-rc.md)         | Consume the published unreal-rc 0.5.3 dependency                     | DONE                           |
| [022](022-harden-public-contracts.md)             | Make public TypeScript and Map Review contracts schema-governed      | DONE                           |
| [023](023-separate-formulas-and-license-mit.md)   | Separate HyperFormula and establish an MIT distribution boundary     | DONE                           |
| [025](025-publish-parser-package-boundary.md)     | Publish the minimal parser and protocol package boundary             | DONE — `0.1.0-rc.1` verified   |
| [026](026-ship-plugin-bundles-and-installer.md)   | Ship versioned plugin bundles through the CLI installer              | DONE — UE 5.7.4 verified       |
