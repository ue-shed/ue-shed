# Feature easy wins (2026-10-21)

> Status: ranked catalog of near-term feature candidates, grounded in the code at the head of PR
> #156. Not commitments. An entry graduates to a product contract or plan when someone takes it.

The [ranked catalog](catalog.md) and the vision documents ask where UE Shed could go. This one asks a
narrower question: **what is already nearly there?** Each entry below reuses evidence or machinery
the repository already produces, and needs mostly composition or one thin projection, not a new
subsystem. Every claim cites the code or the Unreal source it rests on.

It does not repeat the existing ideas. Where an entry is a first slice of one, it links to it:
[project cartography and the janitor](catalog.md#4-project-cartography),
[content observatory](content-observatory.md), [asset audits](asset-audits.md),
[asset lookbook](asset-lookbook.md), and the
[input atlas](catalog.md#16-input-atlas).

## How to read this

- **Effort.** S is one focused pull request. M is one lane of roughly one to two weeks across two or
  three packages. L is multi-week and needs an ADR because it changes a persisted or wire format.
- **Unreal dependency.** _Saved-only_ means the saved packages and project files are enough: no
  editor, no plugin. _Live_ means a connected editor and a separately enabled UE Shed plugin.
- **Verification.** Unreal source was read from this machine's UE 5.7 `Engine/Source`. There is no
  UE 5.8 install here, so nothing below was checked against 5.8. Any entry that touches engine
  formats or APIs needs the 5.7 and 5.8 check in [AGENTS.md](../../AGENTS.md) before it ships.
- **Rules every entry follows.** Headless library first, CLI next, Workbench as a showcase client.
  The Workbench shell owns project selection. Judgment (thresholds, roots, mounts, severities) is a
  host or project-authored document, never a constant
  ([base, not constraints](../vision-and-architecture.md#base-not-constraints)). Unreal owns writes
  ([Unreal owns content writes](../vision-and-architecture.md#unreal-owns-content-writes)), so
  headless code reports and plans and never repairs. Nothing here names a studio project.

## Ranked top list

Ranked by value for effort. Entries 2, 5 and 6 are foundations: several other entries wait on them.

| Rank | Feature                                                                                                                     | Effort | Needs                | Why it ranks here                                                                                                            |
| ---- | --------------------------------------------------------------------------------------------------------------------------- | ------ | -------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| 1    | [Enhanced Input scan v2](#ew-01-enhanced-input-scan-v2)                                                                     | S      | nothing              | Requested direction. The scan reports a false problem today and drops trigger and modifier values the package already holds. |
| 2    | [Package dependencies in header evidence](#ew-02-package-dependencies-in-header-evidence)                                   | S to L | ADR (persisted form) | The parser already reads imports and throws them away. Unlocks ranks 4, 5, 7, 8 and 11 without decoding assets.              |
| 3    | [Headless Content Browser](#ew-03-headless-content-browser)                                                                 | M      | product contract     | Requested direction. Folders, search, class filters and sizes work on today's Project Index with no Rust change.             |
| 4    | [Missing-reference finder](#ew-04-missing-reference-finder)                                                                 | S      | rank 2               | A join of rank 2 against the inventory. Also catches missing Input Actions and missing maps named in config.                 |
| 5    | [Reference graph](#ew-05-reference-graph)                                                                                   | M      | rank 2               | The in-editor Reference Viewer, headless: referencers, dependencies, path to a root, pulled-in bytes.                        |
| 6    | [Asset Registry tags projection](#ew-06-asset-registry-tags-projection)                                                     | M      | ADR (with rank 2)    | The engine stores per-asset tags in every uncooked package; we read only the offset. Gives Blueprint parent and mesh data.   |
| 7    | [Redirector report](#ew-07-redirector-report)                                                                               | S to M | ranks 2, 6           | The list works today through `project-index query`. Targets need rank 6, referencers need rank 2.                            |
| 8    | [Enhanced Input usage and conflict analysis](#ew-08-enhanced-input-usage-and-conflict-analysis)                             | M      | ranks 1, 2, 5        | Requested direction. Unused actions, Blueprint use, co-active conflicts, per-platform contexts.                              |
| 9    | [Workbench Content route and shared asset intent](#ew-09-workbench-content-route-and-shared-asset-intent)                   | M      | rank 3               | The showcase for ranks 3 to 7 and the one place every other route can link into.                                             |
| 10   | [Size map](#ew-10-size-map)                                                                                                 | S to M | rank 3               | Sizes already ride in the inventory as an opaque string. Per folder and class first, pulled-in bytes with rank 5.            |
| 11   | [Unreferenced assets with declared roots](#ew-11-unreferenced-assets-with-declared-roots)                                   | M      | ranks 5, 15          | Janitor's headline report, stated as the claim it is: no known path from these roots.                                        |
| 12   | [Game Text place to Blueprint node](#ew-12-game-text-place-to-blueprint-node)                                               | S to M | nothing              | Pin text already carries the node path and the graph viewer already reveals a node by path. Offline, no editor.              |
| 13   | [String Table dangling and unused references](#ew-13-string-table-dangling-and-unused-references)                           | S to M | nothing              | The corpus holds both halves of the join. No check for it exists in the catalogue.                                           |
| 14   | [Compare with depot revision](#ew-14-compare-with-depot-revision)                                                           | M      | ADR (placement)      | Four diff engines and a generic Perforce source exist. Missing is the orchestration.                                         |
| 15   | [Config drift report and config-declared asset references](#ew-15-config-drift-report-and-config-declared-asset-references) | M      | nothing              | Explain and compare handle one key. A section sweep gives the engine-defaults diff and the config roots for ranks 4 and 11.  |

### Further candidates

| Rank | Feature                                                                                                       | Effort | Needs         |
| ---- | ------------------------------------------------------------------------------------------------------------- | ------ | ------------- |
| 16   | [Mesh budget lens from Asset Registry tags](#ew-16-mesh-budget-lens-from-asset-registry-tags)                 | S      | rank 6        |
| 17   | [Animation inventory and notify index on the wire](#ew-17-animation-inventory-and-notify-index-on-the-wire)   | S to M | nothing       |
| 18   | [Saved-with version census](#ew-18-saved-with-version-census)                                                 | S      | nothing       |
| 19   | [Generic class lens](#ew-19-generic-class-lens)                                                               | M      | ranks 6, 16   |
| 20   | [Blueprint dependency card and project-wide search](#ew-20-blueprint-dependency-card-and-project-wide-search) | S to M | ranks 2, 6    |
| 21   | [Generic asset property diff](#ew-21-generic-asset-property-diff)                                             | S to M | nothing       |
| 22   | [Thumbnails](#ew-22-thumbnails)                                                                               | M      | ADR (payload) |
| 23   | [Cross-map actor class census](#ew-23-cross-map-actor-class-census)                                           | S to M | nothing       |
| 24   | [Locate many assets and folders in Unreal](#ew-24-locate-many-assets-and-folders-in-unreal)                   | S      | live editor   |
| 25   | [Gameplay tag usage by name-map probe](#ew-25-gameplay-tag-usage-by-name-map-probe)                           | S      | rank 15       |

## The finding behind the ranking

Most of the best entries wait on the same small set of evidence that the native reader **parses but
does not expose**. Exposing it once pays for many features.

| Evidence                       | Parsed today                                                                                                                           | Exposed to consumers today                                                                                                                                                                                                             | Unlocks                                                                          |
| ------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------- |
| Package imports                | `Package.imports`, each with object path and class path (`crates/uasset-parser/src/package.rs:284`, `:325`)                            | No. The header scan keeps exports only (`crates/uasset-io/src/direct_executor/project_io.rs:1260`). Generic inspection gives import table offset and count (`crates/uasset-inspection/src/generic.rs:137`).                            | Reference graph, missing references, redirector referencers, Blueprint prefilter |
| Soft object paths              | `Package.soft_object_paths` (`package.rs:322`)                                                                                         | Only through full Blueprint and sequence decode (`packages/unreal-assets/src/saved-review.ts:92`)                                                                                                                                      | Soft edges in the graph                                                          |
| Asset Registry section         | Offset only (`package.rs:216`, `:786`)                                                                                                 | No                                                                                                                                                                                                                                     | Asset identity, tags, Blueprint parent, mesh counts, redirector target           |
| Saved-with versions            | Summary fields (`package.rs:189`). Object versions appear in full inspection (`crates/uasset-inspection/src/saved_inspection.rs:611`). | Not in header evidence (`crates/uasset-inspection/src/package_header.rs:7`)                                                                                                                                                            | Resave and upgrade census                                                        |
| Thumbnail table                | Offset only (`package.rs:208`, `:690`)                                                                                                 | No                                                                                                                                                                                                                                     | Visual browsing                                                                  |
| Package and sidecar byte sizes | Enumerated for every package                                                                                                           | Packed into an opaque JSON string, `signature` (`crates/uasset-io/src/direct_executor/catalog.rs:402`, `packages/unreal-assets/src/project-index.ts:238`)                                                                              | Size map                                                                         |
| Animation inventory            | Duration, rate, curves, notifies, root motion (`crates/uasset-inspection/src/animation.rs:24`)                                         | Legacy `uasset animation` command (`crates/uasset-io/src/legacy.rs:536`) and WASM (`packages/uasset-inspection-wasm/src/types.d.ts:548`). Not in the protocol `Operation` (`crates/uasset-io/src/protocol.rs:59`) or `AssetReaderApi`. | Animation corpus                                                                 |
| Folder scope                   | Scan takes `paths` (`protocol.rs:40`)                                                                                                  | Project Index queries have no path predicate (`project-index.ts:153`, `:167`)                                                                                                                                                          | Scoped listing at scale                                                          |

The engine reads the same tables to build its own asset registry. `FPackageReader::ReadDependencyData`
and `ReadLinkerObjects` take imports and soft package references from the linker tables
(`Engine/Source/Runtime/AssetRegistry/Private/PackageReader.cpp:726`, `:497`), and
`ReadPackageDataMain` reads the per-asset tag section (`PackageReader.cpp:1736`). These are not
exotic formats.

Precedent for adding such evidence is already in the tree. Header profile 2 added package flags and
gatherable-text counts as optional `headerData` behind a protocol minor bump and an opt-in request
flag ([`binary-project-index.md`](../engineering/binary-project-index.md)). Entries 2, 6 and 18 are
the next profile.

## The saved-package spine

Covers `crates/uasset-parser`, `crates/uasset-inspection`, `crates/uasset-io`,
`packages/protocol`, `packages/unreal-assets` and `packages/uasset-inspection-wasm`.

**What it does today.** Bounded, read-only decode of uncooked packages (UE 4.27 through 5.7 saved
revisions). Header-depth and full-depth project scans stream results from one native process
(`packages/unreal-assets/README.md`). The Project Index keeps a disposable binary Catalog of
inventory plus header evidence: up to 64 class paths and 64 sampled names per package, package
flags, a text-property probe, and postings for exact classes and names. Queries page at most 1,024
items in path order. Typed projections exist for DataTables, text, textures, Blueprints, Level
Sequences and saved worlds. Counts take up to 16 filters.

### EW-02 Package dependencies in header evidence

- **Today.** `read_scan_header` holds a fully parsed `Package` and returns exports, matched names and
  header data (`project_io.rs:1260`). The wire type `SavedAssetHeader` has no imports
  (`packages/protocol/src/uasset-inspection.ts:489`). The Project Index records classes, names and
  header data only (`crates/uasset-io/src/direct_executor/catalog.rs:66`,
  `crates/uasset-io/src/direct_executor/scanner.rs:57`).
- **Proposal.** Header profile 3, delivered in two stages.
    1. Scan-only, opt-in `dependencies: true` on a header-depth scan, mirroring `headerData: true`.
       Each package lists its distinct imported package names, split into hard (import table) and soft
       edges, with counts of object-level imports. `/Script/` packages stay as class evidence, not
       edges. Soft edges are extra parser work, not only exposure: `soft_object_paths` exists only
       from UE5 package version 1008 (`package.rs:20`, `:654`), so UE 4.27 packages lack it, and the
       separate soft-package-reference table, which the engine reads with
       `SerializeSoftPackageReferenceList` in `FPackageReader::ReadDependencyData`, is located
       (`package.rs:682`) but not decoded. Soft edges need version-aware decoding of that table,
       combined and de-duplicated with `soft_object_paths` where both exist; until then soft-edge
       coverage is limited to 1008+ packages and says so. Otherwise small, local, no catalog change.
    2. Persisted in the Catalog as a new checked section with a reverse posting list keyed by target
       package, so "who refers to X" is a posting lookup like an exact-class query. This is the L part:
       `catalog_binary.rs` (about 2,500 lines), the memory and SQLite oracles and the conformance
       suite all change.
- **Reuses.** Parser `Import` and `Package` (`package.rs:284`, `:320`). The class-posting machinery
  (`binary-project-index.md`). `ProjectIndexQuery`/`ProjectIndexFilter` tagged unions
  (`project-index.ts:153`, `:167`).
- **New surface.** Library: `ProjectIndexQuery.Dependencies` and `Referencers` (packages in, edges
  out, paged). CLI: `ue-shed project-index refs`. Protocol minor bump. Workbench: none directly.
- **Effort.** S for the scan-only stage, L for persisted reverse lookup.
- **Unreal.** Saved-only.
- **Risks.** Catalog size for map packages with thousands of imports (edges are package-level and
  de-duplicated, so bounded by package count, but flag any truncation). Imports are hard references;
  the engine's editor-only versus game-used flag lives in the dependency data section
  (`PackageReader.cpp:1306`) and is a later refinement. References held only in config, C++ or
  strings are invisible, so output must say "saved package evidence". Package names compare
  case-insensitively in Unreal while `project_relative_path` preserves casing (`catalog.rs:325`).
- **Contract.** ADR: "Project Index header profile 3". Extend `binary-project-index.md`.

### EW-06 Asset Registry tags projection

- **Today.** The summary stores `asset_registry_data_offset` and nothing reads the section
  (`package.rs:216`, `:786`; no `crates` hit for asset-registry data beyond the offset).
- **Proposal.** Parse the section the engine reads in `ReadPackageDataMain`
  (`PackageReader.cpp:1736`): a dependency-data offset, an object count, then per asset its object
  path, class and key/value tags. Expose it as `assets: [{ objectPath, classPath, tags }]` in header
  evidence with a bounded tag count and value length, and a `tags` selector on queries later.
- **What it unlocks, verified in UE 5.7 source.**
    - Which export is _the asset_. The header scan lists every export; this lists the assets the
      editor registered.
    - Blueprint `ParentClass` and `NativeParentClass` (`Engine/Source/Runtime/Engine/Private/Blueprint.cpp:1102`),
      which the concrete-class header evidence cannot give (the Project Index states it does not
      resolve inheritance, `project-index.ts:163`). Enables "Blueprints deriving from native class X".
    - Texture `Dimensions` and `Format` (`Texture2D.cpp:721`), StaticMesh `Triangles`, `Vertices`,
      `Materials`, `ApproxSize`, `LODs` (`StaticMesh.cpp:6208`), SkeletalMesh `Vertices`, `Triangles`,
      `LODs` (`SkeletalMesh.cpp:4460`). Mesh geometry is natively serialized, so no property decode
      reaches it.
    - The redirector target. `UObjectRedirector::DestinationObject` is not a `UPROPERTY`; it is
      written by a native `Serialize` (`Engine/Source/Runtime/CoreUObject/Private/UObject/ObjectRedirector.cpp:45`),
      so generic inspection cannot show it, but the engine also publishes it as the
      `DestinationObject` tag (`ObjectRedirector.cpp:73`).
- **Reuses.** The parser's name and import resolution, and the header-profile precedent.
- **New surface.** `ProjectIndexHeader.assets`; a new `uasset-parser` module; CLI
  `project-index query` output gains tags.
- **Effort.** M.
- **Unreal.** Saved-only.
- **Risks.** Tag sets are whatever the saving engine wrote, so they differ across 4.27, 5.7 and 5.8
  and between plugins; treat every tag as optional. Values are strings; do not infer units.
  Cooked packages have no such data and are out of scope already. Needs the 5.8 format check.
- **Contract.** Same ADR as EW-02.

### EW-18 Saved-with version census

- **Today.** The summary has saved-by engine version, compatible-with version, custom versions and
  generations (`package.rs:189`). Full inspection returns object versions
  (`saved_inspection.rs:611`). `PackageHeaderData` carries neither (`package_header.rs:7`).
- **Proposal.** Add object versions and saved-by engine version to `PackageHeaderData`, then a pure
  census: packages grouped by saved-with version, oldest first, and packages newer than the engine
  the host targets. The host decides the target version; UE Shed ships no threshold.
- **Reuses.** `PackageHeaderData` and `countProjectIndex` (`project-index.ts:470`).
- **New surface.** Library `versionCensus(index)`; CLI `ue-shed project-index versions`; a column and
  filter in the Content route.
- **Effort.** S.
- **Unreal.** Saved-only.
- **Risks.** Version numbers are engine-internal; present them verbatim and let the host map them to
  releases. The repository already supports UE 4.27 text (`docs/engineering/game-text-legacy.md`),
  so legacy values must not break the schema.
- **Contract.** None beyond the profile ADR.

### EW-17 Animation inventory and notify index on the wire

- **Today.** The Rust projection exists (`animation.rs:24`) and WASM exposes `extractAnimations`
  (`types.d.ts:548`). It is not a protocol operation (`protocol.rs:59`) or an `AssetReaderApi`
  method (`packages/unreal-assets/src/asset-reader.ts:332`).
- **Proposal.** Follow the `extract_texture` precedent: a protocol operation
  (`protocol.rs:109`), `extractProjectAnimations` beside `extractProjectTextures`
  (`asset-reader.ts:351`), then a project-wide **notify index** (every notify name with its
  sequences and times) and sequence distributions. This is the first slice of the
  [animation corpus](catalog.md#10-animation-corpus).
- **New surface.** Library `AnimationCorpus`; CLI `ue-shed audit animation`; an Asset Audits lens.
- **Effort.** S to M.
- **Unreal.** Saved-only.
- **Risks.** Pose evaluation, compressed curve data and external loads are outside the projection.
  Coverage gaps (`AnimationCoverageGap`) must travel with every number.
- **Contract.** Protocol minor bump; the audit lens needs the shared audit contract (EW-19).

### EW-22 Thumbnails

- **Today.** The thumbnail table offset is parsed and unused (`package.rs:208`).
- **Proposal.** The format is straightforward and verified: a table of class name, path without
  package and file offset (`Engine/Source/Runtime/CoreUObject/Private/UObject/SavePackage/SavePackageUtilities.cpp:1305`), then per thumbnail a width, a height
  (negative means JPEG) and compressed bytes (`Engine/Source/Runtime/Core/Private/Misc/ObjectThumbnail.cpp:37`).
  Add an on-demand `thumbnail` operation, not catalog data, plus header evidence saying whether a
  package has one. A grid requests thumbnails lazily in batches, as Texture Audit previews do
  (`packages/asset-audits/src/schema.ts:100`). First slice of the [lookbook](asset-lookbook.md).
- **Effort.** M.
- **Unreal.** Saved-only.
- **Risks.** Only thumbnails the editor generated are saved, and none exist for editor-filtered
  packages, so coverage varies; show present, absent and unreadable honestly. A thumbnail can be
  stale (the lookbook's staleness rule). The data sits after the export data, so the read must use
  the sidecar-aware path. Payload size over the JSON protocol needs a decision.
- **Contract.** ADR for the binary payload transport; a lookbook product contract when it graduates.

## Content Browser and project cartography

A new headless package (working name `@ue-shed/content-browser`) with an extension and a Workbench
route. This is the "Explore" part of the [content observatory](content-observatory.md) built first as
a library. It is separate from the existing World Log route, which is the Perforce map-history slice
of that vision. Naming needs the usual review: "Content Browser" is Unreal's term, used here
descriptively.

**What exists to build on.** The Project Index already provides every package path with size
(`ProjectIndexInventory`, `project-index.ts:238`), every map (`ProjectIndexMap`, `:205`) and header
evidence by class (`ProjectIndexHeader`, `:220`). The CLI exposes class queries and counts
(`apps/cli/src/commands/project-index.ts:80`). Game Text already caches inventory pages per
generation, has a folder browser (`extensions/game-text/src/game-text-folder-browser.tsx`) and a
`pathPrefix` scope (`game-text-where.tsx:24`). `@ue-shed/ui` has a shared virtualizer
(`packages/ui/src/virtualizer.ts`). None of it offers one queryable, folder-aware asset list.

### EW-03 Headless Content Browser

- **Today.** There is no folder tree, no free-text package search, and no row that joins a package's
  path, size and class. Class queries return header pages; inventory pages return paths and
  signatures; the two are not joined. The CLI cannot page inventory at all.
- **Proposal.** Phase 1 uses only today's evidence.
    - `folderTree(scope)`: folders derived from package paths, with package counts and bytes.
    - `list({ folder, recursive, classFilter, text, sort })`: rows of package path, concrete class
      evidence, kind (map, asset package, external actor package, redirector by class), bytes and
      modified time. Classes come from `ClassPrefixes ["/"]`, which the query schema accepts
      (`project-index.ts:26`), joined to inventory pages in path order. The fully scoped form (a
      `pathPrefix` predicate and a headers listing kind in the catalog) can wait: the catalog already
      pages by path (`catalog.rs:376`), so it is a range scan.
    - `find(text)`: substring and glob over package name and path. No policy is built in.
    - `info(path)`: header evidence, then a full read through the existing Asset Inspector contract
      (`extensions/asset-inspector/README.md`), then references (EW-05) and redirector target (EW-07).
    - View scope is a host option, not a rule: external-actor and external-object folders are
      hidden unless the host asks, the same shape as Game Text's `TextWhere`.
- **Reuses.** `queryProjectIndex` and `countProjectIndex`; the saved-investigation preset and export
  pipeline for saved views (`docs/showcase.md:43`, `packages/unreal-assets/src/investigation.ts:5`).
- **New surface.** Library `ContentBrowser` Effect service plus pure projections. CLI
  `ue-shed content tree|ls|find|info <project-root> <cache-root>`, using the same two positional
  arguments as `project-index`. Workbench: EW-09.
- **Effort.** M for library and CLI.
- **Unreal.** Saved-only. "Locate in Unreal" is an optional, capability-driven action that already
  exists (`UEShedEditorAssetNavigationLibrary.h:12`).
- **Risks.**
    - Class evidence is the concrete class a package exports, not the inheritance chain. Never label
      a filter "derives from" until EW-06 supplies parents.
    - Header evidence keeps the 64 lexicographically smallest class paths, so a large map's list is
      cut by sort order, not relevance (`scanner.rs:403`).
    - The header scan does not say which export is the asset (EW-06 does).
    - Sizes are saved-source bytes, not cooked or memory size (EW-10).
    - Scale: 100,000 packages means pages and virtualization everywhere, never one array.
- **Contract.** New `docs/products/content-browser.md`: read-only, evidence-qualified, no
  inheritance claims, no deletion. No ADR until EW-02 or EW-06 land.

### EW-04 Missing-reference finder

- **Today.** `resolveSavedReference` already reports `unavailable` for a Blueprint reference whose
  package is not in an explicit inventory (`saved-review.ts:68`), but only per opened Blueprint.
- **Proposal.** Join every dependency edge (EW-02) against the inventory: a target package that is
  neither present nor under a declared mount is a finding with the referencing package, the target
  and the import class as evidence. The same join covers non-package sources: Input Action paths in
  mappings (`packages/enhanced-input/src/project.ts:179`) and config values (EW-15). The mount list
  (`/Script/`, `/Engine/`, plugin mounts) is a host option; the default is "report unresolved
  mounts, do not guess".
- **Reuses.** EW-02 edges, the inventory pages, `SavedReferenceResolution`.
- **New surface.** Library `missingReferences(scope, policy)`; CLI `ue-shed content broken`; a
  findings tab in the Content route.
- **Effort.** S once EW-02 stage 1 exists.
- **Unreal.** Saved-only.
- **Risks.** Legitimate references into plugin or engine content look missing without mount
  knowledge. Compare package names case-insensitively. A missing target can be a redirector the
  project has not resaved.
- **Contract.** Part of the Content Browser contract. Mounts and ignored prefixes are policy.

### EW-05 Reference graph

- **Today.** Property-level references exist per Blueprint and per sequence
  (`saved-review.ts:92`, `:194`). There is no project-level graph.
- **Proposal.** Package-level `dependencies(asset, depth)`, `referencers(asset, depth)`,
  `pathsToRoots(asset, roots, k)`, cycle detection, and `closureBytes(asset)`, all over EW-02 queries
  plus inventory sizes. Drill-down to property level for one asset reuses `blueprintReferences`.
  Output as list first, with JSON and DOT export; the observatory vision is explicit that a graph is
  an explanatory view, not the default (`content-observatory.md`, "Explore").
- **New surface.** Library `ReferenceGraph`; CLI `ue-shed content refs <asset> --in|--out --depth N
--to-root`; a References pane in the Content route.
- **Effort.** M.
- **Unreal.** Saved-only.
- **Risks.** Hard imports and the soft tables only (soft edges for packages older than UE5 version
  1008 need the soft-package-reference table, see EW-02); config, C++ and string references are
  missing, and editor-only edges are indistinguishable until the dependency-data section is read.
  Expansion can explode, so depth and node caps with visible truncation are required. "Path to a
  root" depends on the roots policy (EW-11).
- **Contract.** Part of the Content Browser contract.

### EW-07 Redirector report

- **Today.** Nothing in `crates` mentions redirectors. The list is already one command:
  `ue-shed project-index query exact-class /Script/CoreUObject.ObjectRedirector`.
- **Proposal.** The list, then destinations from the `DestinationObject` tag (EW-06), referencers by
  joining dependency and import target paths (EW-02) to each redirector's object and package
  identity, whatever class the import saved, then chains and loops, and folders that contain only
  redirectors. A package saved before the asset moved still imports the original class (for example
  `Texture2D`) at the old path: `FLinkerLoad::VerifyImport` only swaps in `ObjectRedirector` while
  resolving and restores the saved class afterwards, so filtering imports by the redirector class
  would miss the ordinary referencers. Fixing stays in Unreal: `IAssetTools::FixupReferencers` exists in 5.7
  (`Engine/Source/Developer/AssetTools/Public/IAssetTools.h:649`), so a later, separately reviewed
  plugin action can apply a fix-up plan exactly as [ADR 0011](../decisions/0011-game-text-actions.md)
  does for text. The headless output is the plan, never the fix.
- **Reuses.** `project-index query`; EW-02 and EW-06.
- **New surface.** Library `redirectorReport(scope)`; CLI `ue-shed content redirectors`; a finding
  type in the Content route.
- **Effort.** S for list plus targets once EW-06 exists, M with referencers.
- **Unreal.** Report is saved-only. A fix-up action would need a live editor and a plugin.
- **Risks.** A redirector referenced only from C++, config or strings still looks unreferenced; never
  say "safe to fix up". UE 5.8 behaviour of the tag and the API is unchecked.
- **Contract.** Content Browser contract for the report. A fix-up action needs its own ADR.

### EW-10 Size map

- **Today.** Texture Audit records package bytes for textures only
  (`packages/asset-audits/src/schema.ts:41`). Every package's size and its sidecars' sizes are in the
  inventory, but as a JSON string the Rust side calls opaque (`catalog.rs:402`).
- **Proposal.** First make sizes first-class: add `bytes` and `sidecarBytes` to
  `ProjectIndexInventory` so no consumer parses the signature. Then `sizeMap(scope, by)`: bytes by
  folder, by class and by extension, top-N, and later growth between two saved exports. With EW-05,
  add "bytes pulled in by this asset" (closure). Reuse the distribution-bucket shape
  (`schema.ts:177`, `texture.ts:286`).
- **New surface.** Library `sizeMap`; CLI `ue-shed content size`; a size sort and a folder bar in the
  Content route.
- **Effort.** S for folder and class, M for closure.
- **Unreal.** Saved-only.
- **Risks.** These are saved-source bytes. Cooked size, compression and memory differ, and the UI must
  say so. Do not add a size "score". This is a first slice of the
  [content observatory's Growth](content-observatory.md) view.
- **Contract.** Content Browser contract; inventory field is a protocol minor bump.

### EW-11 Unreferenced assets with declared roots

- **Today.** The vision is written ([janitor](catalog.md#13-project-janitor),
  [content observatory](content-observatory.md), "Unused is a claim"). Nothing computes it.
- **Proposal.** Over EW-05, report packages with no known path from a declared root set. Roots are a
  host or project document: maps (from `ProjectIndex.Maps`), explicit paths and folders, values found
  in config (EW-15), and the host's own asset-manager and always-cook directories. The report carries
  roots, exclusions and unsupported reference kinds, and ends with a reviewable plan artifact. A
  cheaper first lens is zero referencers, labelled as the weaker claim.
- **New surface.** Library `unreferenced(scope, roots)`; CLI `ue-shed content orphans --roots <file>`;
  a Janitor tab.
- **Effort.** M.
- **Unreal.** Saved-only for the report. Selecting the list in the editor uses EW-24.
- **Risks.** Assets loaded by C++, string paths, asset-manager scans and soft class references are
  invisible. A false positive that someone acts on is expensive, so the output says "no known path from
  these roots" and nothing stronger, and nothing deletes.
- **Contract.** Extend the Content Browser contract with the roots document schema. The plan artifact
  format can stay unspecified until a writer exists.

### EW-09 Workbench Content route and shared asset intent

- **Today.** Cross-route navigation exists for two kinds only: `openReviewAsset` accepts a
  `SavedReviewAsset` of kind `blueprint` or `level_sequence`
  (`apps/workbench/src/renderer/app-shell.tsx:504`, `:630`). Routes are listed in `navSections`
  (`app-shell.tsx:184`).
- **Proposal.** A `#/content` route under Inspect, using the shell's selected project (no picker, per
  [project ownership](../showcase.md#project-ownership)). Folder tree, a virtualized list with class
  chips and size sort, and a details pane that dispatches by class to what already exists: Blueprint
  to the graph viewer, Level Sequence to Sequencer, Texture to its audit record, DataTable to Data
  Authoring, String Table to Game Text, anything else to the Asset Inspector. Generalize
  `openReviewAsset` into an asset intent `{ assetPath, kind, reveal? }` so every route can link in.
  Lift the Game Text folder browser into a generic `FolderTree` in `@ue-shed/ui`.
- **Reuses.** The extensions above, `ShowInUnrealButton` for the capability-driven locate action,
  saved investigations for views, `@ue-shed/ui` virtualizer.
- **Effort.** M for the route, S for the intent.
- **Unreal.** Optional locate only.
- **Risks.** Drifting into a Content Browser clone, which the lookbook lists as an anti-goal; keep it
  query and evidence. Follow the density rules (compact rows, no stat tiles). Needs component tests,
  real-app screenshots and StyleX checks per the repository gates.
- **Contract.** A showcase demo section plus the product contract from EW-03.

## Enhanced Input

`packages/enhanced-input`, `extensions/input-atlas`, `ue-shed input inspect`.

**What it does today.** Scans a project for Enhanced Input assets by header class prefix and suffix
(`packages/enhanced-input/src/project.ts:25`, `:459`) and decodes only those packages. Per action it
keeps description, value type and consume-input (`project.ts:229`). Per mapping context it keeps
description, the mapping list (action, key, triggers and modifiers as class paths) and exports
(`project.ts:179`, `:247`). The atlas inverts a report onto keys and flags a key _contested_ when
different contexts claim it (`atlas.ts:117`, `:169`). The route has a keyboard and gamepad layout and
a per-key claim list. There is no product contract for the route, and the CLI only prints the raw
report.

### EW-01 Enhanced Input scan v2

> **Implemented in PR #158.** Contract: [Input Atlas](../products/input-atlas.md). Every row of the
> table below is projected as optional `Evidence`, triggers and modifiers carry saved `parameters`,
> and `PlayerMappableConfigRecord` removes the false diagnostic. `ue-shed input atlas` and
> `ue-shed input export` ship. Verified on UE 5.7 against packages Unreal saved
> (`pnpm test:unreal-enhanced-input`); UE 5.8 was not installed, so the 5.8 check is still owed.
> Deferred: the committed fixture gains no config asset or chord (the probe covers them in a
> disposable project), and pre-5.3 `PlayerMappableOptions` on mappings is not projected. Two
> corrections to the text below: the fixture has 20 actions, not 19, and the false diagnostic only
> reached direct scans (CLI); the Workbench path filtered config packages out before decoding.

What a saved action, mapping context and config asset contain, checked against UE 5.7
(`Engine/Plugins/EnhancedInput/Source/EnhancedInput/Public`), against what the scan keeps:

| Asset                                           | Saved properties we skip                                                                                                                                                                                                                                                                                          |
| ----------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `InputAction` (`InputAction.h:87`-`:153`)       | `bTriggerWhenPaused`, `bConsumesActionAndAxisMappings`, `bReserveAllMappings`, `TriggerEventsThatConsumeLegacyKeys`, `AccumulationBehavior`, action-level `Triggers` and `Modifiers`, `PlayerMappableKeySettings` (name, display name, category, supported key profiles, `PlayerMappableKeySettings.h:42`-`:72`). |
| Mapping (`EnhancedActionKeyMapping.h:125`)      | `SettingBehavior` and the per-mapping `PlayerMappableKeySettings` override.                                                                                                                                                                                                                                       |
| `InputMappingContext` (`InputMappingContext.h`) | `MappingProfileOverrides` (per key profile mappings, `:109`), `InputModeFilterOptions` and its query override (`:130`, `:141`), `RegistrationTrackingMode` (`:147`).                                                                                                                                              |
| Triggers and modifiers                          | Their parameters: `ActuationThreshold` (`InputTriggers.h:130`), hold and tap times, `ChordAction` (`:472`), dead zone thresholds and type (`InputModifiers.h:156`-`:163`), `Scalar` (`:201`), negate axes (`:230`), swizzle order (`:389`).                                                                       |
| `PlayerMappableInputConfig`                     | Everything. `ConfigName`, `bIsDeprecated`, and `Contexts`, the map from context to priority (`PlayerMappableInputConfig.h:57`-`:73`).                                                                                                                                                                             |

The last row is a live defect. The scan selects packages by the `/Script/EnhancedInput.` prefix
(`project.ts:459`), so a config asset's package is decoded. Neither projector accepts it, so the
report adds an `unsupported_asset` diagnostic, "Package contains no Enhanced Input action or mapping
context export" (`project.ts:327`), and marks the whole report `partial` (`project.ts:352`). Any
project with a config asset sees a permanently partial scan.

The trigger and modifier values are already in hand. The mapping context's instanced subobjects are
exports with decoded properties; `mappingContextFromInspection` builds a path-to-class map from
them (`project.ts:256`) and then keeps only the class (`project.ts:150`).

- **Proposal.** Additive schema change, keeping the rule that a value not serialized stays
  `unavailable` and is never replaced by an engine default (`packages/enhanced-input/README.md`).
    - `InputActionRecord` gains the missing properties as `Evidence` fields.
    - `InputInstancedObjectRef` gains `parameters: [{ name, value }]` for scalar-valued saved
      properties and object-valued ones (a chord's action becomes a real action-to-action edge).
    - Mappings gain `settingBehavior` and the override settings; contexts gain `profileOverrides`,
      input-mode fields and registration mode.
    - A new `PlayerMappableConfigRecord` and projector, so the false diagnostic disappears and
      context priorities become available (they feed EW-08).
    - Bump `schemaVersion`; keep the existing fields stable because the report is also the main and
      renderer wire contract (`schema.ts`, `EnhancedInputRunResult`).
- **Reuses.** `Evidence` and the existing projectors; the fixture's 19 actions and 5 contexts
  (`fixtures/unreal-project/Content/Fixture/Input`).
- **New surface.** Library fields. `ue-shed input inspect` output. Atlas claim detail shows trigger
  parameters. CLI gains `ue-shed input atlas <project>` and `ue-shed input export` (CSV and
  Markdown control sheet) through the saved-investigation export pattern.
- **Effort.** S for the projection and the diagnostic fix, S for the CLI.
- **Unreal.** Saved-only.
- **Risks.** Property names can differ across engine versions (earlier releases saved different
  mappable-key properties; only UE 5.7 source was available to check here), so treat every field as
  optional. The fixture has no config asset, so new fixture assets must be
  generated on both 5.7 and 5.8. Parameters are saved overrides only; absent means "default at the
  engine's CDO", which this package deliberately does not claim.
- **Contract.** None for the projection. Write `docs/products/input-atlas.md` with EW-08.

### EW-08 Enhanced Input usage and conflict analysis

> **Implemented in PR #158**, without waiting for EW-02 or EW-05. Contract:
> [Input Atlas](../products/input-atlas.md), including the co-activation document schema. Shipped:
> the three co-activation sources, the four conflict classes over the base contested flag, "no
> known use" and unbound mappings, Blueprint uses, platform data redirects, key-profile views and
> device coverage, `ue-shed input conflicts|unused|platforms`, and the route's conflict-class
> filter and in-project platform view. Blueprint use takes the documented fallback with a cheaper
> first step: a header name-map probe for the action package names narrows the Blueprint list
> before a bounded decode. Deferred: import-based prefiltering and missing action targets (wait on
> EW-02 and EW-04; unresolved targets are listed as "not in the scan" meanwhile), links from the
> atlas to the asset (EW-09), `DefaultWorldSubsystemMappingContexts`, and evaluating input-mode
> queries. The Workbench reads default contexts for the platform it runs on and has no host
> document input; the CLI takes both.

- **Today.** "Contested" means two contexts name the same key, whether or not those contexts can ever
  be active together (`atlas.ts:167`). Nothing says which actions are unused, which Blueprints use an
  action, or what changes per platform.
- **Proposal.**
    1. **Co-activation sets as policy.** A conflict only matters between contexts that are active at
       once. Three evidence sources, each optional: the project's default contexts with priority from
       `DefaultInput.ini` (`EnhancedInputDeveloperSettings.h:19`-`:55`) read through Config Explorer;
       the contexts and priorities in a config asset (EW-01); or a host-authored JSON document. Then
       classify: _shadowed_ (same set, different priority; a lower-priority claim is consumed when the
       action consumes input, `InputAction.h:95`), _ambiguous priority_, _qualified_ (differing
       triggers or a chord, so likely intentional), and _cross-context_ (never co-active, informational).
       The existing flag stays as the base evidence.
    2. **Unused and unbound.** An action referenced by no context, no config asset and no Blueprint is
       "no known use". A mapping with no readable key is flagged (already counted,
       `atlas.ts:141`). Missing action targets use EW-04.
    3. **Blueprint use.** The Blueprint event node stores its action as a property
       (`K2Node_EnhancedInputAction.h:50`), and `blueprintReferences` already walks node properties
       (`saved-review.ts:172`). Prefilter Blueprint packages by imports of the action packages
       (EW-02) and decode only those, the same header-then-decode pattern as
       `texturePackagePathsFromProjectIndex` (`packages/asset-audits/src/texture.ts:147`). Without
       EW-02 it falls back to decoding every Blueprint the Blueprint search catalog already lists
       (`apps/workbench/src/main/ipc/blueprint-graphs.ts:121`).
    4. **Per platform.** Three real sources: per-platform data classes whose context redirects replace
       one context with another (`EnhancedInputPlatformSettings.h:45`; `PlatformSettings`,
       `EnhancedInputDeveloperSettings.h:68`), listed per platform through Config Explorer compare
       (`packages/config-explorer/src/service.ts:61`) and read from their Blueprint default object;
       key-profile overrides on the context (EW-01); and gamepad versus keyboard coverage per action,
       where the device sets are host input.
    5. **Output.** `ue-shed input conflicts|unused|platforms` and a control-sheet export. The atlas gains
       a conflict-class filter, a platform selector (a selection inside the project, not a project
       picker) and links to the asset (EW-09).
- **Reuses.** `buildInputAtlas`, `blueprintReferences`, Config Explorer, EW-02, EW-04, EW-05.
- **Effort.** M.
- **Unreal.** Saved-only.
- **Risks.** Mapping contexts carry no priority; priority is a runtime argument, so without a source
  above only the base "contested" claim is honest. C++ `BindAction` is invisible, so "unused" is "no
  known use". Platform data classes are Blueprints, so reading their redirect map costs one Blueprint
  decode per platform. Nothing assumes a studio's context names.
- **Contract.** New `docs/products/input-atlas.md` (the shipped route has none; the vision is in
  [asset audits](asset-audits.md#input-atlas)), including the co-activation document schema. No ADR.

## Blueprints

`packages/blueprints`, `extensions/blueprint-graphs`, saved review in `packages/unreal-assets`.

**What it does today.** Pure graph indexing, neighbors, layout, node display and per-Blueprint search
(`packages/blueprints/src/search.ts:20`); a Solid Flow viewer with a footer `reveal(objectPath)`
(`extensions/blueprint-graphs/src/blueprint-graph-viewer.tsx:50`); per-Blueprint references and
comparison (`saved-review.ts:92`, `:692`); a project Blueprint search that lists candidates from the
index (`blueprint-graphs.ts:121`).

### EW-20 Blueprint dependency card and project-wide search

- **Today.** References and search stop at the open Blueprint.
- **Proposal.**
    - **Dependency card.** A pure `blueprintDependencies(read)` over `blueprintReferences`, grouped by
      target and by kind: parent class, variable types, function owners called from nodes, component
      classes, struct and enum pin types. Classify native, same package and asset targets with
      `resolveSavedReference` (`saved-review.ts:50`). Named a _saved dependency card_, not a compile
      order; UE Shed does not compile.
    - **Project search.** `BlueprintCorpus.search` runs `searchBlueprint` over Blueprints chosen by
      the index: `ExactClasses` for `/Script/Engine.Blueprint`, narrowed by parent tag (EW-06) and by
      imports (EW-02), with bounded concurrency, cancellation and a per-signature cache. First-class
      queries: every use of a function or variable, every node comment, every pin default text.
- **New surface.** Library functions; CLI `ue-shed assets blueprint-search`; a card in the graph
  viewer's inspector.
- **Effort.** S for the card, M for project search.
- **Unreal.** Saved-only.
- **Risks.** Blueprint reads are heavy and limited to 64 MiB (`packages/unreal-assets/README.md`);
  partial reads must surface. "Used" excludes bytecode and C++.
- **Contract.** None for the card; project search belongs in the Content Browser contract.

## Game Text and localization

`packages/game-text`, `packages/localization`, `extensions/game-text`.

**What it does today.** One searchable corpus of saved player-facing text with identity kept apart
from place, quality checks, translation review, PO and gate workflows, and Unreal-side key fixes
(`docs/products/game-text.md`). A place is a DataTable cell, String Table entry or asset property with
object and property path (`packages/game-text/src/schema.ts:62`, `:112`). Compiled Blueprint copies are
folded into their authored place. Locating an occurrence's asset in the editor needs a live editor
(`docs/showcase.md`, Editor handoffs).

### EW-12 Game Text place to Blueprint node

- **Today.** Blueprint pin text is reconciled to its saved pin and kept as an `asset_property`
  location whose path is `Pins[n].DefaultTextValue`
  (`crates/uasset-inspection/src/blueprint_text.rs:21`). The graph viewer can reveal a node by object
  path (`blueprint-graph-viewer.tsx:50`). Workbench opens the graph route with an initial asset
  (`app-shell.tsx:640`). The jump is not wired.
- **Proposal.** An "Open in Blueprint Graphs" action on occurrences whose location class is a graph
  node, producing an asset intent with `reveal: location.objectPath` (EW-09). Add the reverse: a
  node's text pin shows its identity and, with a localization target, its translations, joined by
  object path. Prefer the authored place over a compiled copy (`TextOccurrence.copies`).
- **Reuses.** `TextLocation`, `BlueprintGraphFooterControls.reveal`, `initialAssetPath`, the pin-text
  fixture `fixtures/graph-pin-text`.
- **New surface.** Library: a pure `blueprintNodeOfOccurrence(occurrence)`. Workbench: one action and a
  reveal-after-load hook. CLI: `ue-shed text search` can print the node path already; no new command.
- **Effort.** S to M.
- **Unreal.** Saved-only. This is the offline counterpart to Locate in Unreal.
- **Risks.** Confirm the text location's node object path equals the projection's
  `node.object_path` on the fixture. Graph reveal needs the graph projection, which is Blueprint
  schema-2 only.
- **Contract.** One paragraph in `game-text.md`, "Reviewing text in Workbench".

### EW-13 String Table dangling and unused references

- **Today.** The corpus holds both halves. A text value that uses a String Table is an occurrence with
  identity `{ status: "string_table", tableId, key }` (`schema.ts:41`, `corpus.ts:175`), and each table
  entry is a `string_table_entry` place (`corpus.ts:444`). No check joins them: the catalogue lists
  format, whitespace, duplicate, length and consistency checks only
  (`packages/game-text/src/localization-check-ids.ts`).
- **Proposal.** A pure function over the corpus that reports _dangling_ (a reference to a table or key
  no saved table defines, which shows placeholder text at runtime) and _unused_ (an entry nothing in
  saved packages references). Ship it as a catalogue check a host can enable, scope or replace, using
  the custom-check contract (`packages/game-text/src/localization-custom-checks.ts`).
  _Unused_ is off by default.
- **New surface.** A built-in check id; `ue-shed text review` and the Quality tab show findings; the
  Content route links a table to its entries.
- **Effort.** S to M.
- **Unreal.** Saved-only.
- **Risks.** Tables registered in C++ have no asset, so "dangling" needs a host list of external table
  ids. Code and Blueprint macros reference tables outside saved packages, so "unused" is only "not
  referenced in saved packages". The schema notes that table id is not the localization namespace
  (`schema.ts:38`); confirm the id-to-asset mapping on the fixture before relying on it.
- **Contract.** Add the check to the catalogue section of `game-text.md`; policy stays in the rules
  file.

## Asset audits

`packages/asset-audits`, `extensions/asset-audits`, `ue-shed audit textures`.

**What it does today.** A Texture Audit: header selection of Texture2D packages
(`texture.ts:147`), a typed record per texture (`schema.ts:41`), two rule kinds
(`dimensions_power_of_two`, `max_dimension_for_texture_group`, `schema.ts:123`), distributions, peer
comparison (`schema.ts:309`), live preview, and saved presets and exports.

### EW-16 Mesh budget lens from Asset Registry tags

- **Today.** There is no mesh lens. Mesh geometry is natively serialized, so a property decode shows
  none of it.
- **Proposal.** After EW-06, a lens over StaticMesh and SkeletalMesh tags: triangles, vertices, LODs,
  materials and approximate size, with distributions, peers and host-authored thresholds. Reuse the
  texture machinery by generalizing the rule union into per-lens rule sets.
- **Effort.** S for the lens, M to generalize the audit schemas (see EW-19).
- **Unreal.** Saved-only.
- **Risks.** Tag values are what the editor saved; a stale tag means a stale number. Disclose when a
  tag is absent rather than reading zero. No default thresholds ship.
- **Contract.** A short audits product contract covering the shared finding and rule language.

### EW-19 Generic class lens

- **Today.** Each lens is a bespoke Rust extraction and a TypeScript record (`texture_wire.rs`,
  `schema.ts:41`).
- **Proposal.** A declarative lens: a document names class paths and columns (label, property path,
  kind). A service selects packages by header, reads them, and extracts tagged properties into the
  existing `Evidence` cells, with distributions and presets for free. Covers data assets, curves,
  materials' tagged properties, sound waves' tagged properties and any class a team cares about,
  without Rust per class. Native-only data stays out of reach; EW-06 tags cover the usual budgets.
- **Reuses.** `scanFromProjectIndex` header-then-decode, `Evidence`, `foldTextureDistributions`,
  investigations.
- **New surface.** Library `ClassLens`; CLI `ue-shed audit lens <lens.json>`; the Asset Audits route
  picks a lens document.
- **Effort.** M.
- **Unreal.** Saved-only.
- **Risks.** Schema sprawl; keep the document small. No studio property names in shipped defaults.
- **Contract.** The audits contract and the lens document schema.

## Config Explorer

`packages/config-explorer`, `extensions/config-explorer`, `ue-shed config explain|compare`.

**What it does today.** Explains one section and key for one project and platform with an ordered
contribution timeline and layer coverage, and compares two platforms for that key
(`packages/config-explorer/src/service.ts:61`, `schema.ts:142`). The parser reads one section and key
per call (`parser.ts:93`). The saved-source hierarchy comes from `buildConfigHierarchy`
(`hierarchy.ts:145`).

### EW-15 Config drift report and config-declared asset references

- **Today.** Answering "what differs between Windows and Android" or "what does this project change
  from engine defaults" takes one `compare` or `explain` per key.
- **Proposal.**
    - **Section sweep.** An enumerate mode in the parser and service that folds every key of a section
      or family. Two reports follow: `drift` between two platforms (the shape of
      `ConfigCompareRequest`), and `projectVsEngine`, the one-page diff of project-owned layers against
      engine layers ([settings drift](catalog.md#19-settings-drift-and-config-archaeology)).
    - **Asset references.** Scan effective values for object and soft paths (`/Game/...`) and emit
      config-to-asset edges with section, key and source line. Feed EW-04 (a map or class named in
      config that no longer exists) and EW-11 (config-declared roots).
- **Reuses.** `foldConfigCommands` (`merge.ts:78`), `compareConfigExplanations` (`merge.ts:203`),
  platform chain resolution (`hierarchy.ts:281`).
- **New surface.** Library `drift` and `configAssetReferences`; CLI `ue-shed config drift` and
  `ue-shed config assets`; a section view in the Config Explorer extension.
- **Effort.** M.
- **Unreal.** Saved-only. Still not live CVars, device profiles or cooked config.
- **Risks.** Struct-valued and array operators in values need careful parsing. The engine root must
  be explicit or discovered. No user-private config is read. Large engine families need streaming
  and bounds.
- **Contract.** Extend `docs/products/config-explorer.md`; no ADR.

### EW-25 Gameplay tag usage by name-map probe

- **Today.** The scan can ask which packages hold a name: `names` filters are matched against the
  complete name map (`project_io.rs:1306`; `packages/unreal-assets/README.md`, "Scanning a whole
  project"). Config Explorer can read the project's tag list. The
  [gameplay tag atlas](catalog.md#17-gameplay-tag-atlas) exists only as an idea.
- **Proposal.** Read the tag list through EW-15's enumerate mode, then probe names and count packages
  per tag. A first slice, with the honest label "name present in the package". Add folders and
  classes through the Content Browser.
- **Effort.** S after EW-15.
- **Unreal.** Saved-only.
- **Risks.** A name map entry is not proof of tag use. The Project Index's `SerializedNames` are a
  64-name sample, so use the scan filter, not the index. Rename blast radius is a separate, larger
  entry.
- **Contract.** None until it graduates into the tag atlas.

## History and comparison

`packages/map-history`, `packages/authoring`, `packages/game-text`, `extensions/content-observatory`.

**What it does today.** `PerforceHistorySource` can describe a changelist, list submitted changes,
materialize depot files and resolve a local path (`packages/map-history/src/perforce.ts:100`). It lives
in the map-history package but is not map-specific. Domain diffs already exist:
`compareSavedBlueprints` and `compareSavedSequences` (`saved-review.ts:692`, `:724`),
`diffAuthoringTable` with table fingerprints (`packages/authoring/src/review.ts:131`,
`fingerprint.ts:90`), `diffPackageText` (`docs/products/game-text.md`, "Comparing two copies of a
package"), and `diffSavedWorldSnapshots` (`packages/map-history/src/diff.ts:203`). The game text
contract says fetching the earlier revision stays with the host.

### EW-14 Compare with depot revision

- **Today.** Each diff takes two already-read values. Nothing fetches "this asset at changelist N".
- **Proposal.** An `AssetRevisionCompare` adapter that materializes the asset at a revision (and the
  working copy) through the Perforce source and hands both to the right domain diff: Blueprint,
  Level Sequence, DataTable, text, and via EW-21 any other asset. Add DataTable row history: walk the
  changelists that touched a table and report per-row and per-cell changes using the fingerprint to
  skip identical revisions. This is the first slice of the
  [content time machine](catalog.md#5-content-time-machine).
- **Reuses.** The sources and diffs above; `HistoricalProjectTree` for bounded temporary state
  (`historical-project-tree.ts:24`).
- **New surface.** Library `compareAssetRevisions`; CLI `ue-shed assets compare <asset> --change N
[--to M|working]`; "Compare with depot" in the Content details pane and Data Authoring.
- **Effort.** M.
- **Unreal.** None; needs a configured `p4` and workspace.
- **Risks.** Perforce only. Define a small `RevisionSource` interface so a git adapter can follow, and
  do not widen map-history's scope silently: placement is the decision. Credentials stay in `p4`
  configuration. Materialization is bounded (`maxFiles`).
- **Contract.** ADR on placement (a new small package versus extending map-history). A short product
  contract for asset history.

### EW-21 Generic asset property diff

- **Today.** Saved review compares Blueprints and sequences only. A DataAsset, an Input Action, a
  curve or a material instance cannot be compared.
- **Proposal.** A pure `compareSavedAssets(before, after)` over two `SavedAssetInspection` values that
  normalizes property trees (map and set order normalized, array order kept, identity by property path
  and export path) and returns the existing `SavedReviewComparison` shape (`saved-review.ts:207`,
  `:224`).
- **Effort.** S to M.
- **Unreal.** Saved-only.
- **Risks.** Instanced subobject identity without GUIDs becomes remove-plus-add, as the saved-review
  notes already state. No-change means no decoded saved difference, not runtime equivalence.
- **Contract.** Extend the saved-review contract (`SavedReviewOutput`).

## World

`packages/world`, `packages/observatory`, `readSavedWorld`.

**What it does today.** `world` prepares a live editor world for bounded work. `readSavedWorld` reads
one map's actors, classes, labels and transforms from files (`packages/unreal-assets/README.md`,
"Reading one saved map"). `ProjectIndex.Maps` lists the maps.

### EW-23 Cross-map actor class census

- **Today.** Saved worlds are read one map at a time.
- **Proposal.** Fold `readSavedWorld` over every indexed map into class counts per map, maps by actor
  count, and classes used in only one map. A thin first slice of the
  [queryable world](catalog.md#3-queryable-world). Cache so rescans are cheap, keyed on everything
  the read depends on: for a World Partition map, `readSavedWorld` reads the map's
  `__ExternalActors__` packages (`crates/uasset-io/src/direct_executor/project_io.rs:1690`), which
  change without changing the `.umap` signature (`catalog.rs:401` signs one package and its
  sidecars). The key therefore covers the external-actor subtree's membership and signatures; a
  cache bound to the Project Index generation is an acceptable first slice that defers per-map
  invalidation.
- **Reuses.** `readSavedWorld`, `ProjectIndexMap` (`project-index.ts:205`), the index signature.
- **New surface.** Library `worldCensus`; CLI `ue-shed world census`.
- **Effort.** S to M.
- **Unreal.** Saved-only.
- **Risks.** Large World Partition maps are expensive and can be partial; honor `maximumAssets` and
  show partial coverage per map. Saved state is not a live snapshot.
- **Contract.** None until the queryable world graduates.

## Unreal plugins

`unreal/Plugins/*`.

### EW-24 Locate many assets and folders in Unreal

- **Today.** `UEShedCore` locates one asset: it calls `SyncBrowserToAssets({Asset}, false, true)`
  (`unreal/Plugins/UEShedCore/Source/UEShedCoreEditor/Private/UEShedEditorAssetNavigationLibrary.cpp:212`).
  The engine API takes arrays of asset data and a separate folder call
  (`Engine/Source/Editor/ContentBrowser/Public/IContentBrowserSingleton.h:691`, `:712`).
- **Proposal.** Add `LocateAssets(ObjectPaths)` and `LocateFolder(Path)` as separate capability
  entries in the manifest, so a cleanup report (EW-07, EW-11) can select its whole result set in
  Unreal's Content Browser. This is the safe handoff for cleanup: the editor does the work and the
  user reviews it there. Use the `FAssetData` overload so the call does not load assets.
- **Reuses.** The capability manifest and `editor-asset-navigation.ts` wire schema.
- **Effort.** S.
- **Unreal.** Live editor and plugin. APIs read on 5.7 only; 5.8 needs the check.
- **Risks.** Very large lists make the editor slow; cap and chunk. A wire-contract change needs C++
  and TypeScript conformance together.
- **Contract.** Versioned capability schema update; no ADR.

## Cross-feature links

The links that make the entries above more than a sum. Each uses an existing identity (package path,
object path) and the shared asset intent from EW-09.

| From                      | To                              | Mechanism                                                           | Entry        |
| ------------------------- | ------------------------------- | ------------------------------------------------------------------- | ------------ |
| Game Text place           | Content details, Blueprint node | `TextLocation.objectPath` and `propertyPath`, `reveal(objectPath)`  | EW-12, EW-09 |
| Content asset             | Referencers and dependencies    | EW-02 edges, `resolveSavedReference` for property drill-down        | EW-05        |
| Input action              | Blueprint nodes that use it     | `blueprintReferences` over imports-prefiltered Blueprints           | EW-08        |
| Config value              | Asset or missing asset          | Config asset references joined to the inventory                     | EW-15, EW-04 |
| Redirector                | Destination and referencers     | `DestinationObject` tag, imports matched to the redirector identity | EW-07        |
| Texture or mesh audit row | Content details and references  | Same package path                                                   | EW-16, EW-09 |
| Any finding list          | Selection in the Unreal editor  | `LocateAssets` capability, only when advertised                     | EW-24        |
| Content asset             | Compare with depot revision     | Revision source plus domain diff                                    | EW-14        |

## Packages with no easy win identified now

Naming them keeps the survey honest. Each was read; none has a thin projection waiting.

- `authoring`, `authoring-catalog`, `authoring-sdk`, `host`: the DataTable flagship is deep and its
  next steps are already Plan 007. Its diff and fingerprint are reused above (EW-14).
- `cameras`, `niagara`, `scenarios`, `observatory`, `evidence`: live capture and playback
  domains. Their easy wins are inside their own plans.
- `engine`, `unreal-connection`, `plugin-distribution`, `protocol`, `observability`: infrastructure
  that the entries above extend (EW-17, EW-24) rather than need new features.
- `project-custodian`: reclaimable workspace storage outside Content. Content sizes come from EW-10,
  not from a custodian change.
- `localization`: evidence readers are complete for their stated formats. Decoding compiled `.locres`
  is a real gap but not a thin one.
- `ui`, `ui-theme`: gain a generic `FolderTree` through EW-09, no separate entry.

## Deliberately not proposed

- Any headless write: redirector fix-up, deletion, resave, key repair. Unreal owns writes; the
  headless output is a plan.
- A project health score, or a single severity that merges unrelated lenses.
- Inheritance-based class filters before EW-06 supplies parents.
- A Content Browser clone. The route earns its place through query, evidence and cross-links.
- Defaults that encode a team's folder names, naming rules, thresholds or context names.

## Suggested order

1. EW-01, as one small pull request: it fixes a live false diagnostic and is independent.
2. EW-02 stage 1 and EW-06 together as one ADR-backed profile, scan-only first.
3. EW-03 library and CLI in parallel; it needs nothing from step 2.
4. EW-04, EW-07, EW-05, EW-10 as thin joins once step 2 lands, then EW-09 as the showcase.
5. EW-08, EW-11, EW-12, EW-13, EW-14, EW-15 as lane work, in any order.
6. Persist dependencies in the Catalog (EW-02 stage 2) only when scan-only cost is measured and
   found too high.
