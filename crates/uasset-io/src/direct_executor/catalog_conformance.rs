//! Adapter-neutral Catalog conformance suite.
//!
//! Every scenario programs against the coordinator and the storage-neutral Catalog seam only. The
//! suite must stay free of storage vocabulary so each adapter can run it unchanged.

use std::cell::Cell;
use std::collections::{BTreeMap, BTreeSet};

use crate::cancellation::CancellationToken;

use super::catalog::CatalogSnapshotEntry;
use super::catalog::{
    Catalog, CatalogError, CatalogStatus, Completeness, EdgeFilter, EntryKind, Generation,
    HeaderEvidence, HeaderFields, INDEX_PROFILE_VERSION, IndexScope, MountPoint,
    PROJECT_INDEX_MAX_DIAGNOSTICS, PROJECT_INDEX_MAX_PAGE_SIZE, PackageDependency,
    PackageSignature, ProjectId, QueryItem, QueryKind, QueryRequest, RefreshChanges,
    RefreshSummary, StagedPackage, item_path, project_id_from_root,
};
use super::checkpoint;
use super::project_index::{
    BundleListing, CatalogSnapshot, CoordinatorError, ProjectScanner, RefreshEvent, RefreshReach,
    query, rebuild, rebuild_listing_changes, refresh, refresh_changed_paths,
    refresh_listing_changes,
};

pub(crate) const FIXTURE_PROJECT_ROOT: &str = "C:/Fixture";

/// Deterministic scanner fixture. Header reads are counted so reuse can be proven.
#[derive(Default)]
pub(crate) struct FakeScanner {
    pub(crate) entries: Vec<PackageSignature>,
    pub(crate) headers: BTreeMap<String, HeaderEvidence>,
    pub(crate) reread: BTreeMap<String, PackageSignature>,
    pub(crate) header_reads: Cell<u64>,
    pub(crate) fail_after_header: BTreeSet<String>,
    pub(crate) unstable: BTreeSet<String>,
    /// Mount points beyond `/Game/`.
    pub(crate) plugin_mounts: Vec<MountPoint>,
    /// The Catalog identity scope; adapters opened for the fixture project expect `Content`.
    pub(crate) scope: IndexScope,
    /// Files the walk ignores (neither packages nor sidecars).
    pub(crate) ignored_files: BTreeSet<String>,
}

impl ProjectScanner for FakeScanner {
    fn scope(&self) -> IndexScope {
        self.scope
    }

    fn mount_points(&self) -> Vec<MountPoint> {
        let mut mounts = vec![MountPoint::game()];
        mounts.extend(self.plugin_mounts.iter().cloned());
        mounts
    }

    fn enumerate(
        &self,
        _project_root: &str,
        cancellation: &CancellationToken,
    ) -> Result<crate::direct_executor::signature_arena::SignatureArena, CoordinatorError> {
        checkpoint(cancellation, "discovery")?;
        Ok(self.entries.iter().collect())
    }

    fn read_header_evidence(
        &self,
        _project_root: &str,
        signature: &PackageSignature,
        cancellation: &CancellationToken,
    ) -> Result<HeaderEvidence, CoordinatorError> {
        checkpoint(cancellation, "inspection")?;
        self.header_reads.set(self.header_reads.get() + 1);
        if self.fail_after_header.contains(&signature.relative_path) {
            return Err(CoordinatorError::Unavailable {
                message: "injected header failure".to_owned(),
            });
        }
        self.headers
            .get(&signature.relative_path)
            .cloned()
            .ok_or_else(|| CoordinatorError::Unavailable {
                message: format!("missing header fixture for {}", signature.relative_path),
            })
    }

    fn is_ignored_file(&self, _project_root: &str, relative_path: &str) -> bool {
        self.ignored_files.contains(relative_path)
    }

    fn list_bundles(
        &self,
        _project_root: &str,
        stems: &[String],
        cancellation: &CancellationToken,
    ) -> Result<BundleListing, CoordinatorError> {
        checkpoint(cancellation, "discovery")?;
        let mut entries = self
            .entries
            .iter()
            .filter(|entry| {
                super::inventory_digest::bundle_stem(&entry.relative_path)
                    .is_some_and(|stem| stems.binary_search_by(|s| s.as_str().cmp(stem)).is_ok())
            })
            .cloned()
            .collect::<Vec<_>>();
        entries.sort_by(|a, b| a.relative_path.cmp(&b.relative_path));
        Ok(BundleListing::Entries(entries))
    }

    fn reread_signature(
        &self,
        _project_root: &str,
        relative_path: &str,
        kind: EntryKind,
        cancellation: &CancellationToken,
    ) -> Result<Option<PackageSignature>, CoordinatorError> {
        checkpoint(cancellation, "read")?;
        if self.unstable.contains(relative_path) {
            let mut next = self
                .reread
                .get(relative_path)
                .cloned()
                .or_else(|| self.find_entry(relative_path))
                .unwrap_or(PackageSignature {
                    relative_path: relative_path.to_owned(),
                    kind,
                    size: 1,
                    modified_nanos: 1,
                });
            // Keep changing after every header read so revalidation cannot settle.
            next.modified_nanos = next
                .modified_nanos
                .saturating_add(self.header_reads.get().max(1));
            return Ok(Some(next));
        }
        Ok(self
            .reread
            .get(relative_path)
            .cloned()
            .or_else(|| self.find_entry(relative_path)))
    }
}

impl FakeScanner {
    fn find_entry(&self, relative_path: &str) -> Option<PackageSignature> {
        self.entries
            .iter()
            .find(|entry| entry.relative_path == relative_path)
            .cloned()
    }
}

pub(crate) fn package(path: &str, size: u64, modified_nanos: u64) -> PackageSignature {
    PackageSignature {
        relative_path: path.to_owned(),
        kind: EntryKind::Package,
        size,
        modified_nanos,
    }
}

pub(crate) fn sidecar(path: &str, size: u64, modified_nanos: u64) -> PackageSignature {
    PackageSignature {
        relative_path: path.to_owned(),
        kind: EntryKind::Sidecar,
        size,
        modified_nanos,
    }
}

pub(crate) fn header(package_name: &str, classes: &[&str], names: &[&str]) -> HeaderEvidence {
    HeaderEvidence {
        header_data: None,
        profile_version: INDEX_PROFILE_VERSION,
        package_name: package_name.to_owned(),
        classes: classes.iter().map(|value| (*value).to_owned()).collect(),
        serialized_names: names.iter().map(|value| (*value).to_owned()).collect(),
        dependencies: Vec::new(),
        failure_code: None,
    }
}

pub(crate) fn fixture_project_id() -> ProjectId {
    project_id_from_root(FIXTURE_PROJECT_ROOT)
}

pub(crate) fn completed_summary(events: &[RefreshEvent]) -> RefreshSummary {
    events
        .iter()
        .find_map(|event| match event {
            RefreshEvent::Completed { summary, .. } => Some(summary.clone()),
            _ => None,
        })
        .expect("refresh completed")
}

pub(crate) fn request(
    generation: Generation,
    kind: QueryKind,
    limit: usize,
    cursor: Option<String>,
) -> QueryRequest {
    QueryRequest {
        project_id: fixture_project_id(),
        expected_generation: generation,
        kind,
        limit,
        cursor,
        fields: HeaderFields::ALL,
    }
}

/// Walk every bounded page of one query and return the concatenated items.
pub(crate) fn collect_pages<C: Catalog>(
    catalog: &C,
    generation: Generation,
    kind: QueryKind,
    limit: usize,
) -> Vec<QueryItem> {
    collect_projected_pages(catalog, generation, kind, limit, HeaderFields::ALL)
}

/// [`collect_pages`] with header items projected to `fields`.
pub(crate) fn collect_projected_pages<C: Catalog>(
    catalog: &C,
    generation: Generation,
    kind: QueryKind,
    limit: usize,
    fields: HeaderFields,
) -> Vec<QueryItem> {
    let mut items = Vec::new();
    let mut cursor = None;
    loop {
        let page = query(
            catalog,
            &QueryRequest {
                fields,
                ..request(generation, kind.clone(), limit, cursor)
            },
        )
        .expect("bounded query page");
        assert!(
            page.items.len() <= limit,
            "page exceeded the requested limit"
        );
        assert_eq!(page.generation, generation);
        items.extend(page.items);
        match page.next_cursor {
            Some(next) => cursor = Some(next),
            None => break,
        }
    }
    items
}

pub(crate) fn refresh_fixture() -> FakeScanner {
    FakeScanner {
        entries: vec![
            package("Content/Maps/L_Fixture.umap", 10, 100),
            package("Content/Data/DT_Items.uasset", 20, 200),
            sidecar("Content/Data/DT_Items.uexp", 5, 200),
        ],
        headers: BTreeMap::from([
            (
                "Content/Maps/L_Fixture.umap".to_owned(),
                header("/Game/Maps/L_Fixture", &["/Script/Engine.World"], &[]),
            ),
            (
                "Content/Data/DT_Items.uasset".to_owned(),
                header(
                    "/Game/Data/DT_Items",
                    &["/Script/Engine.DataTable"],
                    &["TextProperty"],
                ),
            ),
        ]),
        ..FakeScanner::default()
    }
}

pub(crate) fn cold_refresh_then_warm_noop_reads_zero_headers<C: CatalogSnapshot>(
    make: impl Fn() -> C,
) {
    let mut catalog = make();
    let mut scanner = refresh_fixture();
    let header_data = uasset_inspection::package_header::PackageHeaderData {
        package_flags: 0x0004_0000,
        gatherable_text_data_count: 2,
        gatherable_text_data_offset: 1234,
        has_text_property: true,
    };
    scanner
        .headers
        .get_mut("Content/Data/DT_Items.uasset")
        .unwrap()
        .header_data = Some(header_data.clone());

    let cold = refresh(
        &mut catalog,
        &scanner,
        FIXTURE_PROJECT_ROOT,
        &CancellationToken::new(),
        |_| {},
    )
    .expect("cold refresh");
    let cold_summary = completed_summary(&cold);
    assert_eq!(cold_summary.project_id, fixture_project_id());
    assert_eq!(cold_summary.generation, Generation::new(1));
    assert_eq!(cold_summary.package_count, 2);
    assert_eq!(cold_summary.map_count, 1);
    assert_eq!(cold_summary.changed_packages, 2);
    assert_eq!(cold_summary.completeness, Completeness::Complete);
    assert_eq!(scanner.header_reads.get(), 2);

    let retained = catalog
        .lookup_committed("Content/Data/DT_Items.uasset")
        .unwrap()
        .1
        .unwrap();
    assert_eq!(retained.header_data, Some(header_data.clone()));

    let warm = refresh(
        &mut catalog,
        &scanner,
        FIXTURE_PROJECT_ROOT,
        &CancellationToken::new(),
        |_| {},
    )
    .expect("warm refresh");
    let warm_summary = completed_summary(&warm);
    assert_eq!(warm_summary.generation, Generation::new(2));
    assert_eq!(warm_summary.changed_packages, 0);
    assert_eq!(warm_summary.removed_packages, 0);
    assert_eq!(scanner.header_reads.get(), 2);

    let page = query(
        &catalog,
        &request(
            Generation::new(2),
            QueryKind::ExactClasses {
                values: vec!["/Script/Engine.DataTable".into()],
            },
            10,
            None,
        ),
    )
    .unwrap();
    let QueryItem::Header {
        header_data: queried,
        ..
    } = &page.items[0]
    else {
        panic!("header expected")
    };
    assert_eq!(*queried, Some(header_data));

    match catalog.status() {
        CatalogStatus::Ready { summary } => assert_eq!(summary, warm_summary),
        CatalogStatus::Absent => panic!("committed generation must be reported as ready"),
    }
}

pub(crate) fn rebuild_clears_generation_before_cold_refresh<C: CatalogSnapshot>(
    make: impl Fn() -> C,
) {
    let mut catalog = make();
    let scanner = refresh_fixture();
    let first = refresh(
        &mut catalog,
        &scanner,
        FIXTURE_PROJECT_ROOT,
        &CancellationToken::new(),
        |_| {},
    )
    .expect("initial refresh");
    assert_eq!(completed_summary(&first).generation, Generation::new(1));
    let warm = refresh(
        &mut catalog,
        &scanner,
        FIXTURE_PROJECT_ROOT,
        &CancellationToken::new(),
        |_| {},
    )
    .expect("warm refresh");
    assert_eq!(completed_summary(&warm).generation, Generation::new(2));

    let rebuilt = rebuild(
        &mut catalog,
        &scanner,
        FIXTURE_PROJECT_ROOT,
        &CancellationToken::new(),
        |_| {},
    )
    .expect("rebuild");
    let summary = completed_summary(&rebuilt);
    assert_eq!(summary.generation, Generation::new(1));
    assert_eq!(summary.package_count, 2);
    assert_eq!(summary.removed_packages, 0);
}

pub(crate) fn changed_deleted_renamed_and_sidecar_updates_are_detected<C: CatalogSnapshot>(
    make: impl Fn() -> C,
) {
    let mut catalog = make();
    let mut scanner = FakeScanner {
        entries: vec![
            package("Content/A.uasset", 10, 1),
            package("Content/B.uasset", 10, 1),
            sidecar("Content/A.uexp", 2, 1),
        ],
        headers: BTreeMap::from([
            (
                "Content/A.uasset".to_owned(),
                header("/Game/A", &["/Script/Engine.DataTable"], &[]),
            ),
            (
                "Content/B.uasset".to_owned(),
                header("/Game/B", &["/Script/Engine.Texture2D"], &[]),
            ),
        ]),
        ..FakeScanner::default()
    };
    refresh(
        &mut catalog,
        &scanner,
        FIXTURE_PROJECT_ROOT,
        &CancellationToken::new(),
        |_| {},
    )
    .expect("initial refresh");

    scanner.entries = vec![
        package("Content/A.uasset", 11, 2), // changed
        package("Content/C.uasset", 10, 1), // rename B -> C
        sidecar("Content/A.uexp", 3, 2),    // sidecar-only change
    ];
    scanner.headers.insert(
        "Content/A.uasset".to_owned(),
        header("/Game/A", &["/Script/Engine.DataTable"], &["RowStruct"]),
    );
    scanner.headers.insert(
        "Content/C.uasset".to_owned(),
        header("/Game/C", &["/Script/Engine.Texture2D"], &[]),
    );

    let events = refresh(
        &mut catalog,
        &scanner,
        FIXTURE_PROJECT_ROOT,
        &CancellationToken::new(),
        |_| {},
    )
    .expect("delta refresh");
    let summary = completed_summary(&events);
    assert_eq!(summary.changed_packages, 2);
    assert_eq!(summary.removed_packages, 1);
    assert_eq!(summary.package_count, 2);
    assert_eq!(scanner.header_reads.get(), 4); // 2 cold + A + C

    let tables = collect_pages(
        &catalog,
        summary.generation,
        QueryKind::ExactClasses {
            values: vec!["/Script/Engine.DataTable".to_owned()],
        },
        10,
    );
    assert_eq!(
        tables.iter().map(item_path).collect::<Vec<_>>(),
        vec!["Content/A.uasset"]
    );
    let deleted = collect_pages(
        &catalog,
        summary.generation,
        QueryKind::ExactClasses {
            values: vec!["/Script/Engine.Texture2D".to_owned()],
        },
        10,
    );
    assert_eq!(
        deleted.iter().map(item_path).collect::<Vec<_>>(),
        vec!["Content/C.uasset"],
        "the renamed package replaces the removed one"
    );
    // The sidecar-only change updates inventory evidence without pretending it is a package.
    assert!(
        catalog
            .committed_relative_paths()
            .expect("committed paths")
            .contains(&"Content/A.uexp".to_owned())
    );
}

pub(crate) fn cancellation_discards_staging_and_keeps_prior_generation<C: CatalogSnapshot>(
    make: impl Fn() -> C,
) {
    let mut catalog = make();
    let scanner = refresh_fixture();
    let first = refresh(
        &mut catalog,
        &scanner,
        FIXTURE_PROJECT_ROOT,
        &CancellationToken::new(),
        |_| {},
    )
    .expect("first refresh");
    let generation = completed_summary(&first).generation;
    let committed_paths = catalog.committed_relative_paths().expect("committed paths");

    let cancellation = CancellationToken::new();
    cancellation.cancel();
    let error = refresh(
        &mut catalog,
        &scanner,
        FIXTURE_PROJECT_ROOT,
        &cancellation,
        |_| {},
    )
    .expect_err("cancelled refresh");
    assert!(matches!(error, CoordinatorError::Cancelled { .. }));
    assert_eq!(catalog.committed_generation(), Some(generation));
    assert_eq!(
        catalog.committed_relative_paths().expect("committed paths"),
        committed_paths
    );
    assert!(
        query(&catalog, &request(generation, QueryKind::Maps, 10, None)).is_ok(),
        "the prior generation stays queryable after cancellation"
    );

    // A later refresh still succeeds and advances exactly one generation.
    let resumed = refresh(
        &mut catalog,
        &scanner,
        FIXTURE_PROJECT_ROOT,
        &CancellationToken::new(),
        |_| {},
    )
    .expect("refresh after cancellation");
    assert_eq!(completed_summary(&resumed).generation, generation.next());
}

pub(crate) fn injected_failure_keeps_prior_generation_and_deletes_nothing<C: CatalogSnapshot>(
    make: impl Fn() -> C,
) {
    let mut catalog = make();
    let mut scanner = refresh_fixture();
    let first = refresh(
        &mut catalog,
        &scanner,
        FIXTURE_PROJECT_ROOT,
        &CancellationToken::new(),
        |_| {},
    )
    .expect("first refresh");
    let generation = completed_summary(&first).generation;
    let committed_paths = catalog.committed_relative_paths().expect("committed paths");

    // A package that keeps changing under the header read fails the whole refresh.
    scanner.entries = vec![package("Content/Data/DT_Items.uasset", 21, 201)];
    scanner.unstable = BTreeSet::from(["Content/Data/DT_Items.uasset".to_owned()]);
    let error = refresh(
        &mut catalog,
        &scanner,
        FIXTURE_PROJECT_ROOT,
        &CancellationToken::new(),
        |_| {},
    )
    .expect_err("unstable refresh");
    assert!(matches!(error, CoordinatorError::Unavailable { .. }));
    assert_eq!(catalog.committed_generation(), Some(generation));
    assert_eq!(
        catalog.committed_relative_paths().expect("committed paths"),
        committed_paths,
        "a failed refresh must not delete unseen packages"
    );
    let maps = collect_pages(&catalog, generation, QueryKind::Maps, 10);
    assert_eq!(maps.len(), 1);
}

pub(crate) fn stale_generation_queries_fail_explicitly_and_ordering_is_stable<
    C: CatalogSnapshot,
>(
    make: impl Fn() -> C,
) {
    let mut catalog = make();
    let scanner = FakeScanner {
        entries: vec![
            package("Content/B.uasset", 10, 1),
            package("Content/A.uasset", 10, 1),
        ],
        headers: BTreeMap::from([
            (
                "Content/A.uasset".to_owned(),
                header("/Game/A", &["/Script/Engine.DataTable"], &[]),
            ),
            (
                "Content/B.uasset".to_owned(),
                header("/Game/B", &["/Script/Engine.DataTable"], &[]),
            ),
        ]),
        ..FakeScanner::default()
    };
    let summary = completed_summary(
        &refresh(
            &mut catalog,
            &scanner,
            FIXTURE_PROJECT_ROOT,
            &CancellationToken::new(),
            |_| {},
        )
        .expect("refresh"),
    );
    let items = collect_pages(
        &catalog,
        summary.generation,
        QueryKind::ExactClasses {
            values: vec!["/Script/Engine.DataTable".to_owned()],
        },
        10,
    );
    assert_eq!(
        items.iter().map(item_path).collect::<Vec<_>>(),
        vec!["Content/A.uasset", "Content/B.uasset"],
        "pages are ordered by project-relative path regardless of enumeration order"
    );

    let stale = query(
        &catalog,
        &request(Generation::new(99), QueryKind::Maps, 10, None),
    )
    .expect_err("stale generation");
    assert!(matches!(
        stale,
        CoordinatorError::Catalog(CatalogError::StaleGeneration { .. })
    ));
}

pub(crate) fn signature_revalidation_rejects_unstable_packages<C: CatalogSnapshot>(
    make: impl Fn() -> C,
) {
    let mut catalog = make();
    let scanner = FakeScanner {
        entries: vec![package("Content/A.uasset", 10, 1)],
        headers: BTreeMap::from([(
            "Content/A.uasset".to_owned(),
            header("/Game/A", &["/Script/Engine.DataTable"], &[]),
        )]),
        unstable: BTreeSet::from(["Content/A.uasset".to_owned()]),
        ..FakeScanner::default()
    };
    let error = refresh(
        &mut catalog,
        &scanner,
        FIXTURE_PROJECT_ROOT,
        &CancellationToken::new(),
        |_| {},
    )
    .expect_err("unstable signature");
    assert!(matches!(error, CoordinatorError::Unavailable { .. }));
    assert!(matches!(catalog.status(), CatalogStatus::Absent));
}

pub(crate) fn every_query_kind_answers_from_committed_evidence<C: CatalogSnapshot>(
    make: impl Fn() -> C,
) {
    let mut catalog = make();
    let scanner = FakeScanner {
        entries: vec![
            package("Content/Input/IA_Move.uasset", 10, 1),
            package("Content/Maps/L_Alpha.umap", 10, 1),
            package("Content/Maps/L_Beta.umap", 10, 1),
            package("Content/Text/DT_Lines.uasset", 10, 1),
        ],
        headers: BTreeMap::from([
            (
                "Content/Input/IA_Move.uasset".to_owned(),
                header(
                    "/Game/Input/IA_Move",
                    &["/Script/EnhancedInput.InputAction"],
                    &["Triggers"],
                ),
            ),
            (
                "Content/Maps/L_Alpha.umap".to_owned(),
                header("/Game/Maps/L_Alpha", &["/Script/Engine.World"], &[]),
            ),
            (
                "Content/Maps/L_Beta.umap".to_owned(),
                header("", &["/Script/Engine.World"], &[]),
            ),
            (
                "Content/Text/DT_Lines.uasset".to_owned(),
                header(
                    "/Game/Text/DT_Lines",
                    &["/Script/Engine.DataTable"],
                    &["TextProperty"],
                ),
            ),
        ]),
        ..FakeScanner::default()
    };
    let summary = completed_summary(
        &refresh(
            &mut catalog,
            &scanner,
            FIXTURE_PROJECT_ROOT,
            &CancellationToken::new(),
            |_| {},
        )
        .expect("refresh"),
    );
    let generation = summary.generation;

    let maps = collect_pages(&catalog, generation, QueryKind::Maps, 10);
    assert_eq!(
        maps,
        vec![
            QueryItem::Map {
                map_path: "Content/Maps/L_Alpha.umap".to_owned(),
                package_name: "/Game/Maps/L_Alpha".to_owned()
            },
            QueryItem::Map {
                // An empty package name falls back to the project-relative path.
                map_path: "Content/Maps/L_Beta.umap".to_owned(),
                package_name: "Content/Maps/L_Beta.umap".to_owned()
            }
        ]
    );

    let prefixes = collect_pages(
        &catalog,
        generation,
        QueryKind::ClassPrefixes {
            values: vec!["/Script/EnhancedInput.".to_owned()],
        },
        10,
    );
    assert_eq!(
        prefixes.iter().map(item_path).collect::<Vec<_>>(),
        vec!["Content/Input/IA_Move.uasset"]
    );

    let suffixes = collect_pages(
        &catalog,
        generation,
        QueryKind::ClassNameSuffixes {
            values: vec!["Table".to_owned()],
        },
        10,
    );
    assert_eq!(
        suffixes.iter().map(item_path).collect::<Vec<_>>(),
        vec!["Content/Text/DT_Lines.uasset"]
    );

    let names = collect_pages(
        &catalog,
        generation,
        QueryKind::SerializedNames {
            values: vec!["TextProperty".to_owned()],
        },
        10,
    );
    assert_eq!(
        names.iter().map(item_path).collect::<Vec<_>>(),
        vec!["Content/Text/DT_Lines.uasset"]
    );

    let exact = collect_pages(
        &catalog,
        generation,
        QueryKind::ExactClasses {
            values: vec!["/Script/Engine.World".to_owned()],
        },
        10,
    );
    assert_eq!(
        exact.iter().map(item_path).collect::<Vec<_>>(),
        vec!["Content/Maps/L_Alpha.umap", "Content/Maps/L_Beta.umap"]
    );
    match &exact[0] {
        QueryItem::Header {
            header_data: _,
            package_name,
            classes,
            serialized_names,
            ..
        } => {
            assert_eq!(package_name, "/Game/Maps/L_Alpha");
            assert_eq!(classes, &vec!["/Script/Engine.World".to_owned()]);
            assert!(serialized_names.is_empty());
        }
        QueryItem::Map { .. } | QueryItem::Inventory { .. } | QueryItem::Package { .. } => {
            panic!("class queries return header items")
        }
    }
}

pub(crate) fn bounded_pages_walk_one_generation_in_stable_order<C: CatalogSnapshot>(
    make: impl Fn() -> C,
) {
    let mut catalog = make();
    let mut entries = Vec::new();
    let mut headers = BTreeMap::new();
    for index in 0..7 {
        let path = format!("Content/Batch/DT_{index:02}.uasset");
        entries.push(package(&path, 10, 1));
        headers.insert(
            path,
            header(
                &format!("/Game/Batch/DT_{index:02}"),
                &["/Script/Engine.DataTable"],
                &[],
            ),
        );
    }
    let scanner = FakeScanner {
        entries,
        headers,
        ..FakeScanner::default()
    };
    let summary = completed_summary(
        &refresh(
            &mut catalog,
            &scanner,
            FIXTURE_PROJECT_ROOT,
            &CancellationToken::new(),
            |_| {},
        )
        .expect("refresh"),
    );
    let expected: Vec<String> = (0..7)
        .map(|index| format!("Content/Batch/DT_{index:02}.uasset"))
        .collect();
    for limit in [1, 2, 3, 7, 10] {
        let items = collect_pages(
            &catalog,
            summary.generation,
            QueryKind::ExactClasses {
                values: vec!["/Script/Engine.DataTable".to_owned()],
            },
            limit,
        );
        assert_eq!(
            items.iter().map(item_path).collect::<Vec<_>>(),
            expected.iter().map(String::as_str).collect::<Vec<_>>(),
            "page size {limit} must not change the ordered result set"
        );
    }

    for limit in [0, PROJECT_INDEX_MAX_PAGE_SIZE + 1] {
        let rejected = query(
            &catalog,
            &request(summary.generation, QueryKind::Maps, limit, None),
        )
        .expect_err("page limit must stay bounded");
        assert!(matches!(
            rejected,
            CoordinatorError::Catalog(CatalogError::InvalidRequest { .. })
        ));
    }

    let rejected = query(
        &catalog,
        &request(
            summary.generation,
            QueryKind::Maps,
            10,
            Some("not-a-cursor/\u{1}".to_owned()),
        ),
    )
    .expect_err("an unusable cursor is rejected");
    assert!(matches!(
        rejected,
        CoordinatorError::Catalog(CatalogError::InvalidRequest { .. })
    ));
}

pub(crate) fn absent_catalog_and_unknown_project_are_explicit<C: CatalogSnapshot>(
    make: impl Fn() -> C,
) {
    let mut catalog = make();
    assert!(matches!(catalog.status(), CatalogStatus::Absent));
    assert_eq!(catalog.committed_generation(), None);
    assert!(
        catalog
            .committed_relative_paths()
            .expect("committed paths")
            .is_empty()
    );
    let absent = query(
        &catalog,
        &request(Generation::new(1), QueryKind::Maps, 10, None),
    )
    .expect_err("no committed generation");
    assert!(matches!(
        absent,
        CoordinatorError::Catalog(CatalogError::InvalidRequest { .. })
    ));

    let scanner = refresh_fixture();
    let summary = completed_summary(
        &refresh(
            &mut catalog,
            &scanner,
            FIXTURE_PROJECT_ROOT,
            &CancellationToken::new(),
            |_| {},
        )
        .expect("refresh"),
    );
    let mut foreign = request(summary.generation, QueryKind::Maps, 10, None);
    foreign.project_id = ProjectId::new("c:/another-project");
    let rejected = query(&catalog, &foreign).expect_err("unknown project identity");
    assert!(matches!(
        rejected,
        CoordinatorError::Catalog(CatalogError::InvalidRequest { .. })
    ));
}

pub(crate) fn stale_index_profile_rebuilds_header_evidence_only<C: CatalogSnapshot>(
    make: impl Fn() -> C,
) {
    let mut catalog = make();
    let signature = package("Content/A.uasset", 10, 1);
    let scanner = FakeScanner {
        entries: vec![signature.clone()],
        headers: BTreeMap::from([(
            "Content/A.uasset".to_owned(),
            header("/Game/A", &["/Script/Engine.DataTable"], &["RowStruct"]),
        )]),
        ..FakeScanner::default()
    };

    // Commit evidence captured for a narrower profile without touching the coordinator.
    let token = catalog.begin_refresh().expect("staging");
    let generation = Generation::new(1);
    catalog
        .stage_observed(
            &token,
            StagedPackage {
                signature: signature.clone(),
                header: Some(HeaderEvidence {
                    header_data: None,
                    profile_version: INDEX_PROFILE_VERSION.saturating_sub(1),
                    package_name: "/Game/A".to_owned(),
                    classes: Vec::new(),
                    serialized_names: Vec::new(),
                    dependencies: Vec::new(),
                    failure_code: None,
                }),
            },
        )
        .expect("stage narrow evidence");
    catalog
        .commit_refresh(
            token,
            RefreshSummary {
                project_id: fixture_project_id(),
                generation,
                package_count: 1,
                map_count: 0,
                changed_packages: 1,
                removed_packages: 0,
                completeness: Completeness::Complete,
                diagnostics: Vec::new(),
                omitted_diagnostics: 0,
                mounts: vec![MountPoint::game()],
                inventory_digest: None,
            },
        )
        .expect("commit narrow evidence");
    assert_eq!(
        catalog
            .lookup_committed("Content/A.uasset")
            .map(|row| row.0),
        Some(signature.clone()),
        "the reusable signature survives a narrower profile"
    );

    let events = refresh(
        &mut catalog,
        &scanner,
        FIXTURE_PROJECT_ROOT,
        &CancellationToken::new(),
        |_| {},
    )
    .expect("profile upgrade refresh");
    let summary = completed_summary(&events);
    assert_eq!(summary.changed_packages, 1);
    assert_eq!(summary.removed_packages, 0);
    assert!(
        completed_changes(&events).changed.is_empty(),
        "re-reading for a new profile is not a change on disk"
    );
    assert_eq!(
        scanner.header_reads.get(),
        1,
        "a stale profile rebuilds header evidence exactly once"
    );
    let (committed_signature, committed_header) = catalog
        .lookup_committed("Content/A.uasset")
        .expect("committed row");
    assert_eq!(committed_signature, signature);
    let committed_header = committed_header.expect("rebuilt header evidence");
    assert_eq!(committed_header.profile_version, INDEX_PROFILE_VERSION);
    assert_eq!(
        committed_header.classes,
        vec!["/Script/Engine.DataTable".to_owned()]
    );
    let items = collect_pages(
        &catalog,
        summary.generation,
        QueryKind::SerializedNames {
            values: vec!["RowStruct".to_owned()],
        },
        10,
    );
    assert_eq!(items.len(), 1);
}

pub(crate) fn warm_refresh_retries_failed_headers<C: CatalogSnapshot>(make: impl Fn() -> C) {
    let mut catalog = make();
    let path = "Content/Retry.uasset";
    let mut scanner = FakeScanner {
        entries: vec![package(path, 10, 1)],
        ..Default::default()
    };
    let cancellation = CancellationToken::new();
    for expected_reads in 1..=2 {
        let events = refresh(
            &mut catalog,
            &scanner,
            FIXTURE_PROJECT_ROOT,
            &cancellation,
            &mut |_| {},
        )
        .expect("refresh with failed header");
        let summary = completed_summary(&events);
        assert_eq!(summary.completeness, Completeness::Partial);
        assert_eq!(summary.diagnostics.len(), 1);
        assert_eq!(scanner.header_reads.get(), expected_reads);
    }
    scanner
        .headers
        .insert(path.to_owned(), header("/Game/Retry", &[], &[]));
    let events = refresh(
        &mut catalog,
        &scanner,
        FIXTURE_PROJECT_ROOT,
        &cancellation,
        &mut |_| {},
    )
    .expect("retry recovered header without signature change");
    let summary = completed_summary(&events);
    assert_eq!(summary.completeness, Completeness::Complete);
    assert!(summary.diagnostics.is_empty());
    assert_eq!(scanner.header_reads.get(), 3);
}

/// Run the adapter-neutral Catalog conformance suite against one adapter factory.
pub(crate) fn inventory_retains_package_and_sidecar_signatures<C: CatalogSnapshot>(
    make: impl Fn() -> C,
) {
    let mut catalog = make();
    let mut scanner = refresh_fixture();
    let path = scanner
        .entries
        .iter()
        .find(|entry| entry.kind == EntryKind::Package)
        .unwrap()
        .relative_path
        .clone();
    let stem = path.rsplit_once('.').unwrap().0;
    scanner
        .entries
        .push(sidecar(&format!("{stem}.uexp"), 123, 456_000_000));
    let events = refresh(
        &mut catalog,
        &scanner,
        FIXTURE_PROJECT_ROOT,
        &CancellationToken::new(),
        |_| {},
    )
    .unwrap();
    let summary = completed_summary(&events);
    let reads = scanner.header_reads.get();
    let inventory = collect_pages(&catalog, summary.generation, QueryKind::Inventory, 1);
    assert_eq!(inventory.len() as u64, summary.package_count);
    let item = inventory
        .iter()
        .find(|item| item_path(item) == path)
        .unwrap();
    let QueryItem::Inventory { signature, .. } = item else {
        panic!("inventory row")
    };
    let stamps: serde_json::Value = serde_json::from_str(signature).unwrap();
    assert_eq!(stamps[1]["size"], 123.0);
    assert_eq!(stamps[1]["modifiedMs"], 456.0);
    assert!(stamps[2].is_null() && stamps[3].is_null());
    assert_eq!(scanner.header_reads.get(), reads);
    let page = catalog.query(&QueryRequest {
        project_id: summary.project_id,
        expected_generation: summary.generation.next(),
        kind: QueryKind::Inventory,
        limit: 1,
        cursor: None,
        fields: HeaderFields::ALL,
    });
    assert!(matches!(page, Err(CatalogError::StaleGeneration { .. })));
}

pub(crate) fn deleting_only_a_sidecar_drops_its_signature<C: CatalogSnapshot>(
    make: impl Fn() -> C,
) {
    let mut catalog = make();
    let mut scanner = refresh_fixture();
    let path = scanner
        .entries
        .iter()
        .find(|entry| entry.kind == EntryKind::Package)
        .unwrap()
        .relative_path
        .clone();
    let sidecar_path = format!("{}.uexp", path.rsplit_once('.').unwrap().0);
    scanner
        .entries
        .push(sidecar(&sidecar_path, 123, 456_000_000));
    refresh(
        &mut catalog,
        &scanner,
        FIXTURE_PROJECT_ROOT,
        &CancellationToken::new(),
        |_| {},
    )
    .unwrap();
    // No package changes or disappears, so only the sidecar's removal differs.
    scanner
        .entries
        .retain(|entry| entry.relative_path != sidecar_path);
    let events = refresh(
        &mut catalog,
        &scanner,
        FIXTURE_PROJECT_ROOT,
        &CancellationToken::new(),
        |_| {},
    )
    .unwrap();
    let summary = completed_summary(&events);
    assert_eq!((summary.changed_packages, summary.removed_packages), (0, 0));
    assert!(
        !catalog
            .committed_relative_paths()
            .unwrap()
            .contains(&sidecar_path)
    );
    let inventory = collect_pages(&catalog, summary.generation, QueryKind::Inventory, 100);
    let QueryItem::Inventory { signature, .. } = inventory
        .iter()
        .find(|item| item_path(item) == path)
        .unwrap()
    else {
        panic!("inventory row")
    };
    let stamps: serde_json::Value = serde_json::from_str(signature).unwrap();
    assert!(stamps[1].is_null(), "stale sidecar stamp: {stamps}");
}

pub(crate) fn completed_changes(events: &[RefreshEvent]) -> RefreshChanges {
    events
        .iter()
        .find_map(|event| match event {
            RefreshEvent::Completed { changes, .. } => Some(changes.clone()),
            _ => None,
        })
        .expect("refresh completed")
}

fn dependency(package: &str, properties: u8) -> PackageDependency {
    PackageDependency::from_properties(package.to_owned(), properties)
}

fn black_eye() -> MountPoint {
    MountPoint {
        name: "/Black_Eye/".to_owned(),
        path: "Plugins/BlackEye/Content/".to_owned(),
    }
}

/// A plugin-inclusive project: two effects, a material, textures, and a plugin texture. Unreal's
/// property bits: hard 1, game 2, build 4.
pub(crate) fn dependency_fixture() -> FakeScanner {
    const NIAGARA: &str = "/Script/Niagara.NiagaraSystem";
    const TEXTURE: &str = "/Script/Engine.Texture2D";
    let with = |name: &str, class: &str, dependencies: Vec<PackageDependency>| {
        let mut evidence = header(name, &[class], &[]);
        evidence.dependencies = dependencies;
        evidence
    };
    let headers = [
        (
            "Content/VFX/NS_A.uasset",
            with(
                "/Game/VFX/NS_A",
                NIAGARA,
                vec![
                    dependency("/Black_Eye/T_Eye", 2),
                    dependency("/Game/Mat/M_A", 3),
                    dependency("/Game/Missing/T_Gone", 3),
                    dependency("/Game/Tex/T_Editor", 1),
                    dependency("/Script/Niagara", 3),
                ],
            ),
        ),
        (
            "Content/VFX/NS_B.uasset",
            with(
                "/Game/VFX/NS_B",
                NIAGARA,
                vec![dependency("/Game/Mat/M_A", 0)],
            ),
        ),
        (
            "Content/Mat/M_A.uasset",
            // Saved with another spelling of the texture's name; names ignore ASCII case.
            with(
                "/Game/Mat/M_A",
                "/Script/Engine.Material",
                vec![dependency("/game/tex/t_a", 3)],
            ),
        ),
        (
            "Content/Tex/T_A.uasset",
            with("/Game/Tex/T_A", TEXTURE, Vec::new()),
        ),
        (
            "Content/Tex/T_Editor.uasset",
            with("/Game/Tex/T_Editor", TEXTURE, Vec::new()),
        ),
        (
            "Plugins/BlackEye/Content/T_Eye.uasset",
            with("/Black_Eye/T_Eye", TEXTURE, Vec::new()),
        ),
    ];
    FakeScanner {
        entries: headers
            .iter()
            .map(|(path, _)| package(path, 1, 1))
            .collect(),
        headers: headers
            .into_iter()
            .map(|(path, header)| (path.to_owned(), header))
            .collect(),
        plugin_mounts: vec![black_eye()],
        ..FakeScanner::default()
    }
}

fn summary_pages<C: Catalog>(
    catalog: &C,
    summary: &RefreshSummary,
    kind: QueryKind,
    limit: usize,
) -> Vec<QueryItem> {
    let mut items = Vec::new();
    let mut cursor = None;
    loop {
        let page = query(
            catalog,
            &QueryRequest {
                project_id: summary.project_id.clone(),
                expected_generation: summary.generation,
                kind: kind.clone(),
                limit,
                cursor,
                fields: HeaderFields::ALL,
            },
        )
        .expect("dependency page");
        assert!(page.items.len() <= limit);
        items.extend(page.items);
        match page.next_cursor {
            Some(next) => cursor = Some(next),
            None => return items,
        }
    }
}

pub(crate) fn dependency_queries_walk_resolved_edges<C: CatalogSnapshot>(make: impl Fn() -> C) {
    let mut catalog = make();
    let scanner = dependency_fixture();
    let events = refresh(
        &mut catalog,
        &scanner,
        FIXTURE_PROJECT_ROOT,
        &CancellationToken::new(),
        |_| {},
    )
    .expect("refresh dependency fixture");
    let summary = completed_summary(&events);
    assert_eq!(summary.mounts, vec![MountPoint::game(), black_eye()]);
    let CatalogStatus::Ready { summary: status } = catalog.status() else {
        panic!("committed status");
    };
    assert_eq!(status.mounts, summary.mounts);

    let owned = |paths: &[&str]| paths.iter().map(|path| (*path).to_owned()).collect();
    let dependencies = |paths: &[&str], transitive, edges| QueryKind::Dependencies {
        paths: owned(paths),
        transitive,
        edges,
    };
    let dependents = |paths: &[&str], transitive, edges, classes: &[&str]| QueryKind::Dependents {
        paths: owned(paths),
        transitive,
        edges,
        classes: owned(classes),
    };
    let paths = |kind: QueryKind, limit| {
        summary_pages(&catalog, &summary, kind, limit)
            .iter()
            .map(|item| item_path(item).to_owned())
            .collect::<Vec<_>>()
    };
    let any = EdgeFilter::default();
    let game = EdgeFilter {
        game: Some(true),
        ..EdgeFilter::default()
    };
    let hard = EdgeFilter {
        hard: Some(true),
        ..EdgeFilter::default()
    };

    // A direct query returns the package itself, with each dependency and the indexed package it
    // names. Paths match without regard to ASCII case.
    let direct = summary_pages(
        &catalog,
        &summary,
        dependencies(&["content/vfx/ns_a.UASSET"], false, any),
        10,
    );
    let [
        QueryItem::Package {
            package_path,
            package_name,
            classes,
            dependencies: resolved,
            failure_code,
        },
    ] = direct.as_slice()
    else {
        panic!("one package item: {direct:?}");
    };
    assert_eq!(package_path, "Content/VFX/NS_A.uasset");
    assert_eq!(package_name, "/Game/VFX/NS_A");
    assert_eq!(classes, &["/Script/Niagara.NiagaraSystem".to_owned()]);
    assert_eq!(failure_code, &None);
    let resolved = resolved
        .iter()
        .map(|resolved| {
            (
                resolved.dependency.package.as_str(),
                resolved.dependency.properties(),
                resolved.package_path.as_deref(),
            )
        })
        .collect::<Vec<_>>();
    assert_eq!(
        resolved,
        [
            (
                "/Black_Eye/T_Eye",
                2,
                Some("Plugins/BlackEye/Content/T_Eye.uasset")
            ),
            ("/Game/Mat/M_A", 3, Some("Content/Mat/M_A.uasset")),
            ("/Game/Missing/T_Gone", 3, None),
            ("/Game/Tex/T_Editor", 1, Some("Content/Tex/T_Editor.uasset")),
            ("/Script/Niagara", 3, None),
        ]
    );

    for limit in [1, 2, 100] {
        assert_eq!(
            paths(dependencies(&["Content/VFX/NS_A.uasset"], true, any), limit),
            [
                "Content/Mat/M_A.uasset",
                "Content/Tex/T_A.uasset",
                "Content/Tex/T_Editor.uasset",
                "Content/VFX/NS_A.uasset",
                "Plugins/BlackEye/Content/T_Eye.uasset",
            ]
        );
    }
    assert_eq!(
        paths(dependencies(&["Content/VFX/NS_A.uasset"], true, game), 100),
        [
            "Content/Mat/M_A.uasset",
            "Content/Tex/T_A.uasset",
            "Content/VFX/NS_A.uasset",
            "Plugins/BlackEye/Content/T_Eye.uasset",
        ]
    );
    assert_eq!(
        paths(dependencies(&["Content/VFX/NS_A.uasset"], true, hard), 100),
        [
            "Content/Mat/M_A.uasset",
            "Content/Tex/T_A.uasset",
            "Content/Tex/T_Editor.uasset",
            "Content/VFX/NS_A.uasset",
        ]
    );
    assert!(paths(dependencies(&["Content/Nope.uasset"], true, any), 10).is_empty());

    let texture = "Content/Tex/T_A.uasset";
    for limit in [1, 100] {
        assert_eq!(
            paths(dependents(&[texture], true, any, &[]), limit),
            [
                "Content/Mat/M_A.uasset",
                "Content/VFX/NS_A.uasset",
                "Content/VFX/NS_B.uasset",
            ]
        );
    }
    assert_eq!(
        paths(dependents(&[texture], false, any, &[]), 100),
        ["Content/Mat/M_A.uasset"]
    );
    // The class filter keeps results, not the walk: the effects reach the texture through the
    // material.
    assert_eq!(
        paths(
            dependents(&[texture], true, any, &["/Script/Niagara.NiagaraSystem"]),
            100
        ),
        ["Content/VFX/NS_A.uasset", "Content/VFX/NS_B.uasset"]
    );
    assert_eq!(
        paths(dependents(&[texture], true, game, &[]), 100),
        ["Content/Mat/M_A.uasset", "Content/VFX/NS_A.uasset"]
    );
    // A deleted package still has dependents, found by the name its path would have.
    assert_eq!(
        paths(
            dependents(&["Content/Missing/T_Gone.uasset"], true, any, &[]),
            100
        ),
        ["Content/VFX/NS_A.uasset"]
    );
    assert_eq!(
        paths(
            dependents(&["plugins/blackeye/content/t_eye.uasset"], true, any, &[]),
            100
        ),
        ["Content/VFX/NS_A.uasset"]
    );
    assert!(paths(dependents(&["Config/DefaultGame.ini"], true, any, &[]), 10).is_empty());
}

pub(crate) fn refresh_reports_paths_changed_on_disk<C: CatalogSnapshot>(make: impl Fn() -> C) {
    let mut catalog = make();
    let mut scanner = refresh_fixture();
    let mut run = |scanner: &FakeScanner| {
        completed_changes(
            &refresh(
                &mut catalog,
                scanner,
                FIXTURE_PROJECT_ROOT,
                &CancellationToken::new(),
                |_| {},
            )
            .expect("refresh"),
        )
    };
    assert_eq!(
        run(&scanner),
        RefreshChanges {
            base_generation: None,
            changed: vec![
                "Content/Data/DT_Items.uasset".to_owned(),
                "Content/Data/DT_Items.uexp".to_owned(),
                "Content/Maps/L_Fixture.umap".to_owned(),
            ],
            removed: Vec::new(),
            complete: true,
            total: 3,
        }
    );
    assert_eq!(
        run(&scanner),
        RefreshChanges {
            base_generation: Some(Generation::new(1)),
            complete: true,
            ..RefreshChanges::default()
        }
    );
    scanner
        .entries
        .retain(|entry| entry.relative_path != "Content/Data/DT_Items.uexp");
    scanner
        .entries
        .iter_mut()
        .find(|entry| entry.relative_path == "Content/Data/DT_Items.uasset")
        .unwrap()
        .size = 21;
    scanner.entries.push(package("Content/New.uasset", 1, 1));
    scanner.headers.insert(
        "Content/New.uasset".to_owned(),
        header("/Game/New", &[], &[]),
    );
    assert_eq!(
        run(&scanner),
        RefreshChanges {
            base_generation: Some(Generation::new(2)),
            changed: vec![
                "Content/Data/DT_Items.uasset".to_owned(),
                "Content/New.uasset".to_owned(),
            ],
            removed: vec!["Content/Data/DT_Items.uexp".to_owned()],
            complete: true,
            total: 3,
        }
    );
}

/// Past its change limit a refresh lists no paths, says the report is incomplete and counts every
/// change; a limit the changes fit in lists them all.
pub(crate) fn change_reports_past_their_limit_count_the_changes<C: CatalogSnapshot>(
    make: impl Fn() -> C,
) {
    let scanner = refresh_fixture();
    let cancellation = CancellationToken::new();
    let mut catalog = make();
    let cut = completed_changes(
        &refresh_listing_changes(
            &mut catalog,
            &scanner,
            FIXTURE_PROJECT_ROOT,
            2,
            &cancellation,
            |_| {},
        )
        .expect("refresh past the change limit"),
    );
    assert_eq!(
        cut,
        RefreshChanges {
            base_generation: None,
            changed: Vec::new(),
            removed: Vec::new(),
            complete: false,
            total: 3,
        }
    );
    let listed = completed_changes(
        &rebuild_listing_changes(
            &mut catalog,
            &scanner,
            FIXTURE_PROJECT_ROOT,
            3,
            &cancellation,
            |_| {},
        )
        .expect("rebuild within the change limit"),
    );
    assert!(listed.complete);
    assert_eq!(listed.total, 3);
    assert_eq!(listed.changed.len(), 3);
}

/// A refresh keeps the first diagnostics and counts the rest, in its summary and in the status the
/// Catalog reports afterwards.
pub(crate) fn diagnostics_past_the_kept_ones_are_counted<C: CatalogSnapshot>(make: impl Fn() -> C) {
    let mut catalog = make();
    // No header fixtures: every package records a `header_read` diagnostic.
    let failing = PROJECT_INDEX_MAX_DIAGNOSTICS + 6;
    let scanner = FakeScanner {
        entries: (0..failing)
            .map(|index| package(&format!("Content/Failing/A{index:03}.uasset"), 1, 1))
            .collect(),
        ..Default::default()
    };
    let summary = completed_summary(
        &refresh(
            &mut catalog,
            &scanner,
            FIXTURE_PROJECT_ROOT,
            &CancellationToken::new(),
            |_| {},
        )
        .expect("refresh with failed headers"),
    );
    assert_eq!(summary.completeness, Completeness::Partial);
    assert_eq!(summary.diagnostics.len(), PROJECT_INDEX_MAX_DIAGNOSTICS);
    assert_eq!(summary.omitted_diagnostics, 6);
    match catalog.status() {
        CatalogStatus::Ready { summary: stored } => {
            assert_eq!(stored.diagnostics.len(), PROJECT_INDEX_MAX_DIAGNOSTICS);
            assert_eq!(stored.omitted_diagnostics, 6);
        }
        CatalogStatus::Absent => panic!("the refresh committed a generation"),
    }
}

/// Every page of the query kinds a refresh comparison checks, and the committed entries.
fn every_page<C: CatalogSnapshot>(catalog: &C) -> (Vec<CatalogSnapshotEntry>, Vec<Vec<QueryItem>>) {
    let generation = catalog
        .committed_generation()
        .expect("committed generation");
    let kinds = [
        QueryKind::Inventory,
        QueryKind::Maps,
        QueryKind::ClassPrefixes {
            values: vec![String::new()],
        },
        QueryKind::SerializedNames {
            values: vec!["TextProperty".to_owned(), "Name".to_owned()],
        },
    ];
    let pages = kinds
        .into_iter()
        .map(|kind| collect_pages(catalog, generation, kind, 2))
        .collect();
    (
        catalog.committed_entries().expect("committed entries"),
        pages,
    )
}

/// A targeted refresh told which paths changed gives exactly what a full walk gives (summary,
/// digest, change report, entries and pages) through edits, sidecar-only edits, deletes, re-adds
/// and new packages, and reads only the headers of the packages that changed.
pub(crate) fn targeted_refreshes_match_full_walks<C: CatalogSnapshot>(make: impl Fn() -> C) {
    let cancellation = CancellationToken::new();
    let mut targeted = make();
    let mut walked = make();
    let mut scanner = refresh_fixture();
    scanner
        .entries
        .push(package("Content/Data/DT_Other.uasset", 7, 7));
    scanner
        .entries
        .push(sidecar("Content/Data/DT_Other.ubulk", 3, 7));
    scanner.headers.insert(
        "Content/Data/DT_Other.uasset".to_owned(),
        header(
            "/Game/Data/DT_Other",
            &["/Script/Engine.DataTable"],
            &["Name"],
        ),
    );
    for catalog in [&mut targeted, &mut walked] {
        refresh(
            catalog,
            &scanner,
            FIXTURE_PROJECT_ROOT,
            &cancellation,
            |_| {},
        )
        .expect("initial refresh");
    }
    let set_header = |scanner: &mut FakeScanner, path: &str, name: &str, flags: u32| {
        let mut evidence = header(name, &["/Script/Engine.DataTable"], &["TextProperty"]);
        evidence.header_data = Some(uasset_inspection::package_header::PackageHeaderData {
            package_flags: flags,
            gatherable_text_data_count: flags,
            gatherable_text_data_offset: 64,
            has_text_property: true,
        });
        scanner.headers.insert(path.to_owned(), evidence);
    };
    type Step = (
        &'static str,
        Box<dyn Fn(&mut FakeScanner)>,
        Vec<String>,
        u64,
    );
    let steps: Vec<Step> = vec![
        (
            "a package edit",
            Box::new(move |scanner: &mut FakeScanner| {
                let entry = scanner
                    .entries
                    .iter_mut()
                    .find(|entry| entry.relative_path == "Content/Data/DT_Items.uasset")
                    .unwrap();
                entry.size += 1;
                set_header(
                    scanner,
                    "Content/Data/DT_Items.uasset",
                    "/Game/Data/DT_Items",
                    4,
                );
            }),
            vec!["Content/Data/DT_Items.uasset".to_owned()],
            1,
        ),
        (
            "a sidecar-only edit, named by an absolute path with backslashes",
            Box::new(|scanner: &mut FakeScanner| {
                scanner
                    .entries
                    .iter_mut()
                    .find(|entry| entry.relative_path == "Content/Data/DT_Items.uexp")
                    .unwrap()
                    .modified_nanos += 5;
            }),
            vec![format!(
                "{FIXTURE_PROJECT_ROOT}\\Content\\Data\\DT_Items.uexp"
            )],
            0,
        ),
        (
            "a deleted bundle, with unchanged and unrelated paths",
            Box::new(|scanner: &mut FakeScanner| {
                scanner
                    .entries
                    .retain(|entry| !entry.relative_path.starts_with("Content/Data/DT_Other."));
            }),
            vec![
                "Content/Data/DT_Other.uasset".to_owned(),
                "./Content/Data/DT_Other.ubulk".to_owned(),
                "Content/Maps/L_Fixture.umap".to_owned(),
                "Config/DefaultGame.ini".to_owned(),
                "Content/Data/DT_Other.uasset".to_owned(),
            ],
            0,
        ),
        (
            "a re-added bundle with a new header",
            Box::new(move |scanner: &mut FakeScanner| {
                scanner
                    .entries
                    .push(package("Content/Data/DT_Other.uasset", 9, 9));
                scanner
                    .entries
                    .push(sidecar("Content/Data/DT_Other.ubulk", 4, 9));
                set_header(
                    scanner,
                    "Content/Data/DT_Other.uasset",
                    "/Game/Data/DT_Other",
                    2,
                );
            }),
            vec!["Content/Data/DT_Other.ubulk".to_owned()],
            1,
        ),
        (
            "a new map and a removed sidecar",
            Box::new(|scanner: &mut FakeScanner| {
                scanner
                    .entries
                    .push(package("Content/Maps/L_New.umap", 3, 3));
                scanner.headers.insert(
                    "Content/Maps/L_New.umap".to_owned(),
                    header("/Game/Maps/L_New", &["/Script/Engine.World"], &[]),
                );
                scanner
                    .entries
                    .retain(|entry| entry.relative_path != "Content/Data/DT_Items.uexp");
            }),
            vec![
                "Content/Maps/L_New.umap".to_owned(),
                "Content/Data/DT_Items.uexp".to_owned(),
            ],
            1,
        ),
        (
            "nothing changed",
            Box::new(|_: &mut FakeScanner| {}),
            vec!["Content/Maps/L_New.umap".to_owned()],
            0,
        ),
    ];
    for (step, change, changed_paths, expected_reads) in steps {
        change(&mut scanner);
        let reads = scanner.header_reads.get();
        let (events, reach) = refresh_changed_paths(
            &mut targeted,
            &scanner,
            FIXTURE_PROJECT_ROOT,
            &changed_paths,
            super::catalog::PROJECT_INDEX_MAX_REPORTED_CHANGES,
            &cancellation,
            |_| {},
        )
        .expect("targeted refresh");
        assert_eq!(reach, RefreshReach::Targeted, "{step}");
        assert_eq!(scanner.header_reads.get() - reads, expected_reads, "{step}");
        let walked_events = refresh(
            &mut walked,
            &scanner,
            FIXTURE_PROJECT_ROOT,
            &cancellation,
            |_| {},
        )
        .expect("walked refresh");
        assert_eq!(
            completed_summary(&events),
            completed_summary(&walked_events),
            "{step}"
        );
        assert!(
            completed_summary(&events).inventory_digest.is_some(),
            "{step}"
        );
        assert_eq!(
            completed_changes(&events),
            completed_changes(&walked_events),
            "{step}"
        );
        assert_eq!(targeted.status(), walked.status(), "{step}");
        assert_eq!(every_page(&targeted), every_page(&walked), "{step}");
    }
}

/// A refresh given changed paths walks the project whenever the paths alone could miss a change.
pub(crate) fn targeted_refresh_walks_when_unsure<C: CatalogSnapshot>(make: impl Fn() -> C) {
    let cancellation = CancellationToken::new();
    let mut catalog = make();
    let mut scanner = refresh_fixture();
    let run = |catalog: &mut C, scanner: &FakeScanner, paths: &[&str]| {
        let paths = paths
            .iter()
            .map(|path| (*path).to_owned())
            .collect::<Vec<_>>();
        refresh_changed_paths(
            catalog,
            scanner,
            FIXTURE_PROJECT_ROOT,
            &paths,
            super::catalog::PROJECT_INDEX_MAX_REPORTED_CHANGES,
            &cancellation,
            |_| {},
        )
        .expect("refresh")
        .1
    };
    assert_eq!(
        run(&mut catalog, &scanner, &["Content/Maps/L_Fixture.umap"]),
        RefreshReach::Walked(Some("no_committed_generation"))
    );
    assert_eq!(run(&mut catalog, &scanner, &[]), RefreshReach::Walked(None));
    for (paths, reason) in [
        (vec!["Content/Data/"], "changed_path_is_a_directory"),
        (vec!["Content/Data"], "changed_path_may_be_a_directory"),
        (
            vec!["Content/../Content/A.uasset"],
            "changed_path_is_not_canonical",
        ),
        (vec!["Fixture.uproject"], "descriptor_changed"),
        (
            vec!["content/Maps/L_Fixture.umap"],
            "changed_path_case_differs",
        ),
    ] {
        assert_eq!(
            run(&mut catalog, &scanner, &paths),
            RefreshReach::Walked(Some(reason)),
            "{paths:?}"
        );
    }
    let many = (0..=super::project_index::PROJECT_INDEX_MAX_TARGETED_PATHS)
        .map(|index| format!("Content/P{index}.uasset"))
        .collect::<Vec<_>>();
    let many = many.iter().map(String::as_str).collect::<Vec<_>>();
    assert_eq!(
        run(&mut catalog, &scanner, &many),
        RefreshReach::Walked(Some("too_many_changed_paths"))
    );
    // A file the walk ignores, and a path outside every content root, change nothing.
    scanner
        .ignored_files
        .insert("Content/Data/readme.txt".to_owned());
    assert_eq!(
        run(
            &mut catalog,
            &scanner,
            &["Content/Data/readme.txt", "Saved/Logs/Fixture.log"]
        ),
        RefreshReach::Targeted
    );
    // A partial generation holds header failures only a walk rereads.
    scanner
        .fail_after_header
        .insert("Content/Maps/L_Fixture.umap".to_owned());
    scanner.entries[0].modified_nanos += 1;
    assert_eq!(
        run(&mut catalog, &scanner, &["Content/Maps/L_Fixture.umap"]),
        RefreshReach::Targeted
    );
    assert_eq!(
        run(&mut catalog, &scanner, &["Content/Data/DT_Items.uasset"]),
        RefreshReach::Walked(Some("committed_generation_is_partial"))
    );
    scanner.fail_after_header.clear();
    run(&mut catalog, &scanner, &[]);
    // Mount points that changed need a walk.
    scanner.plugin_mounts.push(MountPoint {
        name: "/Extra/".to_owned(),
        path: "Plugins/Extra/Content/".to_owned(),
    });
    assert_eq!(
        run(&mut catalog, &scanner, &["Content/Maps/L_Fixture.umap"]),
        RefreshReach::Walked(Some("mount_points_changed"))
    );
}

/// The inventory digest depends on the inventory alone: the same files give the same digest after
/// a first refresh, a no-op refresh, edits that are undone, and a rebuild; any change to a package
/// path, a sidecar's size or time, or header data changes it.
pub(crate) fn inventory_digest_depends_only_on_the_inventory<C: CatalogSnapshot>(
    make: impl Fn() -> C,
) {
    let cancellation = CancellationToken::new();
    let digest = |catalog: &C| match catalog.status() {
        CatalogStatus::Ready { summary } => summary.inventory_digest.expect("complete digest"),
        CatalogStatus::Absent => panic!("no committed generation"),
    };
    let mut scanner = refresh_fixture();
    let data = uasset_inspection::package_header::PackageHeaderData {
        package_flags: 1,
        gatherable_text_data_count: 2,
        gatherable_text_data_offset: 3,
        has_text_property: true,
    };
    scanner
        .headers
        .get_mut("Content/Data/DT_Items.uasset")
        .unwrap()
        .header_data = Some(data.clone());
    let original = scanner.entries.clone();
    let mut catalog = make();
    refresh(
        &mut catalog,
        &scanner,
        FIXTURE_PROJECT_ROOT,
        &cancellation,
        |_| {},
    )
    .unwrap();
    let first = digest(&catalog);
    assert_eq!(first.len(), 64);
    refresh(
        &mut catalog,
        &scanner,
        FIXTURE_PROJECT_ROOT,
        &cancellation,
        |_| {},
    )
    .unwrap();
    assert_eq!(digest(&catalog), first, "a no-op refresh");
    let mut seen = vec![first.clone()];
    type Change = (&'static str, Box<dyn Fn(&mut FakeScanner)>);
    let changes: Vec<Change> = vec![
        (
            "a package path",
            Box::new(|scanner: &mut FakeScanner| {
                let entry = scanner
                    .entries
                    .iter_mut()
                    .find(|entry| entry.relative_path == "Content/Maps/L_Fixture.umap")
                    .unwrap();
                entry.relative_path = "Content/Maps/L_Moved.umap".to_owned();
                let evidence = scanner.headers["Content/Maps/L_Fixture.umap"].clone();
                scanner
                    .headers
                    .insert("Content/Maps/L_Moved.umap".to_owned(), evidence);
            }),
        ),
        (
            "a sidecar's size",
            Box::new(|scanner: &mut FakeScanner| scanner.entries[2].size += 1),
        ),
        (
            "a sidecar's modified time",
            Box::new(|scanner: &mut FakeScanner| scanner.entries[2].modified_nanos += 1),
        ),
        (
            "header data",
            Box::new(|scanner: &mut FakeScanner| {
                scanner.entries[1].modified_nanos += 1;
                scanner
                    .headers
                    .get_mut("Content/Data/DT_Items.uasset")
                    .unwrap()
                    .header_data
                    .as_mut()
                    .unwrap()
                    .package_flags ^= 0x40000;
            }),
        ),
    ];
    for (what, change) in changes {
        let mut changed = refresh_fixture();
        changed.headers = scanner.headers.clone();
        changed.entries = original.clone();
        change(&mut changed);
        refresh(
            &mut catalog,
            &changed,
            FIXTURE_PROJECT_ROOT,
            &cancellation,
            |_| {},
        )
        .unwrap();
        let after = digest(&catalog);
        assert!(!seen.contains(&after), "changing {what} changed the digest");
        seen.push(after);
        // Undoing the change gives the first digest back, generations later.
        refresh(
            &mut catalog,
            &scanner,
            FIXTURE_PROJECT_ROOT,
            &cancellation,
            |_| {},
        )
        .unwrap();
        assert_eq!(digest(&catalog), first, "undoing {what}");
    }
    rebuild(
        &mut catalog,
        &scanner,
        FIXTURE_PROJECT_ROOT,
        &cancellation,
        |_| {},
    )
    .unwrap();
    assert_eq!(digest(&catalog), first, "a rebuild");
    let mut fresh = make();
    refresh(
        &mut fresh,
        &scanner,
        FIXTURE_PROJECT_ROOT,
        &cancellation,
        |_| {},
    )
    .unwrap();
    assert_eq!(digest(&fresh), first, "another Catalog");
    // A partial generation has no digest.
    scanner
        .fail_after_header
        .insert("Content/Maps/L_Fixture.umap".to_owned());
    scanner.entries[0].modified_nanos += 1;
    refresh(
        &mut catalog,
        &scanner,
        FIXTURE_PROJECT_ROOT,
        &cancellation,
        |_| {},
    )
    .unwrap();
    match catalog.status() {
        CatalogStatus::Ready { summary } => assert_eq!(summary.inventory_digest, None),
        CatalogStatus::Absent => panic!("no committed generation"),
    }
}

macro_rules! catalog_conformance_tests {
    ($module:ident, $make:expr) => {
        mod $module {
            #[allow(unused_imports)]
            use super::*;
            use crate::direct_executor::catalog_conformance as conformance;

            #[test]
            fn dependency_queries_walk_resolved_edges() {
                conformance::dependency_queries_walk_resolved_edges($make);
            }

            #[test]
            fn refresh_reports_paths_changed_on_disk() {
                conformance::refresh_reports_paths_changed_on_disk($make);
            }

            #[test]
            fn change_reports_past_their_limit_count_the_changes() {
                conformance::change_reports_past_their_limit_count_the_changes($make);
            }

            #[test]
            fn diagnostics_past_the_kept_ones_are_counted() {
                conformance::diagnostics_past_the_kept_ones_are_counted($make);
            }

            #[test]
            fn inventory_retains_package_and_sidecar_signatures() {
                conformance::inventory_retains_package_and_sidecar_signatures($make);
            }

            #[test]
            fn deleting_only_a_sidecar_drops_its_signature() {
                conformance::deleting_only_a_sidecar_drops_its_signature($make);
            }

            #[test]
            fn warm_refresh_retries_failed_headers() {
                conformance::warm_refresh_retries_failed_headers($make);
            }

            #[test]
            fn cold_refresh_then_warm_noop_reads_zero_headers() {
                conformance::cold_refresh_then_warm_noop_reads_zero_headers($make);
            }

            #[test]
            fn rebuild_clears_generation_before_cold_refresh() {
                conformance::rebuild_clears_generation_before_cold_refresh($make);
            }

            #[test]
            fn changed_deleted_renamed_and_sidecar_updates_are_detected() {
                conformance::changed_deleted_renamed_and_sidecar_updates_are_detected($make);
            }

            #[test]
            fn cancellation_discards_staging_and_keeps_prior_generation() {
                conformance::cancellation_discards_staging_and_keeps_prior_generation($make);
            }

            #[test]
            fn injected_failure_keeps_prior_generation_and_deletes_nothing() {
                conformance::injected_failure_keeps_prior_generation_and_deletes_nothing($make);
            }

            #[test]
            fn stale_generation_queries_fail_explicitly_and_ordering_is_stable() {
                conformance::stale_generation_queries_fail_explicitly_and_ordering_is_stable($make);
            }

            #[test]
            fn signature_revalidation_rejects_unstable_packages() {
                conformance::signature_revalidation_rejects_unstable_packages($make);
            }

            #[test]
            fn every_query_kind_answers_from_committed_evidence() {
                conformance::every_query_kind_answers_from_committed_evidence($make);
            }

            #[test]
            fn bounded_pages_walk_one_generation_in_stable_order() {
                conformance::bounded_pages_walk_one_generation_in_stable_order($make);
            }

            #[test]
            fn absent_catalog_and_unknown_project_are_explicit() {
                conformance::absent_catalog_and_unknown_project_are_explicit($make);
            }

            #[test]
            fn stale_index_profile_rebuilds_header_evidence_only() {
                conformance::stale_index_profile_rebuilds_header_evidence_only($make);
            }

            #[test]
            fn targeted_refreshes_match_full_walks() {
                conformance::targeted_refreshes_match_full_walks($make);
            }

            #[test]
            fn targeted_refresh_walks_when_unsure() {
                conformance::targeted_refresh_walks_when_unsure($make);
            }

            #[test]
            fn inventory_digest_depends_only_on_the_inventory() {
                conformance::inventory_digest_depends_only_on_the_inventory($make);
            }
        }
    };
}

pub(crate) use catalog_conformance_tests;
