# Archived plans

Completed implementation plans. Kept as execution history (intent, STOP conditions, rejected
paths). They are not living guidance — prefer product docs, ADRs, and active plans under
[`../`](../README.md).

| Plan                                                          | Title                                                                | Status                                      |
| ------------------------------------------------------------- | -------------------------------------------------------------------- | ------------------------------------------- |
| [001](001-texture-asset-audit-demo.md)                        | Deliver the first Texture Asset Audit demo end to end                | DONE — landed in `c6156f8`                  |
| [002](002-authoring-boundary-and-grid-gate.md)                | Freeze the product boundary and approve the grid dependency          | DONE                                        |
| [003](003-authoring-contract-and-catalog.md)                  | Establish the authoritative schema and DataTable catalog             | DONE                                        |
| [004](004-authoring-session-service.md)                       | Build the persistent, headless authoring session service             | DONE                                        |
| [005](005-peculiar-sheets-draft-editor.md)                    | Ship the Peculiar Sheets draft editor and Session Review             | DONE                                        |
| [006](006-live-apply-save-pipeline.md)                        | Make Apply and Save safe, recoverable authority transitions          | DONE                                        |
| [008](008-adopt-effect-v4-core.md)                            | Make Effect v4 the repository's application core                     | DONE                                        |
| [009](009-effect-schema-errors-contracts.md)                  | Make schemas and typed errors the only application contracts         | DONE                                        |
| [010](010-effect-infrastructure-services.md)                  | Put every external system behind scoped Effect services              | DONE                                        |
| [011](011-effect-domain-services.md)                          | Make domain workflows Effect services                                | DONE                                        |
| [012](012-effect-cli-runtime.md)                              | Run the CLI as one Effect program                                    | DONE                                        |
| [013](013-effect-workbench-runtime-ipc.md)                    | Make Workbench main and IPC one scoped Effect runtime                | DONE                                        |
| [014](014-effect-renderer-solid.md)                           | Make renderer and extension clients Effect-native                    | DONE                                        |
| [015](015-effect-observability-enforcement.md)                | Close the Effect migration with telemetry and enforcement            | DONE                                        |
| [016](016-data-authoring-adoption-seam.md)                    | Prove the Data Authoring adoption seam                               | DONE                                        |
| [017](017-map-review-realization-and-recovery.md)             | Verify realized framing and recover in-progress Map Review authoring | DONE — UE 5.7 fixture verified              |
| [018](018-pie-live-review-previews.md)                        | PIE live cameras for Map Review authoring previews                   | DONE — UE 5.7 PIE verified                  |
| [019](019-stream-world-scout-transforms.md)                   | Stream actor transforms and render World Scout on Canvas             | DONE — UE 5.7 stream verified               |
| [020](020-restore-green-release-baseline.md)                  | Restore a trustworthy portable release baseline                      | DONE                                        |
| [021](021-consume-published-unreal-rc.md)                     | Consume the published unreal-rc 0.5.3 dependency                     | DONE                                        |
| [022](022-harden-public-contracts.md)                         | Make public TypeScript and Map Review contracts schema-governed      | DONE                                        |
| [023](023-separate-formulas-and-license-mit.md)               | Separate HyperFormula and establish an MIT distribution boundary     | DONE                                        |
| [025](025-publish-parser-package-boundary.md)                 | Publish the minimal parser and protocol package boundary             | DONE — `0.1.0-rc.1` verified                |
| [026](026-ship-plugin-bundles-and-installer.md)               | Ship versioned plugin bundles through the CLI installer              | DONE — UE 5.7.4 verified                    |
| [030](030-map-review-public-boundary.md)                      | Prepare the Map Review headless package boundary                     | DONE — offline consumer verified            |
| [031](031-publish-observatory-boundary.md)                    | Publish the headless Observatory package boundary                    | DONE — `0.1.0-rc.3` packed                  |
| [032](032-decouple-review-visibility-and-invocation.md)       | Decouple Review Views, visibility policy, and capture invocation     | DONE — UE 5.7 and CLI E2E verified          |
| [034](034-build-perforce-map-history.md)                      | Build the Perforce-backed Map History vertical                       | DONE — real Perforce and World Log verified |
| [036](036-split-uasset-inspection-io-and-adopt-effect-cli.md) | Split UAsset inspection and IO, and adopt Effect CLI                 | DONE — portable and UE 5.7 evidence passed  |
| [037](037-deepen-headless-project-index.md)                   | Deepen the headless Project Index with a native Catalog              | DONE — DuckDB cutover and adoption verified |
| [038](038-adjustable-framing-knobs-and-overrides.md)          | Build modular framing rigs and per-view tuning                       | DONE — headless rigs and Workbench verified |
| [039](039-map-review-fixture-and-recordable-flows.md)         | Build Map Review fixture gallery and recordable full flows           | DONE — UE 5.7 flows and recordings verified |
| [040](040-durable-multi-actor-review-sets-and-history.md)     | Build durable multi-actor Review Sets and visual history             | DONE — UE 5.7 history flows verified        |
| [042](042-project-authored-game-text-quality.md)              | Add project-authored Game Text quality rules                         | DONE — CLI and Workbench gates verified     |
| [044](044-map-tile-pyramid.md)                                | Capture generic top-down map tile pyramids                           | DONE — portable and UE 5.7 capture verified |
