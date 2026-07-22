# Implementation Plans

Active plans live in this directory. Completed plans are historical records under
[`archive/`](archive/README.md). Do not treat archived plans as living guidance.

Each executor must read the active plan fully before starting, honor its STOP conditions, and update
the status row when done.

## Active

| Plan                                                | Title                                                                | Priority | Effort | Depends on              | Status                    |
| --------------------------------------------------- | -------------------------------------------------------------------- | -------- | ------ | ----------------------- | ------------------------- |
| [007](007-conflicts-rich-types-and-views.md)        | Complete conflicts, rich Unreal types, composites, and views         | P1       | XL     | 006, 015                | IN PROGRESS — demo cutoff |
| [017](017-map-review-realization-and-recovery.md)   | Verify realized framing and recover in-progress Map Review authoring | P0       | L      | —                       | TODO                      |
| [018](018-pie-live-review-previews.md)              | PIE live cameras for Map Review authoring previews                   | P0       | L      | —                       | IN PROGRESS               |
| [019](019-stream-world-scout-transforms.md)         | Stream actor transforms and render World Scout on Canvas             | P1       | XL     | 018                     | IN PROGRESS               |
| [023](023-separate-formulas-and-license-mit.md)     | Separate HyperFormula and establish an MIT distribution boundary     | P0       | L      | 020                     | TODO                      |
| [024](024-establish-ci-and-candidate-releases.md)   | Establish CI, Unreal evidence, and candidate-release provenance      | P1       | L      | 020, 021                | TODO                      |
| [025](025-publish-parser-package-boundary.md)       | Publish the minimal parser and protocol package boundary             | P1       | L      | 022, 023, 024           | TODO                      |
| [026](026-ship-plugin-bundles-and-installer.md)     | Ship versioned plugin bundles through the CLI installer              | P1       | L      | 023, 024, 025           | TODO                      |
| [027](027-adopt-parser-in-downstream-host.md)       | Adopt the released parser in the first downstream host               | P1       | M      | 021, 025, 026           | TODO                      |
| [028](028-compose-map-review-downstream.md)         | Compose finished Map Review capabilities downstream                  | P2       | XL     | 017, 018, 019, 022, 026 | TODO                      |
| [029](029-authoring-downstream-integration-gate.md) | Gate authoring integration behind finished generic slices            | P2       | L      | 007, 022, 026           | TODO                      |

Status values: `TODO`, `IN PROGRESS`, `DONE`, `BLOCKED` with a one-line reason, or `REJECTED` with a
one-line rationale. When a plan is `DONE`, move it into [`archive/`](archive/) and update both this
table and the archive index.

## Notes for active work

- Plan 018 unlocks live BGRA authoring previews while PLAY is active by registering transient posed
  camera sources in PIE. Editor-stopped Keep/Capture stays on PNG. It complements 017 and must not
  break Camera Lab’s placed-camera path.
- Plan 019 replaces high-rate full-world JSON polling with a bounded Observatory transform stream
  and retained Canvas renderer. It waits for 018 because both touch the Workbench Map Review service
  and IPC surface; 019 must begin from 018's committed result rather than overwrite active work.
- Plan 017 completes the remaining Map Review Slice 2 trust and recovery work before Slice 3 adds
  capture-profile, readiness, cancellation, and restoration policy. Leave its status as TODO until
  the manual review gate passes.
- Plan 007 reached its demo cutoff on 2026-07-17 with engine-proven row references, headless
  relationship reports, and joined read-only product views. Conflict resolution, broad rich-type
  editing, Composite DataTables, editable joins, and final release conformance remain. Continue it on
  the Effect-native services and adoption seam established by archived plans 008–016.
- Plan 007 still depends on archived plans 006 and 015 for prior gates; read those only as history.
- Plans 020–026 establish a public versioned surface. They do not authorize merging, pushing, or
  targeting main while the judging freeze remains in force.
- Plan 022 makes the Effect Schema convention enforceable at public boundaries. Recursive schemas
  may retain narrowly documented manual declarations only with bidirectional type/fixture tests.
  Completed and archived under [`archive/022-harden-public-contracts.md`](archive/022-harden-public-contracts.md).
- Plan 023 is a licensing gate. HyperFormula cannot be relicensed through ownership of Peculiar
  Sheets; UE Shed must use an independently MIT core with no formula-engine dependency.
- Plan 024 uses hosted CI for portable checks and the owner's trusted Windows UE 5.7 machine only
  for manually dispatched or scheduled Unreal evidence. It must never run untrusted fork PR code.
- Plan 025 intentionally publishes only protocol, parser library, launcher, and initial Windows
  platform binary. A package boundary does not authorize publishing Workbench or every workspace.
- Plan 026 delivers plugins as checksummed GitHub release artifacts installed by the CLI under a
  project. Git/submodules and Fab are not the product dependency baseline.
- Plans 027–029 are downstream coordination plans. The downstream host consumes released UE Shed
  packages/artifacts; UE Shed never imports its Electron UX, studio policy, or custom-UI contracts.
- Plan 028 waits for active Map Review Plans 017–019 to be done and released. Plan 029 is a
  readiness gate, not permission to migrate an unfinished authoring rewrite; Plan 007 remains the
  generic authoring completion gate.

## Findings considered and rejected

- Start with Audio Audit: rejected for the first demo because source-audio association and loudness
  analysis add new boundaries before the common audit interaction has been proven.
- Start with Asset Lookbook: rejected for the first demo because useful thumbnail extraction is not
  yet part of the saved-asset contract.
- Infer missing Texture2D defaults in the first slice: rejected because absent serialized properties
  do not by themselves prove an effective value.
- Build automatic texture repair: rejected because the product vision requires read-only evidence and
  deliberate remediation, and safe mutation is a separate authoring workflow.
- Continue growing the bespoke CSS grid: rejected because spreadsheet interaction, virtualization,
  selection, and batch editing are already the purpose of Peculiar Sheets.
- Copy Electroswag's renderer or session store: rejected because those files couple grid, RPC, views,
  dialogs, and custom UI, which would make Workbench a privileged architecture layer.
- Ship formulas or HyperFormula: rejected because DataTable authoring has no formula requirement.
- Promise arbitrary studio-authored/custom UI hosting: deferred indefinitely. The roadmap supports
  the maintained extension, CLI, and a trusted host-neutral client contract; it does not build an
  isolation, grants, publishing, or generated-UI platform.
- Allow Apply before validation, drift checks, and indeterminate-operation recovery exist: rejected
  because it can duplicate or ambiguously report live mutations.
- Treat “functional” as a reason to preserve Promise/manual orchestration outside Effect: rejected.
  Functional programming is the default style—immutable values, pure functions, algebraic data
  types, and composition—with Effect as the runtime for workflows, dependencies, state, failures,
  concurrency, resources, telemetry, and tests.
- Wrap every byte-level operation in Effect by default: rejected. The camera decoder/presentation
  loop is the only current hot-path candidate, and even it requires benchmark evidence; resource
  ownership, buffering, streams, cleanup, and observability remain Effect-native.
