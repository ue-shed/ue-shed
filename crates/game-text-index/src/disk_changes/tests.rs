use super::*;
use crate::join_fact_tests::Fixture;
use serde_json::json;
use std::fs;

const KEEP: &str = "Content/Text/Keep.uasset";
const TOUCH: &str = "Content/Text/Touch.uasset";
const GONE: &str = "Content/Text/Gone.uasset";
const NEW: &str = "Content/Text/New.umap";

fn never() -> bool {
    false
}

fn request(target: Option<&str>, paths: Option<&[&str]>, root: &Path) -> DiskChangesRequest {
    DiskChangesRequest {
        project_root: root.to_path_buf(),
        target: target.map(str::to_owned),
        paths: paths.map(|paths| paths.iter().map(|path| (*path).to_owned()).collect()),
        after: None,
        limit: 1000,
    }
}

fn disk(path: &str, signature: &str) -> DiskPackage {
    DiskPackage {
        path: path.into(),
        signature: signature.into(),
    }
}

/// Publishes each package in the shard its path selects, as a refresh does.
fn index(fixture: &mut Fixture, packages: &[(&str, &str)]) -> Result<()> {
    let mut shards = BTreeMap::<usize, Vec<(&str, &str, Vec<Value>)>>::new();
    for (path, signature) in packages {
        shards
            .entry(shard(path))
            .or_default()
            .push((path, signature, Vec::new()));
    }
    for (group, packages) in shards {
        fixture.shard(&format!("package-text.{group}"), &packages)?;
    }
    for (name, format) in [
        ("Game.manifest", "manifest"),
        ("en.archive", "archive"),
        ("de.archive", "archive"),
        ("en.po", "po"),
        ("de.po", "po"),
    ] {
        fixture.file(name, format, &[])?;
    }
    Ok(())
}

fn item(kind: DiskChangeKind, change: Change, path: &str) -> DiskChangeItem {
    DiskChangeItem {
        kind,
        change,
        path: path.into(),
    }
}

fn counts(added: u32, changed: u32, removed: u32) -> ChangeCounts {
    ChangeCounts {
        added,
        changed,
        removed,
    }
}

#[test]
fn a_view_without_a_store_or_a_join_is_not_indexed() -> Result<()> {
    let mut fixture = Fixture::new()?;
    let missing = Configuration {
        cache_root: crate::test_directory("disk-changes-missing"),
        ..fixture.configuration.clone()
    };
    let root = Path::new("/project");
    let walk = Observed::Walk(&[]);
    assert_eq!(
        compare(&missing, &request(None, None, root), walk, &never)?,
        None
    );
    index(&mut fixture, &[(KEEP, "a")])?;
    let walk = Observed::Walk(&[]);
    assert_eq!(
        compare(
            &fixture.configuration,
            &request(None, None, root),
            walk,
            &never
        )?,
        None
    );
    fixture.join()?;
    let walk = Observed::Walk(&[]);
    assert!(
        compare(
            &fixture.configuration,
            &request(None, None, root),
            walk,
            &never
        )?
        .is_some()
    );
    Ok(())
}

#[test]
fn a_walk_lists_packages_added_changed_and_removed_in_path_order() -> Result<()> {
    let mut fixture = Fixture::new()?;
    index(
        &mut fixture,
        &[(KEEP, "keep"), (TOUCH, "touch"), (GONE, "gone")],
    )?;
    fixture.join()?;
    let walked = [disk(KEEP, "keep"), disk(NEW, "new"), disk(TOUCH, "touched")];
    let (counted, items) = compare(
        &fixture.configuration,
        &request(None, None, Path::new("/project")),
        Observed::Walk(&walked),
        &never,
    )?
    .ok_or("Expected an index.")?;
    assert_eq!(counted.packages, counts(1, 1, 1));
    assert_eq!(counted.localization, counts(0, 0, 0));
    assert_eq!(
        items,
        [
            item(DiskChangeKind::Package, Change::Removed, GONE),
            item(DiskChangeKind::Package, Change::Added, NEW),
            item(DiskChangeKind::Package, Change::Changed, TOUCH),
        ]
    );
    // Nothing differs when the disk is as indexed.
    let same = [disk(GONE, "gone"), disk(KEEP, "keep"), disk(TOUCH, "touch")];
    let (_, items) = compare(
        &fixture.configuration,
        &request(None, None, Path::new("/project")),
        Observed::Walk(&same),
        &never,
    )?
    .ok_or("Expected an index.")?;
    assert!(items.is_empty());
    Ok(())
}

#[test]
fn named_paths_check_only_their_packages_and_a_sidecar_checks_its_package() -> Result<()> {
    let (packages, files) = named_packages(&[
        "Content\\Text\\Touch.uexp".into(),
        GONE.into(),
        "Config/DefaultGame.ini".into(),
        "Plugins/Other/Content/Asset.uasset".into(),
    ]);
    assert_eq!(
        packages.into_iter().collect::<Vec<_>>(),
        [GONE, TOUCH, "Content/Text/Touch.umap"]
    );
    assert_eq!(
        files.into_iter().collect::<Vec<_>>(),
        [
            "Config/DefaultGame.ini",
            "Plugins/Other/Content/Asset.uasset"
        ]
    );
    let mut fixture = Fixture::new()?;
    index(
        &mut fixture,
        &[(KEEP, "keep"), (TOUCH, "touch"), (GONE, "gone")],
    )?;
    fixture.join()?;
    // Touch's sidecar changed its signature, Gone was deleted, and Keep (changed) isn't named.
    let named = [
        (TOUCH.to_owned(), Some("touched".to_owned())),
        ("Content/Text/Touch.umap".to_owned(), None),
        (GONE.to_owned(), None),
    ];
    let (counted, items) = compare(
        &fixture.configuration,
        &request(None, Some(&[TOUCH, GONE]), Path::new("/project")),
        Observed::Paths {
            packages: &named,
            files: &BTreeSet::new(),
        },
        &never,
    )?
    .ok_or("Expected an index.")?;
    assert_eq!(counted.packages, counts(0, 1, 1));
    assert_eq!(
        items,
        [
            item(DiskChangeKind::Package, Change::Removed, GONE),
            item(DiskChangeKind::Package, Change::Changed, TOUCH),
        ]
    );
    Ok(())
}

/// A file's provenance as an import records it.
fn provenance(path: &Path, relative: &str) -> Result<Value> {
    let metadata = fs::metadata(path.join(relative))?;
    Ok(json!({"relativePath":relative,"size":metadata.len(),
        "modifiedTime":crate::localization::import::timestamp(&metadata),"contentHash":"hash"}))
}

#[test]
fn a_target_lists_its_inputs_and_review_file_changed_added_and_removed() -> Result<()> {
    let project = crate::test_directory("disk-changes-project");
    fs::create_dir_all(&project)?;
    for name in [
        "Game.manifest",
        "en.archive",
        "de.archive",
        "en.po",
        "review.json",
    ] {
        fs::write(project.join(name), name)?;
    }
    let mut fixture = Fixture::new()?;
    index(&mut fixture, &[(KEEP, "keep")])?;
    let mut provenances = serde_json::Map::new();
    for name in ["Game.manifest", "en.archive", "de.archive", "en.po"] {
        provenances.insert(name.into(), provenance(&project, name)?);
    }
    let review = provenance(&project, "review.json")?;
    fixture.join_with(json!({
        "fileProvenances": provenances,
        // German's PO was missing at the scan.
        "fileErrors": {"de.po":"file_missing"},
        "reviewFile": {"relativePath":"review.json","size":review["size"],
            "modifiedTime":review["modifiedTime"]}
    }))?;
    let check = |paths: Option<&[&str]>| -> Result<(DiskChangeCounts, Vec<DiskChangeItem>)> {
        let walked = [disk(KEEP, "keep")];
        let (packages, files) = named_packages(
            &paths
                .unwrap_or_default()
                .iter()
                .map(|path| (*path).to_owned())
                .collect::<Vec<_>>(),
        );
        let named = packages
            .into_iter()
            .map(|path| (path, None))
            .collect::<Vec<_>>();
        let observed = match paths {
            None => Observed::Walk(&walked),
            Some(_) => Observed::Paths {
                packages: &named,
                files: &files,
            },
        };
        compare(
            &fixture.configuration,
            &request(Some("Game"), paths, &project),
            observed,
            &never,
        )?
        .ok_or_else(|| "Expected an index.".into())
    };
    assert_eq!(check(None)?.1, []);
    // English's archive grows, German's PO appears, the manifest goes and the review is edited.
    fs::write(project.join("en.archive"), "en.archive, revised")?;
    fs::write(project.join("de.po"), "de.po")?;
    fs::remove_file(project.join("Game.manifest"))?;
    fs::write(project.join("review.json"), "review.json, revised")?;
    let (counted, items) = check(None)?;
    assert_eq!(counted.packages, counts(0, 0, 0));
    assert_eq!(counted.localization, counts(1, 2, 1));
    let localization = DiskChangeKind::Localization;
    assert_eq!(
        items,
        [
            item(localization, Change::Removed, "Game.manifest"),
            item(localization, Change::Added, "de.po"),
            item(localization, Change::Changed, "en.archive"),
            item(localization, Change::Changed, "review.json"),
        ]
    );
    // Named paths check only the inputs named.
    let (counted, items) = check(Some(&["en.archive", "en.po"]))?;
    assert_eq!(counted.localization, counts(0, 1, 0));
    assert_eq!(items, [item(localization, Change::Changed, "en.archive")]);
    // Another target's name is an error, not an empty answer.
    let error = compare(
        &fixture.configuration,
        &request(Some("Other"), None, &project),
        Observed::Walk(&[]),
        &never,
    )
    .expect_err("Another target's check fails.");
    assert_eq!(error.code, ErrorCode::InvalidInput);
    fs::remove_dir_all(project)?;
    Ok(())
}

#[test]
fn pages_follow_the_last_path_and_count_every_item() {
    let items = ["a", "b", "c"]
        .map(|path| item(DiskChangeKind::Package, Change::Added, path))
        .to_vec();
    let total = DiskChangeCounts {
        packages: counts(3, 0, 0),
        localization: ChangeCounts::default(),
    };
    let mut seen = Vec::new();
    let mut after: Option<String> = None;
    loop {
        let DiskChangesAnswer::Ready {
            counts: counted,
            items: listed,
            next_cursor,
        } = page(total, &items, after.as_deref(), 2)
        else {
            panic!("Expected a page.");
        };
        assert_eq!(counted, total);
        seen.extend(listed);
        match next_cursor {
            Some(cursor) => after = Some(cursor),
            None => break,
        }
    }
    assert_eq!(seen, items);
}

#[test]
fn requests_are_bounded_and_paths_project_relative() {
    let root = Path::new("/project");
    assert!(request(None, None, root).validate().is_ok());
    for path in [
        "",
        "/Content/A.uasset",
        "C:/Content/A.uasset",
        "Content/../A.uasset",
    ] {
        assert!(
            request(None, Some(&[path]), root).validate().is_err(),
            "{path}"
        );
    }
    let many = vec!["Content/A.uasset"; MAX_DISK_CHANGE_PATHS + 1];
    assert!(request(None, Some(&many), root).validate().is_err());
    let mut paged = request(None, None, root);
    paged.limit = 0;
    assert!(paged.validate().is_err());
}

/// A walk of the given packages, against the configuration's view.
fn walked(configuration: &Configuration, packages: &[DiskPackage]) -> Result<Vec<DiskChangeItem>> {
    Ok(compare(
        configuration,
        &request(None, None, Path::new("/project")),
        Observed::Walk(packages),
        &never,
    )?
    .ok_or("Expected an index.")?
    .1)
}

/// A check of the named packages, each as it is on disk.
fn named(
    configuration: &Configuration,
    packages: &[(&str, Option<&str>)],
) -> Result<Vec<DiskChangeItem>> {
    let paths = packages.iter().map(|(path, _)| *path).collect::<Vec<_>>();
    let packages = packages
        .iter()
        .map(|(path, signature)| ((*path).to_owned(), signature.map(str::to_owned)))
        .collect::<Vec<_>>();
    Ok(compare(
        configuration,
        &request(None, Some(&paths), Path::new("/project")),
        Observed::Paths {
            packages: &packages,
            files: &BTreeSet::new(),
        },
        &never,
    )?
    .ok_or("Expected an index.")?
    .1)
}

#[test]
fn a_view_differs_from_the_disk_until_it_is_joined_again_after_a_project_refresh() -> Result<()> {
    let mut fixture = Fixture::new()?;
    index(&mut fixture, &[(KEEP, "keep"), (TOUCH, "touch")])?;
    fixture.join()?;
    let disk_now = [disk(KEEP, "keep"), disk(TOUCH, "touched")];
    let touched = [item(DiskChangeKind::Package, Change::Changed, TOUCH)];
    assert_eq!(walked(&fixture.configuration, &disk_now)?, touched);
    // A project-only refresh publishes Touch's new shard; the target isn't joined again yet.
    index(&mut fixture, &[(KEEP, "keep"), (TOUCH, "touched")])?;
    assert_eq!(walked(&fixture.configuration, &disk_now)?, touched);
    assert_eq!(
        named(&fixture.configuration, &[(TOUCH, Some("touched"))])?,
        touched
    );
    // Joined again, the view shows what is on disk.
    fixture.join()?;
    assert_eq!(walked(&fixture.configuration, &disk_now)?, []);
    assert_eq!(
        named(&fixture.configuration, &[(TOUCH, Some("touched"))])?,
        []
    );
    Ok(())
}

#[test]
fn a_view_differs_from_the_disk_while_only_another_targets_view_is_joined_again() -> Result<()> {
    let mut fixture = Fixture::new()?;
    fixture.view('a');
    index(&mut fixture, &[(KEEP, "keep"), (TOUCH, "touch")])?;
    fixture.join()?;
    let game = fixture.configuration.clone();
    // Another target's scan publishes the project's shards and joins its own view.
    index(
        &mut fixture,
        &[(KEEP, "keep"), (TOUCH, "touched"), (NEW, "new")],
    )?;
    fixture.view('b');
    fixture.target["name"] = json!("Other");
    fixture.join()?;
    let disk_now = [disk(KEEP, "keep"), disk(NEW, "new"), disk(TOUCH, "touched")];
    assert_eq!(walked(&fixture.configuration, &disk_now)?, []);
    assert_eq!(
        walked(&game, &disk_now)?,
        [
            item(DiskChangeKind::Package, Change::Added, NEW),
            item(DiskChangeKind::Package, Change::Changed, TOUCH),
        ]
    );
    Ok(())
}

/// A package whose file name has a literal reserved scalar, which the dictionary's views escape.
const RESERVED: &str = "Content/Text/\u{f0000}Odd\u{f0800}.uasset";

#[test]
fn a_file_name_with_a_reserved_scalar_matches_its_indexed_package() -> Result<()> {
    let mut fixture = Fixture::new()?;
    // Indexed as a scan stores it: the shard its raw path selects, its raw bytes interned.
    index(&mut fixture, &[(KEEP, "keep"), (RESERVED, "odd")])?;
    fixture.join()?;
    let configuration = &fixture.configuration;
    assert_eq!(
        walked(configuration, &[disk(KEEP, "keep"), disk(RESERVED, "odd")])?,
        []
    );
    assert_eq!(named(configuration, &[(RESERVED, Some("odd"))])?, []);
    // A changed one is listed once, as changed, in the dictionary's view.
    let view = Wtf8Buf::from_utf8(RESERVED).into_view();
    assert_ne!(view, RESERVED);
    let changed = [item(DiskChangeKind::Package, Change::Changed, &view)];
    assert_eq!(
        walked(
            configuration,
            &[disk(KEEP, "keep"), disk(RESERVED, "saved")]
        )?,
        changed
    );
    assert_eq!(named(configuration, &[(RESERVED, Some("saved"))])?, changed);
    // On the wire, the path is the file's own name, as `changedSince` sends a package's ID.
    let answer = page(DiskChangeCounts::default(), &changed, None, 10);
    let wire = serde_json::to_value(&answer)?;
    assert_eq!(wire["items"][0]["path"], RESERVED);
    let read: DiskChangesAnswer = serde_json::from_value(wire.clone())?;
    assert_eq!(read, answer);
    // Once the package is indexed as changed, `changedSince` names it the same way.
    let first = fixture.join()?.key;
    index(&mut fixture, &[(KEEP, "keep"), (RESERVED, "saved")])?;
    let second = fixture.join()?.key;
    let query = crate::engine_query::EngineQuery::open(&fixture.configuration, Some(&second))?;
    let since = crate::engine_changes::ChangedSinceRequest {
        since: first,
        kind: crate::engine_changes::ChangeKind::Packages,
        after: None,
        limit: 10,
    };
    let changes = query.changed_since(&since, &std::sync::atomic::AtomicBool::new(false))?;
    let changes: Value =
        serde_json::from_str(&crate::wtf8::view_json(&serde_json::to_value(changes)?)?)?;
    assert_eq!(changes["items"][0]["id"], wire["items"][0]["path"]);
    Ok(())
}
