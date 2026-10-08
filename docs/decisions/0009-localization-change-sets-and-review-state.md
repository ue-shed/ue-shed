# 0009: Localization change sets and review state

## Status

Accepted by the owner for Plan 051 on 2026-10-07. It refines the localization stance in
[`docs/ideas/game-text-workbench.md`](../ideas/game-text-workbench.md).

## Context

Game Text already reads the project's saved text without Unreal. Plan 051 extends it to
translations. Teams need to edit translations quickly and track review state, such as reviewed,
proofread, approved and machine translated. Unreal does not provide either the way a localization
team works.

The Game Text vision already says that translation edits are staged and written to the PO file, then
imported and compiled by Unreal. It also says that manifests, archives, `.locres` and `.locmeta` are
evidence, not editing authorities. A direct archive writer was proposed because each PO import costs
a commandlet run of minutes. Unreal itself edits archives through `FLocTextHelper`.

Reading the UE 4.27, 5.7 and 5.8 source settled the facts:

- **PO import overwrites the archive.** `PortableObjectPipeline::Import` writes a PO entry's
  `msgstr` into the archive whenever it differs from the archive's translation. An archive edit that
  is not also in the PO file is reverted by the next import.
- **PO export regenerates the file from the archives.** Entry flags such as `fuzzy` are read on
  import but never written. Translator comments survive only with `ShouldPersistCommentsOnExport`,
  and only while the entry's `msgid` and `msgctxt` stay unchanged.
- **Archive metadata is not durable.** Archive entries accept arbitrary metadata, and gather keeps it
  for foreign cultures. But a PO import or a Translation Editor save of a changed entry rebuilds it
  without metadata. Metadata on the source object also changes Unreal's exact-match outdated check.
- **Unreal stores no review state.** The Translation Editor's "Untranslated", "Needs Review" and
  "Completed" tabs are recomputed on load from archive contents and revision history.
- **One rule defines outdated.** A translation is outdated when its archive entry's recorded
  source differs from the manifest source. The `.locres` compiler then uses the source text instead,
  unless `bSkipSourceCheck` is set.
- **Writing the PO file is the slow part only in appearance.** A PO write is a local file write.
  What costs minutes is Unreal's import and compile, and those can be batched.

## Decision

### A translation edit is a change set

UE Shed models translation edits as a versioned, schema-validated change set. Each change records:

- the target, culture, namespace and key;
- the source text it translates, taken from current evidence;
- the translation it replaces, or its absence; and
- the new translation.

A writer applies a change set only after revalidating every change against current evidence. A
changed source or translation rejects that change as stale. A writer returns a receipt that names
each change's result and the files it wrote.

### Writers

Two writers are allowed:

1. **The PO writer** is the default and needs no engine. It rewrites only the affected `msgstr`
   values of `<culture>/<Target>.po` atomically. It preserves the header, comments, flags, entry
   order, line endings, encoding and byte order mark. Synchronizing then asks Unreal to import and
   compile the target, as a separate step that can be batched.
2. **The editor writer** is optional. It lives in a UE Shed editor plugin and applies the same
   change set through `FLocTextHelper`. It then has Unreal export the PO and compile `.locres`, so
   the PO file and the archive never disagree.

UE Shed's TypeScript and Rust code never write a manifest, archive, `.locres` or `.locmeta`. A
direct archive writer is rejected. Unless the PO file is also rewritten, the next PO import silently
reverts the archive edit, so a direct writer has to own both files anyway. Doing that outside Unreal
copies Unreal's archive format and its outdated-source rules.

### Review state lives in a project file

Review state lives in one versioned JSON file per target, inside the project and under source
control. Records are keyed by culture, namespace and key. Each record stores:

- its flags;
- the person or tool that set them, and when; and
- a fingerprint of the source and translation the flags were set against.

When the fingerprint no longer matches the evidence, the record shows as changed since review
rather than still reviewed. Accepted duplicates and dismissed findings use the same file, keyed by
the finding's stable evidence. The file is sorted by key so that diffs and merges stay small.

PO flags, PO comments and archive metadata are rejected as homes for review state, because Unreal
does not round-trip them.

### Source control

Writers and Unreal operations report the files they may write before they run. UE Shed never passes
`-EnableSCC` and never submits. Hosts own checkout and submission.

## Consequences

- The Game Text vision's PO-first stance is kept and made precise. The only change is that an
  editor plugin may apply translations through Unreal's own archive APIs. That counts as Unreal
  writing, not UE Shed.
- Without an engine, an edit appears at once as "Not synced". It reaches archives and `.locres`
  after a sync. Every host must show unsynced translations clearly: per line and culture, as a
  total beside the sync action, as a filter, and in CLI status and reports.
- Projects that export PO in Crowdin format have no source text in their PO files. For those
  projects, stale detection relies on the archive alone, and the PO writer reports reduced checking.
- The review file is new UE Shed-owned project data. It needs a schema version, migration rules and
  merge-friendly formatting from its first release.
- Machine translation is a review flag set by whoever wrote the translation. Integrating a
  translation service is a separate decision.
