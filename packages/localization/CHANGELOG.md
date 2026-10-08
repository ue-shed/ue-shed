# @ue-shed/localization

## 0.10.0

### Minor Changes

- 8d812df: Add pure Unreal localization quality checks, provenance-bearing version-1 change-set proposals,
  and `ue-shed loc check` with optional exclusive proposal JSON creation.
- f66ac19: Plan and run Unreal localization recipes with owned process trees, bounded progress, cancellation,
  private failure logs and audited write receipts. Support UE 4.27 commandlet executable naming and
  headless CLI operation planning, including import-then-compile sync.
- bdbcaec: Add read-only Unreal localization target discovery, bounded saved-file evidence, pure format
  decoders, and byte-preserving PO serialization for Unreal 4.27, 5.7 and 5.8 layouts.
- 64976b1: Track localization review state in a project-owned review file per target. Records keep reviewed,
  proofread, approved and machine translated flags against a fingerprint of the source and the
  translation that ships next, so later edits read as changed since review. Game Text adds review
  lenses, accepted check findings and reviewed and proofread report shares.
- 271dcd1: Write reviewed translation change sets into PO files. Changes are revalidated against fresh
  evidence: the source must match the manifest, and the replaced translation must match what ships
  next. Only the edited `msgstr` values change, through an atomic, hash-guarded replace. Game Text
  adds browser-safe edit request and result schemas for hosts that stage edits.

### Patch Changes

- Updated dependencies [f66ac19]
- Updated dependencies [5fd5bc7]
    - @ue-shed/engine@0.10.0
    - @ue-shed/config-explorer@0.10.0
