# Implementation Plans

Active plans live in this directory. Completed plans are historical records under
[`archive/`](archive/README.md). Do not treat archived plans as living guidance.

Each executor must read the active plan fully before starting, honor its STOP conditions, and update
the status row when done.

## Active

| Plan                                              | Title                                                                | Priority | Effort | Depends on | Status                    |
| ------------------------------------------------- | -------------------------------------------------------------------- | -------- | ------ | ---------- | ------------------------- |
| [007](007-conflicts-rich-types-and-views.md)      | Complete conflicts, rich Unreal types, composites, and views         | P1       | XL     | 006, 015   | IN PROGRESS — demo cutoff |
| [017](017-map-review-realization-and-recovery.md) | Verify realized framing and recover in-progress Map Review authoring | P0       | L      | —          | TODO                      |
| [018](018-pie-live-review-previews.md)            | PIE live cameras for Map Review authoring previews                   | P0       | L      | —          | IN PROGRESS               |
| [019](019-stream-world-scout-transforms.md)       | Stream actor transforms and render World Scout on Canvas             | P1       | XL     | 018        | IN PROGRESS               |

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
