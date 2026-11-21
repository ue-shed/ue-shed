//! The volume change journal position a committed generation was listed at, so a later refresh
//! told nothing (a host that starts cold, or one that missed a source control sync) can read
//! which content directories changed since instead of walking every content root.
//!
//! A position is taken before the roots are listed: whatever changes while they are listed is
//! read next time. The journal names changed directories, not files (an unprivileged read leaves
//! names out); the refresh lists those directories and compares them as a walk would. Whenever the
//! journal cannot say (another platform, a replaced or wrapped journal, a moved directory, a
//! changed content root), the refresh walks.

use std::path::{Path, PathBuf};

use fast_fs::{JournalPosition, RootIdentity, UsnCheckpoint, UsnDelta, UsnLimits};
use serde::{Deserialize, Serialize};

use super::catalog::MountPoint;

/// A change journal position as a committed manifest keeps it.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub(crate) struct ChangeJournal {
    roots: Vec<JournalRoot>,
    volumes: Vec<JournalVolume>,
}

/// A content root: the mount path it backs and its identity on its volume.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
struct JournalRoot {
    mount: String,
    path: String,
    volume: u64,
    /// The 128-bit file id, as hex.
    file_id: String,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
struct JournalVolume {
    volume: u64,
    journal_id: u64,
    next_usn: i64,
}

/// The content roots a walk lists, with the mount path each backs: the project's `Content`, and
/// each further mount's directory that exists.
fn content_roots<'m>(project_root: &str, mounts: &'m [MountPoint]) -> Vec<(PathBuf, &'m str)> {
    mounts
        .iter()
        .enumerate()
        .map(|(index, mount)| {
            let path = if index == 0 {
                Path::new(project_root).join("Content")
            } else {
                Path::new(project_root).join(&mount.path)
            };
            (path, mount.path.as_str())
        })
        .filter(|(path, _)| path.is_dir())
        .collect()
}

/// The journal position now for the content roots of `mounts`, if their volumes keep a journal.
pub(crate) fn capture(project_root: &str, mounts: &[MountPoint]) -> Option<ChangeJournal> {
    let roots = content_roots(project_root, mounts);
    let paths = roots
        .iter()
        .map(|(path, _)| path.clone())
        .collect::<Vec<_>>();
    let checkpoint = fast_fs::query_checkpoint(&paths).ok()?;
    Some(ChangeJournal::from_checkpoint(&roots, checkpoint))
}

/// The project-relative directories (`/`-separated, no trailing `/`) whose entries changed since
/// `since`, sorted and unique, and the position to keep for the next read; or why the journal
/// cannot say.
pub(crate) fn changed_directories(
    project_root: &str,
    mounts: &[MountPoint],
    since: &ChangeJournal,
) -> Result<(Vec<String>, ChangeJournal), &'static str> {
    let roots = content_roots(project_root, mounts);
    if roots
        .iter()
        .map(|(_, mount)| *mount)
        .ne(since.roots.iter().map(|root| root.mount.as_str()))
    {
        return Err("content_roots_changed");
    }
    let checkpoint = since.to_checkpoint().ok_or("change_journal_unreadable")?;
    let paths = roots
        .iter()
        .map(|(path, _)| path.clone())
        .collect::<Vec<_>>();
    match fast_fs::read_changes_since(&paths, &checkpoint, &UsnLimits::default()) {
        UsnDelta::Changed {
            directories,
            checkpoint,
        } => {
            let mut changed = directories
                .into_iter()
                .map(|directory| {
                    let mount = roots.get(directory.root).map_or("", |(_, mount)| *mount);
                    let mut path = format!("{mount}{}", directory.relative);
                    while path.ends_with('/') {
                        path.pop();
                    }
                    path
                })
                .collect::<Vec<_>>();
            changed.sort_unstable();
            changed.dedup();
            Ok((changed, ChangeJournal::from_checkpoint(&roots, checkpoint)))
        }
        UsnDelta::Fallback(reason) => Err(reason),
    }
}

impl ChangeJournal {
    fn from_checkpoint(roots: &[(PathBuf, &str)], checkpoint: UsnCheckpoint) -> Self {
        Self {
            roots: roots
                .iter()
                .zip(checkpoint.roots)
                .map(|((_, mount), root)| JournalRoot {
                    mount: (*mount).to_owned(),
                    path: root.path,
                    volume: root.volume,
                    file_id: format!("{:032x}", root.file_id),
                })
                .collect(),
            volumes: checkpoint
                .journals
                .into_iter()
                .map(|journal| JournalVolume {
                    volume: journal.volume,
                    journal_id: journal.journal_id,
                    next_usn: journal.next_usn,
                })
                .collect(),
        }
    }

    fn to_checkpoint(&self) -> Option<UsnCheckpoint> {
        Some(UsnCheckpoint {
            roots: self
                .roots
                .iter()
                .map(|root| {
                    Some(RootIdentity {
                        path: root.path.clone(),
                        volume: root.volume,
                        file_id: u128::from_str_radix(&root.file_id, 16).ok()?,
                    })
                })
                .collect::<Option<_>>()?,
            journals: self
                .volumes
                .iter()
                .map(|volume| JournalPosition {
                    volume: volume.volume,
                    journal_id: volume.journal_id,
                    next_usn: volume.next_usn,
                })
                .collect(),
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_stored_position_round_trips_through_the_manifest_form() {
        let journal = ChangeJournal {
            roots: vec![JournalRoot {
                mount: "Content/".to_owned(),
                path: "\\\\?\\C:\\Project\\Content".to_owned(),
                volume: 7,
                file_id: format!("{:032x}", u128::MAX - 5),
            }],
            volumes: vec![JournalVolume {
                volume: 7,
                journal_id: 9,
                next_usn: 1_234,
            }],
        };
        let text = serde_json::to_string(&journal).unwrap();
        let read: ChangeJournal = serde_json::from_str(&text).unwrap();
        assert_eq!(read, journal);
        let checkpoint = read.to_checkpoint().unwrap();
        assert_eq!(checkpoint.roots[0].file_id, u128::MAX - 5);
        let roots = [(PathBuf::from("unused"), "Content/")];
        assert_eq!(ChangeJournal::from_checkpoint(&roots, checkpoint), journal);
    }

    #[test]
    fn a_position_for_other_content_roots_is_not_read() {
        let project = std::env::temp_dir().join(format!(
            "ue-shed-change-journal-roots-{}",
            std::process::id()
        ));
        std::fs::create_dir_all(project.join("Content")).unwrap();
        std::fs::create_dir_all(project.join("Plugins/Extra/Content")).unwrap();
        let root = project.to_string_lossy().into_owned();
        let game = vec![MountPoint::game()];
        let with_plugin = vec![
            MountPoint::game(),
            MountPoint {
                name: "/Extra/".to_owned(),
                path: "Plugins/Extra/Content/".to_owned(),
            },
        ];
        let since = capture(&root, &game);
        // A local NTFS temporary directory keeps a journal; no other platform has one.
        assert_eq!(since.is_some(), cfg!(windows));
        if let Some(since) = since {
            assert_eq!(
                changed_directories(&root, &with_plugin, &since),
                Err("content_roots_changed")
            );
            let (changed, _) = changed_directories(&root, &game, &since).unwrap();
            assert!(changed.is_empty(), "{changed:?}");
            std::fs::write(project.join("Content/A.uasset"), [1]).unwrap();
            let plugin = capture(&root, &with_plugin).unwrap();
            std::fs::write(project.join("Plugins/Extra/Content/B.uasset"), [1]).unwrap();
            let (changed, _) = changed_directories(&root, &with_plugin, &plugin).unwrap();
            assert_eq!(changed, vec!["Plugins/Extra/Content".to_owned()]);
            let (changed, _) = changed_directories(&root, &game, &since).unwrap();
            assert_eq!(changed, vec!["Content".to_owned()]);
        }
        std::fs::remove_dir_all(project).unwrap();
    }
}
