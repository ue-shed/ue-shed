# Archived plans

Completed implementation plans. Kept as execution history (intent, STOP conditions, rejected
paths). They are not living guidance — prefer product docs, ADRs, and active plans under
[`../`](../README.md).

- [Headless Blueprint package](headless-blueprints-package.md) — DONE; public graph navigation,
  search, reference layout and saved display helpers, with the Solid viewer kept in Workbench;
  full local, packed-consumer, UE 5.7/5.8 and offline showcase checks passed.

- [Saved actor/component native records](saved-actor-component-native-data.md) — DONE; checked
  inherited records, construction-script member references, conditional scene flags and public
  native evidence, with independent UE 5.7/5.8 and offline native/WASM conformance.

- [Next five saved Blueprint and Sequencer targets](saved-blueprint-sequencer-next-five.md) — DONE;
  section settings, scoped camera cuts/bindings, string/object channels, variable/CDO evidence and
  component hierarchies/templates, with UE 5.7/5.8 and offline native/WASM conformance.

- [Discrete Sequencer channels](sequencer-discrete-channels.md) — DONE; saved bool, integer,
  byte/enum and visibility channels, boolean container decoding, and UE 5.7/5.8 conformance.

- [Blueprint and Sequencer review](saved-graph-and-sequence-review.md) — DONE; public readers and
  comparisons, CLI, offline viewers and reference navigation, with fresh UE 5.7/5.8 conformance.

- [Property bags and animation summaries](uasset-property-bags-and-animation.md) — DONE;
  custom-versioned bags, saved animation inventory, CLI/WASM contracts, and UE 5.7/5.8 conformance.

- [Native parser increment](uasset-native-increment.md) — DONE; numeric Sequencer projections,
  GameplayTagContainer, and common math properties with Unreal evidence and native/WASM parity.

- [UAsset source-model rollout](uasset-source-model-rollout.md) — DONE; default native and WASM
  integration, optimized embedded model, full local gate, and fresh Unreal conformance.

- [Expanded native UAsset coverage](uasset-native-coverage.md) — DONE; curves, skeleton poses,
  numeric channels, InstancedStruct, and package metadata through shared native layouts.

- [Shared camera rendering](shared-camera-rendering-api.md) — DONE; released in 0.7.0. Review and
  all map modes share native ownership and rendering; the plan links the public contract, adoption
  guidance, and live validation report.

- [Shared world preparation](world-preparation.md) — DONE; scoped actor context, region loading,
  readiness evidence, camera composition and headless CLI.

| Plan                                                          | Title                                                                | Status                                                        |
| ------------------------------------------------------------- | -------------------------------------------------------------------- | ------------------------------------------------------------- |
| [056](056-localization-at-real-project-scale.md)              | Game Text localization at real-project scale                         | DONE — portable gate, UE 5.7/5.8 lane and a real project read |
| [055](055-editor-foreground-responsiveness.md)                | Keep Unreal responsive while UE Shed is in the foreground            | DONE — portable and UE 5.7/5.8 live lanes passed              |
| [051](051-localization-workspace.md)                          | Build the Game Text localization workspace                           | DONE — portable gate and UE 5.7/5.8/4.27 lanes passed         |
| [050](050-legacy-property-tags.md)                            | Read legacy property tags for Game Text back to UE 4.27              | DONE — UE 4.27/5.3 fixtures and UE 5.7/5.8 matrix passed      |
| [049](049-camera-authoring-and-actor-culling.md)              | Author cameras in Unreal and persist explicit actor culling          | DONE — local portable and Unreal gates passed                 |
| [048](048-fresh-scan-performance.md)                          | Optimize fresh Catalog scans from the current baseline               | DONE — measured and validated                                 |
| [047](047-full-flow-performance.md)                           | Measure and optimize the complete project flow                       | DONE — measured and validated                                 |
| [001](001-texture-asset-audit-demo.md)                        | Deliver the first Texture Asset Audit demo end to end                | DONE — landed in `c6156f8`                                    |
| [002](002-authoring-boundary-and-grid-gate.md)                | Freeze the product boundary and approve the grid dependency          | DONE                                                          |
| [003](003-authoring-contract-and-catalog.md)                  | Establish the authoritative schema and DataTable catalog             | DONE                                                          |
| [004](004-authoring-session-service.md)                       | Build the persistent, headless authoring session service             | DONE                                                          |
| [005](005-peculiar-sheets-draft-editor.md)                    | Ship the Peculiar Sheets draft editor and Session Review             | DONE                                                          |
| [006](006-live-apply-save-pipeline.md)                        | Make Apply and Save safe, recoverable authority transitions          | DONE                                                          |
| [008](008-adopt-effect-v4-core.md)                            | Make Effect v4 the repository's application core                     | DONE                                                          |
| [009](009-effect-schema-errors-contracts.md)                  | Make schemas and typed errors the only application contracts         | DONE                                                          |
| [010](010-effect-infrastructure-services.md)                  | Put every external system behind scoped Effect services              | DONE                                                          |
| [011](011-effect-domain-services.md)                          | Make domain workflows Effect services                                | DONE                                                          |
| [012](012-effect-cli-runtime.md)                              | Run the CLI as one Effect program                                    | DONE                                                          |
| [013](013-effect-workbench-runtime-ipc.md)                    | Make Workbench main and IPC one scoped Effect runtime                | DONE                                                          |
| [014](014-effect-renderer-solid.md)                           | Make renderer and extension clients Effect-native                    | DONE                                                          |
| [015](015-effect-observability-enforcement.md)                | Close the Effect migration with telemetry and enforcement            | DONE                                                          |
| [016](016-data-authoring-adoption-seam.md)                    | Prove the Data Authoring adoption seam                               | DONE                                                          |
| [017](017-map-review-realization-and-recovery.md)             | Verify realized framing and recover in-progress Map Review authoring | DONE — UE 5.7 fixture verified                                |
| [018](018-pie-live-review-previews.md)                        | PIE live cameras for Map Review authoring previews                   | DONE — UE 5.7 PIE verified                                    |
| [019](019-stream-world-scout-transforms.md)                   | Stream actor transforms and render World Scout on Canvas             | DONE — UE 5.7 stream verified                                 |
| [020](020-restore-green-release-baseline.md)                  | Restore a trustworthy portable release baseline                      | DONE                                                          |
| [021](021-consume-published-unreal-rc.md)                     | Consume the published unreal-rc 0.5.3 dependency                     | DONE                                                          |
| [022](022-harden-public-contracts.md)                         | Make public TypeScript and Map Review contracts schema-governed      | DONE                                                          |
| [023](023-separate-formulas-and-license-mit.md)               | Separate HyperFormula and establish an MIT distribution boundary     | DONE                                                          |
| [025](025-publish-parser-package-boundary.md)                 | Publish the minimal parser and protocol package boundary             | DONE — `0.1.0-rc.1` verified                                  |
| [026](026-ship-plugin-bundles-and-installer.md)               | Ship versioned plugin bundles through the CLI installer              | DONE — UE 5.7.4 verified                                      |
| [030](030-map-review-public-boundary.md)                      | Prepare the Map Review headless package boundary                     | DONE — offline consumer verified                              |
| [031](031-publish-observatory-boundary.md)                    | Publish the headless Observatory package boundary                    | DONE — `0.1.0-rc.3` packed                                    |
| [032](032-decouple-review-visibility-and-invocation.md)       | Decouple Review Views, visibility policy, and capture invocation     | DONE — UE 5.7 and CLI E2E verified                            |
| [034](034-build-perforce-map-history.md)                      | Build the Perforce-backed Map History vertical                       | DONE — real Perforce and World Log verified                   |
| [036](036-split-uasset-inspection-io-and-adopt-effect-cli.md) | Split UAsset inspection and IO, and adopt Effect CLI                 | DONE — portable and UE 5.7 evidence passed                    |
| [037](037-deepen-headless-project-index.md)                   | Deepen the headless Project Index with a native Catalog              | DONE — DuckDB cutover and adoption verified                   |
| [038](038-adjustable-framing-knobs-and-overrides.md)          | Build modular framing rigs and per-view tuning                       | DONE — headless rigs and Workbench verified                   |
| [039](039-map-review-fixture-and-recordable-flows.md)         | Build Map Review fixture gallery and recordable full flows           | DONE — UE 5.7 flows and recordings verified                   |
| [040](040-durable-multi-actor-review-sets-and-history.md)     | Build durable multi-actor Review Sets and visual history             | DONE — UE 5.7 history flows verified                          |
| [042](042-project-authored-game-text-quality.md)              | Add project-authored Game Text quality rules                         | DONE — CLI and Workbench gates verified                       |
| [044](044-map-tile-pyramid.md)                                | Capture generic top-down map tile pyramids                           | DONE — portable and UE 5.7 capture verified                   |
| [045](045-project-custodian-read-only-slice.md)               | Inventory and plan reclaimable Unreal workspace storage              | DONE — read-only CLI and Workbench verified                   |
| [043](043-config-explorer-settings-archaeology.md)            | Explain saved Unreal configuration provenance                        | DONE — CLI, extension and Workbench verified                  |
| [046](046-niagara-preview.md)                                 | Publish portable Niagara preview runs                                | DONE — portable and UE 5.7 render verified                    |
