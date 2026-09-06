//! Adapter-neutral Catalog conformance suite.
//!
//! Every scenario programs against the coordinator and the storage-neutral Catalog seam only. The
//! suite must stay free of storage vocabulary so each adapter can run it unchanged.

use std::cell::Cell;
use std::collections::{BTreeMap, BTreeSet};

use crate::cancellation::CancellationToken;

use super::catalog::{
    Catalog, CatalogError, CatalogStatus, Completeness, EntryKind, Generation, HeaderEvidence,
    INDEX_PROFILE_VERSION, PROJECT_INDEX_MAX_PAGE_SIZE, PackageSignature, ProjectId, QueryItem,
    QueryKind, QueryRequest, RefreshSummary, StagedPackage, item_path, project_id_from_root,
};
use super::checkpoint;
use super::project_index::{
    CatalogSnapshot, CoordinatorError, ProjectScanner, RefreshEvent, query, rebuild, refresh,
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
}

impl ProjectScanner for FakeScanner {
    fn enumerate(
        &self,
        _project_root: &str,
        cancellation: &CancellationToken,
    ) -> Result<Vec<PackageSignature>, CoordinatorError> {
        checkpoint(cancellation, "discovery")?;
        Ok(self.entries.clone())
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
        profile_version: INDEX_PROFILE_VERSION,
        package_name: package_name.to_owned(),
        classes: classes.iter().map(|value| (*value).to_owned()).collect(),
        serialized_names: names.iter().map(|value| (*value).to_owned()).collect(),
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
            RefreshEvent::Completed { summary } => Some(summary.clone()),
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
    }
}

/// Walk every bounded page of one query and return the concatenated items.
pub(crate) fn collect_pages<C: Catalog>(
    catalog: &C,
    generation: Generation,
    kind: QueryKind,
    limit: usize,
) -> Vec<QueryItem> {
    let mut items = Vec::new();
    let mut cursor = None;
    loop {
        let page = query(catalog, &request(generation, kind.clone(), limit, cursor))
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
    let scanner = refresh_fixture();

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
            package_name,
            classes,
            serialized_names,
            ..
        } => {
            assert_eq!(package_name, "/Game/Maps/L_Alpha");
            assert_eq!(classes, &vec!["/Script/Engine.World".to_owned()]);
            assert!(serialized_names.is_empty());
        }
        QueryItem::Map { .. } => panic!("class queries return header items"),
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
                    profile_version: INDEX_PROFILE_VERSION.saturating_sub(1),
                    package_name: "/Game/A".to_owned(),
                    classes: Vec::new(),
                    serialized_names: Vec::new(),
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
macro_rules! catalog_conformance_tests {
    ($module:ident, $make:expr) => {
        mod $module {
            #[allow(unused_imports)]
            use super::*;
            use crate::direct_executor::catalog_conformance as conformance;

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
        }
    };
}

pub(crate) use catalog_conformance_tests;
