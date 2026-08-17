# Project Custodian

## Promise

Project Custodian inventories regeneratable storage beneath an explicit directory without opening
Unreal, explains exactly what a cleanup could reclaim, and executes only an explicitly reviewed,
durable proposal. Trash/Recycle Bin is the default; permanent deletion must be selected before the
proposal is created.

The capability is headless-first. `@ue-shed/project-custodian` owns discovery, policy, freshness,
sizing, planning, proposal persistence, revalidation, execution, cancellation, and receipts;
`ue-shed custodian` and the Workbench route consume that same public service. Deleting Workbench
must leave the complete workflow available to libraries and the CLI.

## Scope and authority

- Every scan has one explicit root and one filesystem. Mounted directories on other volumes are
  reported and skipped so their bytes cannot satisfy the root volume's pressure target.
- Discovery is bounded by depth and prunes known generated, system, and dependency directories.
- `.uproject` descriptors identify projects. `Engine/Build/Build.version` plus build machinery
  identifies engine installations; packaged games are not engines.
- Authored project content, source, configuration, plugin roots, save games, project roots, and
  engine source are never reclaim targets.
- Project-local `.ueclean.json` can opt out, set age/pressure thresholds, keep C++ binaries, or
  select known target keys. Unknown keys fail visibly.
- Freshness combines project and plugin descriptors, project/plugin `Content`, `Source`, and
  `Config` mtimes, and timestamps embedded in rotated Unreal log names.
- Autosaves use the newest file in their own target for the independent 90-day grace period.
- Files with multiple hardlinks are reported but conservatively excluded from reclaim estimates;
  reclaim estimates do not claim storage that another retained name still owns.
- Reports distinguish inventory from a pressure-aware plan. Reports and plans remain evidence only;
  neither is mutation authority.
- Launcher/unmarked engines treat `Engine/Binaries` and `Engine/Intermediate` as protected.
  Source-build versions of those expensive targets remain opt-in and are outside the first UI.

## Destructive boundary

- Preparation accepts target IDs from the current plan, not arbitrary paths, then persists the
  exact paths, sizes, mode, approval phrase, receipt path, and append-only event-log path.
- Execution reads that proposal from disk. It refuses an edited or relocated document, a mismatched
  approval phrase, an active `UnrealEditor`/`UE4Editor` process, or any target whose identity, kind,
  path, eligibility, or measured bytes changed after review.
- Every target is resolved and checked against its scan and owner roots immediately before mutation.
  Authored, protected, symbolic-link, and cross-filesystem paths never become targets through a
  proposal.
- Trash/Recycle Bin is the recoverable default. Permanent deletion is a proposal-level choice and
  cannot be switched at execution time.
- Cancellation is cooperative between target operations. Completed work remains completed, queued
  work is marked cancelled, and the receipt records every outcome.
- A durable receipt and JSON-lines event log cover completed, partial, cancelled, and refused runs.

## Public result

A schema-versioned result includes the scan root, measured time, free bytes, total reclaimable bytes,
project and engine reports, target sizes and rebuild costs, safety refusals, diagnostics, and a
largest-first plan. Each project carries its effective policy and eligibility reason so clients do
not reconstruct policy from presentation fields. Proposal and receipt schemas are also public,
versioned contracts.

## First showcase

- `ue-shed custodian report <root>` prints the complete JSON inventory.
- `ue-shed custodian plan <root>` prints the same evidence with its pressure-aware dry-run plan.
- `ue-shed custodian prepare <root> --target <id> --output <directory>` persists a reviewable
  proposal, and `ue-shed custodian apply <proposal> --approve <phrase>` revalidates and executes it.
- Workbench `#/project-custodian` lets the user choose a root, then presents reclaimed-space scale,
  protected/refused state, target composition, exact queue selection, approval, cancellation, and
  receipt evidence.

The behavior was informed by the MIT-licensed
[`unreal-custodian`](https://github.com/ibrews/unreal-custodian) project as product research. UE Shed
owns a clean implementation and does not copy its Python/Tk architecture.
