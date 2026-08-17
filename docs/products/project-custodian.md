# Project Custodian

## Promise

Project Custodian inventories regeneratable storage beneath an explicit directory without opening
Unreal and explains exactly what a later cleanup could reclaim. The first slice is deliberately
read-only: it reports and plans, but exposes no deletion operation.

The capability is headless-first. `@ue-shed/project-custodian` owns discovery, policy, freshness,
sizing, and planning; `ue-shed custodian` and the Workbench route consume the same public report.
Deleting Workbench must leave the complete inventory and planning workflow available to libraries
and the CLI.

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
  the read-only slice cannot prove that every retained name would be removed.
- Reports distinguish inventory from a pressure-aware plan. A plan is still evidence only and
  performs no filesystem mutation.
- Launcher/unmarked engines treat `Engine/Binaries` and `Engine/Intermediate` as protected.
  Source-build versions of those expensive targets remain opt-in and are outside the first UI.

## Public result

A schema-versioned result includes the scan root, measured time, free bytes, total reclaimable bytes,
project and engine reports, target sizes and rebuild costs, safety refusals, diagnostics, and a
largest-first plan. Each project carries its effective policy and eligibility reason so clients do
not reconstruct policy from presentation fields.

## First showcase

- `ue-shed custodian report <root>` prints the complete JSON inventory.
- `ue-shed custodian plan <root>` prints the same evidence with its pressure-aware dry-run plan.
- Workbench `#/project-custodian` lets the user choose a root, then presents reclaimed-space scale,
  protected/refused state, target composition, and the exact dry-run queue.

## Deferred destructive boundary

Trash/Recycle Bin execution, permanent deletion, live-editor process guards, cancellation during a
clean, durable logs, and recovery UI require a separate product increment. They must re-resolve and
revalidate every target immediately before mutation; a previously rendered plan is never deletion
authority.

The behavior was informed by the MIT-licensed `unreal-custodian` project as product research. UE Shed
owns a clean implementation and does not copy its Python/Tk architecture.
