# Implementation Plans

Active plans live in this directory. Completed plans are historical records under
[`archive/`](archive/README.md). Do not treat archived plans as living guidance.

Each executor must read the active plan fully before starting, honor its STOP conditions, and update
the status row when done.

## Active

| Plan                                                | Title                                                           | Priority | Effort | Depends on              | Status                          |
| --------------------------------------------------- | --------------------------------------------------------------- | -------- | ------ | ----------------------- | ------------------------------- |
| [007](007-conflicts-rich-types-and-views.md)        | Complete conflicts, rich Unreal types, composites, and views    | P1       | XL     | 006, 015                | IN PROGRESS — demo cutoff       |
| [024](024-establish-ci-and-candidate-releases.md)   | Establish CI, Unreal evidence, and candidate-release provenance | P1       | L      | 020, 021                | IN PROGRESS — first hosted runs |
| [027](027-adopt-parser-in-downstream-host.md)       | Adopt the released parser in the first downstream host          | P1       | M      | 021, 025, 026           | TODO                            |
| [028](028-compose-map-review-downstream.md)         | Compose finished Map Review capabilities downstream             | P2       | XL     | 017, 018, 019, 022, 026 | TODO                            |
| [029](029-authoring-downstream-integration-gate.md) | Gate authoring integration behind finished generic slices       | P2       | L      | 007, 022, 026           | TODO                            |

Status values: `TODO`, `IN PROGRESS`, `DONE`, `BLOCKED` with a one-line reason, or `REJECTED` with a
one-line rationale. When a plan is `DONE`, move it into [`archive/`](archive/) and update both this
table and the archive index.

## Notes for active work

- Plan 019 completed and archived under
  [`archive/019-stream-world-scout-transforms.md`](archive/019-stream-world-scout-transforms.md)
  after the bounded Observatory USOT transform stream, Canvas World Scout, reference budgets,
  real-Unreal lifecycle/bounds/fallback evidence, and Workbench E2E passed on the UE 5.7 fixture.
- Plan 018 completed and archived under
  [`archive/018-pie-live-review-previews.md`](archive/018-pie-live-review-previews.md) after PIE
  posed live BGRA previews, Clear without dirt, Camera Lab overview/actor_pov regression,
  capture-blocked-during-PIE, and no-rehydrate-on-select evidence passed on the UE 5.7 fixture.
- Plan 017 completed and archived under
  [`archive/017-map-review-realization-and-recovery.md`](archive/017-map-review-realization-and-recovery.md)
  after real-Unreal projection evidence and Workbench restart/stale recovery gates passed.
- Plan 007 reached its demo cutoff on 2026-07-17 with engine-proven row references, headless
  relationship reports, and joined read-only product views. Conflict resolution, broad rich-type
  editing, Composite DataTables, editable joins, and final release conformance remain. Continue it on
  the Effect-native services and adoption seam established by archived plans 008–016.
- Plan 007 still depends on archived plans 006 and 015 for prior gates; read those only as history.
- Plans 020–026 establish a public versioned surface in the canonical organization repository.
- Plan 022 makes the Effect Schema convention enforceable at public boundaries. Recursive schemas
  may retain narrowly documented manual declarations only with bidirectional type/fixture tests.
  Completed and archived under [`archive/022-harden-public-contracts.md`](archive/022-harden-public-contracts.md).
- Plan 023 completed the licensing gate with the formula-free `peculiar-sheets@0.11.0` MIT core and
  is archived under
  [`archive/023-separate-formulas-and-license-mit.md`](archive/023-separate-formulas-and-license-mit.md).
- Plan 024 uses hosted CI for portable checks and the owner's trusted Windows UE 5.7 machine only
  for manually dispatched or scheduled Unreal evidence. It must never run untrusted fork PR code.
- Plan 025 intentionally published only protocol, parser library, launcher, and initial Windows
  platform binary. Plan 030 extends the allowlist with `@ue-shed/unreal-connection` and
  `@ue-shed/cameras` only; a package boundary still does not authorize publishing Workbench or every
  workspace.
- Plan 026 completed checksummed GitHub release artifacts and the project-scoped CLI installer, and
  is archived under
  [`archive/026-ship-plugin-bundles-and-installer.md`](archive/026-ship-plugin-bundles-and-installer.md).
  Git/submodules and Fab are not the product dependency baseline.
- Plans 027–029 are downstream coordination plans. The downstream host consumes released UE Shed
  packages/artifacts; UE Shed never imports its Electron UX, studio policy, or custom-UI contracts.
- Plan 028 waits for released Map Review headless packages and Core/Cameras install evidence. Plan
  030 prepared that public boundary at `0.1.0-rc.2` without publishing or claiming Plan 028 DONE,
  and is archived under
  [`archive/030-map-review-public-boundary.md`](archive/030-map-review-public-boundary.md).
  Observatory/observability remain deferred because USOT v1 already ships in protocol and the first
  vertical does not require those packages. Plan 029 is a readiness gate, not permission to migrate
  an unfinished authoring rewrite; Plan 007 remains the generic authoring completion gate.

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
