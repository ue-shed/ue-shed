use super::*;
use crate::package_text_columns::{Columns, Evidence, Stored, write_staged};
use game_text_index::builder::{BuildRequest, BuildSession, InputLayer};
use game_text_index::disk_changes::{Change, ChangeCounts, DiskChangeKind};
use std::collections::BTreeMap;
use std::fs;
use std::path::PathBuf;
use std::time::{Duration, SystemTime};

const KEEP: &str = "Content/Text/Keep.uasset";
const TOUCH: &str = "Content/Text/Touch.uasset";
const GONE: &str = "Content/Maps/Gone.umap";
const NEW: &str = "Content/Text/New.uasset";

/// A project of real files beside the store that indexes it; both are removed on drop.
struct Project {
    root: PathBuf,
    configuration: Configuration,
}

impl Project {
    fn new(files: &[&str]) -> Self {
        let root = std::env::temp_dir().join(format!(
            "ue-shed-disk-check-{}",
            game_text_index::store::token()
        ));
        for file in files {
            write(&root, file, b"saved");
        }
        let configuration = Configuration {
            cache_root: root.join("cache"),
            project_key: "disk-check".into(),
            target_key: "SavedText".into(),
            shared_project: false,
            view_prefix: None,
        };
        Self {
            root,
            configuration,
        }
    }

    /// Indexes the project as a refresh would: each package with its signature from the Project
    /// Index's walk, in the shard its path selects, and the saved-text view joined over them.
    fn index(&self) {
        let listing =
            enumerate_content(&self.root.to_string_lossy(), &CancellationToken::new(), 8).unwrap();
        let mut shards = BTreeMap::<usize, Vec<DiskPackage>>::new();
        for package in packages(&listing) {
            shards
                .entry(game_text_index::package_text_plan::shard(&package.path))
                .or_default()
                .push(package);
        }
        let staging = self.root.join("staging");
        fs::create_dir_all(&staging).unwrap();
        let mut inputs = Vec::new();
        for (group, packages) in shards {
            let mut columns = Columns::new().unwrap();
            for package in packages {
                // The encoder reads scalar views, as a scan stores a package it didn't read.
                let path = view(&package.path);
                columns
                    .feed(
                        Stored {
                            evidence: Evidence::NotGatherable { path: path.clone() },
                            signature: view(&package.signature),
                            path,
                        },
                        &[],
                    )
                    .unwrap();
            }
            let file = staging.join(format!("{group}.snapshot"));
            write_staged(&file, &columns.finish().unwrap()).unwrap();
            inputs.push(InputLayer {
                name: format!("package-text.{group}"),
                key: format!("test:{group}:{}", game_text_index::store::token()),
                file,
            });
        }
        let join = staging.join("join.json");
        fs::write(
            &join,
            serde_json::to_vec(&serde_json::json!({
                "projectRoot": self.root,
                "target": {
                    "name": "SavedText", "source": "config_only", "nativeCulture": null,
                    "cultures": [], "configs": [],
                    "outputPaths": {"manifest": null, "archives": {}, "portableObjects": {},
                        "resources": {}, "locmeta": null, "wordCount": null, "conflicts": null},
                    "poFormat": "Unreal", "collapseMode": "IdenticalTextIdAndSource"
                }
            }))
            .unwrap(),
        )
        .unwrap();
        let configuration = self.configuration.clone();
        let mut session = BuildSession::default();
        for request in [
            BuildRequest::Begin {
                configuration: configuration.clone(),
            },
            BuildRequest::Publish {
                configuration: configuration.clone(),
                inputs,
                cold: true,
                removed_names: Vec::new(),
            },
            BuildRequest::Join {
                configuration: configuration.clone(),
                file: join,
            },
            BuildRequest::End { configuration },
        ] {
            session.execute(&request).unwrap();
        }
    }

    fn check(
        &self,
        checks: &mut DiskChecks,
        paths: Option<&[&str]>,
        after: Option<&str>,
        limit: u32,
    ) -> DiskChangesAnswer {
        let request = DiskChangesRequest {
            project_root: self.root.clone(),
            target: None,
            paths: paths.map(|paths| paths.iter().map(|path| (*path).to_owned()).collect()),
            after: after.map(str::to_owned),
            limit,
        };
        *check_disk(
            checks,
            &self.configuration,
            &request,
            &CancellationToken::new(),
        )
        .unwrap()
        .disk_changes
        .unwrap()
    }
}

impl Drop for Project {
    fn drop(&mut self) {
        fs::remove_dir_all(&self.root).ok();
    }
}

fn view(text: &str) -> String {
    game_text_index::wtf8::Wtf8Buf::from_utf8(text).into_view()
}

fn write(root: &Path, file: &str, bytes: &[u8]) {
    let path = root.join(file);
    fs::create_dir_all(path.parent().unwrap()).unwrap();
    fs::write(path, bytes).unwrap();
}

/// Moves a file's modification time without changing its size, as a save of the same bytes.
fn touch(root: &Path, file: &str) {
    let handle = fs::OpenOptions::new()
        .write(true)
        .open(root.join(file))
        .unwrap();
    handle
        .set_modified(SystemTime::now() + Duration::from_secs(60))
        .unwrap();
}

fn ready(answer: DiskChangesAnswer) -> (DiskChangeCounts, Vec<DiskChangeItem>, Option<String>) {
    match answer {
        DiskChangesAnswer::Ready {
            counts,
            items,
            next_cursor,
        } => (counts, items, next_cursor),
        DiskChangesAnswer::NotIndexed => panic!("Expected an indexed view."),
    }
}

fn package(change: Change, path: &str) -> DiskChangeItem {
    DiskChangeItem {
        kind: DiskChangeKind::Package,
        change,
        path: path.into(),
    }
}

#[test]
fn a_view_that_was_never_indexed_is_not_indexed() {
    let project = Project::new(&[KEEP]);
    assert_eq!(
        project.check(&mut DiskChecks::default(), None, None, 10),
        DiskChangesAnswer::NotIndexed
    );
}

#[test]
fn a_walk_finds_packages_added_removed_and_changed_by_a_touched_sidecar() {
    let project = Project::new(&[
        KEEP,
        "Content/Text/Keep.uexp",
        TOUCH,
        "Content/Text/Touch.uexp",
        GONE,
        "Content/Text/Notes.txt",
    ]);
    project.index();
    let mut checks = DiskChecks::default();
    let (counts, items, _) = ready(project.check(&mut checks, None, None, 10));
    assert_eq!(counts, DiskChangeCounts::default());
    assert!(items.is_empty());
    // Touch's sidecar is saved again, Gone is deleted, New is added; Keep is untouched.
    touch(&project.root, "Content/Text/Touch.uexp");
    fs::remove_file(project.root.join(GONE)).unwrap();
    write(&project.root, NEW, b"new");
    let (counts, items, next) = ready(project.check(&mut checks, None, None, 10));
    assert_eq!(
        counts.packages,
        ChangeCounts {
            added: 1,
            changed: 1,
            removed: 1
        }
    );
    assert_eq!(
        items,
        [
            package(Change::Removed, GONE),
            package(Change::Added, NEW),
            package(Change::Changed, TOUCH),
        ]
    );
    assert_eq!(next, None);
}

#[test]
fn named_paths_check_only_their_packages() {
    let project = Project::new(&[KEEP, TOUCH, "Content/Text/Touch.ubulk", GONE]);
    project.index();
    touch(&project.root, KEEP);
    touch(&project.root, "Content/Text/Touch.ubulk");
    fs::remove_file(project.root.join(GONE)).unwrap();
    write(&project.root, NEW, b"new");
    let mut checks = DiskChecks::default();
    // A sidecar names its package; Keep and New changed too, but aren't named.
    let (counts, items, _) = ready(project.check(
        &mut checks,
        Some(&["Content\\Text\\Touch.ubulk", GONE, "Config/DefaultGame.ini"]),
        None,
        10,
    ));
    assert_eq!(
        counts.packages,
        ChangeCounts {
            added: 0,
            changed: 1,
            removed: 1
        }
    );
    assert_eq!(
        items,
        [
            package(Change::Removed, GONE),
            package(Change::Changed, TOUCH)
        ]
    );
}

#[test]
fn later_pages_read_the_kept_check_and_a_first_page_checks_again() {
    let project = Project::new(&[KEEP]);
    project.index();
    for file in ["A", "B", "C"] {
        write(&project.root, &format!("Content/{file}.uasset"), b"new");
    }
    let mut checks = DiskChecks::default();
    let (counts, first, after) = ready(project.check(&mut checks, None, None, 2));
    assert_eq!(counts.packages.added, 3);
    assert_eq!(first.len(), 2);
    let after = after.unwrap();
    assert_eq!(after, "Content/B.uasset");
    // A file added between pages isn't seen by the kept check, only by the next first page.
    write(&project.root, "Content/D.uasset", b"new");
    let (counts, second, next) = ready(project.check(&mut checks, None, Some(&after), 2));
    assert_eq!(counts.packages.added, 3);
    assert_eq!(second, [package(Change::Added, "Content/C.uasset")]);
    assert_eq!(next, None);
    let (counts, _, _) = ready(project.check(&mut checks, None, None, 2));
    assert_eq!(counts.packages.added, 4);
}

/// The walk signs a package from its directory listing; a named path from `fs::metadata`. Both
/// must give the Catalog's signature for the same files.
#[test]
fn listing_metadata_signs_a_bundle_as_file_metadata_does() {
    let project = Project::new(&[
        KEEP,
        "Content/Text/Keep.uexp",
        "Content/Text/Keep.ubulk",
        "Content/Text/Keep.uptnl",
        GONE,
    ]);
    touch(&project.root, "Content/Text/Keep.ubulk");
    let listing = enumerate_content(
        &project.root.to_string_lossy(),
        &CancellationToken::new(),
        8,
    )
    .unwrap();
    let walked = packages(&listing);
    assert_eq!(walked.len(), 2);
    for package in walked {
        assert_eq!(
            stated(&project.root, &package.path).unwrap(),
            Some(package.signature),
            "{}",
            package.path
        );
    }
    assert_eq!(stated(&project.root, NEW).unwrap(), None);
}

#[test]
fn a_file_name_with_a_reserved_scalar_is_checked_by_its_own_name() {
    const ODD: &str = "Content/Text/\u{f0000}Odd.uasset";
    let project = Project::new(&[KEEP, ODD]);
    project.index();
    let mut checks = DiskChecks::default();
    for paths in [None, Some(&[ODD][..])] {
        let (_, items, _) = ready(project.check(&mut checks, paths, None, 10));
        assert_eq!(items, [], "{paths:?}");
    }
    touch(&project.root, ODD);
    for paths in [None, Some(&[ODD][..])] {
        let (_, items, _) = ready(project.check(&mut checks, paths, None, 10));
        assert_eq!(items, [package(Change::Changed, &view(ODD))], "{paths:?}");
        let wire = serde_json::to_value(&items[0]).unwrap();
        assert_eq!(wire["path"], ODD);
    }
}
