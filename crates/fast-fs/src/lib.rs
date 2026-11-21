//! What changed below a set of directories since a recorded position in the volume's change
//! journal, read without administrator rights.
//!
//! A [`UsnCheckpoint`] records each root directory's identity (its final path, volume and file
//! id) and, for each of their volumes, the change journal's id and next position.
//! [`read_changes_since`] names the directories below the roots whose entries may have changed
//! since a checkpoint, or says why it cannot be sure; the caller then lists the roots whole.
//!
//! The unprivileged journal read (`FSCTL_READ_UNPRIVILEGED_USN_JOURNAL`) leaves file names out:
//! a record names the changed file and its parent directory by id alone. Changes are therefore
//! reported per directory, and a directory renamed, moved or deleted below a root (which carries
//! whatever lies under it) is a reason to fall back. Only Windows keeps such a journal; elsewhere
//! every read falls back.

use std::path::PathBuf;

#[cfg(windows)]
mod usn_windows;

/// One root directory as its volume identifies it. A root reached through a junction or symbolic
/// link is identified by its target, so a retargeted link no longer matches.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct RootIdentity {
    /// The final path, as the file system spells it.
    pub path: String,
    pub volume: u64,
    pub file_id: u128,
}

/// A volume's change journal and the position the next read starts from.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct JournalPosition {
    pub volume: u64,
    pub journal_id: u64,
    pub next_usn: i64,
}

/// The roots and their volumes' journal positions at one moment. Take it before listing the
/// roots: whatever changes while they are listed is then read next time.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct UsnCheckpoint {
    /// In the order of the roots it was taken for.
    pub roots: Vec<RootIdentity>,
    pub journals: Vec<JournalPosition>,
}

/// A directory whose entries may have changed: the index of its root and its path below that
/// root, `/`-separated, empty for the root itself.
#[derive(Clone, Debug, PartialEq, Eq, PartialOrd, Ord)]
pub struct ChangedDirectory {
    pub root: usize,
    pub relative: String,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum UsnDelta {
    /// Every directory below the roots whose entries may have changed, sorted and unique, and
    /// the checkpoint the next read starts from. It was taken before this read, so changes made
    /// since are read next time.
    Changed {
        directories: Vec<ChangedDirectory>,
        checkpoint: UsnCheckpoint,
    },
    /// Why the journal cannot say what changed; list the roots whole instead.
    Fallback(&'static str),
}

/// Bounds on one read, past which listing the roots is the cheaper or the only safe answer.
#[derive(Clone, Copy, Debug)]
pub struct UsnLimits {
    /// Journal records read (on every volume, about 100 bytes each).
    pub max_records: usize,
    /// Distinct directories resolved by id to their paths.
    pub max_resolutions: usize,
    /// Changed directories reported.
    pub max_directories: usize,
}

impl Default for UsnLimits {
    fn default() -> Self {
        Self {
            max_records: 1_000_000,
            max_resolutions: 16_384,
            max_directories: 4_096,
        }
    }
}

/// The roots' identities and their volumes' journal positions now, or why there are none (a
/// root that cannot be opened, a volume without a change journal, an unsupported platform).
pub fn query_checkpoint(roots: &[PathBuf]) -> Result<UsnCheckpoint, &'static str> {
    #[cfg(windows)]
    {
        usn_windows::query_checkpoint(roots)
    }
    #[cfg(not(windows))]
    {
        let _ = roots;
        Err("usn_unsupported")
    }
}

/// The directories below `roots` that changed since `since`, which must have been taken for the
/// same roots in the same order.
pub fn read_changes_since(
    roots: &[PathBuf],
    since: &UsnCheckpoint,
    limits: &UsnLimits,
) -> UsnDelta {
    #[cfg(windows)]
    {
        usn_windows::read_changes_since(roots, since, limits)
    }
    #[cfg(not(windows))]
    {
        let _ = (roots, since, limits);
        UsnDelta::Fallback("usn_unsupported")
    }
}

#[cfg(all(test, not(windows)))]
mod tests {
    use super::*;

    #[test]
    fn other_platforms_always_fall_back() {
        let roots = [std::env::temp_dir()];
        assert_eq!(query_checkpoint(&roots), Err("usn_unsupported"));
        let since = UsnCheckpoint {
            roots: Vec::new(),
            journals: Vec::new(),
        };
        assert_eq!(
            read_changes_since(&roots, &since, &UsnLimits::default()),
            UsnDelta::Fallback("usn_unsupported")
        );
    }
}
