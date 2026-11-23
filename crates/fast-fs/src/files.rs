//! Reading many content files cheaply: opens that leave each file's last-access time alone,
//! a file's size and modification time read from its open handle, and directory listings that
//! carry each entry's size and modification time.
//!
//! On Windows, closing a handle that read a file whose last-access time is older than the
//! volume's update interval makes NTFS write that time back to the file's record. Across a cold
//! walk of a large project those writes dominate the read. [`open_read_no_atime`] asks for
//! `FILE_WRITE_ATTRIBUTES` as well, which a read-only file still grants, and tells the file system
//! to keep the last-access time as it is; it falls back to a plain read open where that right is
//! refused. Elsewhere every function here is the standard library's own call.

use std::ffi::OsStr;
use std::fs::File;
use std::io::{self, Read as _};
use std::path::{Path, PathBuf};

#[cfg(windows)]
use crate::files_windows as platform;

/// What a directory entry is, as [`std::fs::DirEntry::file_type`] says: links are not followed,
/// so symbolic links and junctions are neither directories nor files.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum DirEntryKind {
    Directory,
    File,
    Other,
}

/// One entry of a directory listed by [`visit_dir_entries`].
pub struct DirEntryInfo<'a> {
    directory: &'a Path,
    name: &'a OsStr,
    #[cfg(windows)]
    listed: Listed,
    #[cfg(not(windows))]
    entry: &'a std::fs::DirEntry,
}

/// What a Windows listing says about an entry; nothing about it is read again.
#[cfg(windows)]
#[derive(Clone, Copy)]
pub(crate) struct Listed {
    pub(crate) kind: DirEntryKind,
    pub(crate) size: u64,
    pub(crate) modified_nanos: u64,
}

impl<'a> DirEntryInfo<'a> {
    #[cfg(windows)]
    pub(crate) fn listed(directory: &'a Path, name: &'a OsStr, listed: Listed) -> Self {
        Self {
            directory,
            name,
            listed,
        }
    }

    /// The entry's name, as [`std::fs::DirEntry::file_name`] gives it.
    pub fn file_name(&self) -> &OsStr {
        self.name
    }

    /// The listed directory joined with the entry's name, as [`std::fs::DirEntry::path`].
    pub fn path(&self) -> PathBuf {
        self.directory.join(self.name)
    }

    /// The entry's kind, without following links. Windows listings carry it; elsewhere it may
    /// need a `stat`, as [`std::fs::DirEntry::file_type`] does.
    pub fn kind(&self) -> io::Result<DirEntryKind> {
        #[cfg(windows)]
        {
            Ok(self.listed.kind)
        }
        #[cfg(not(windows))]
        {
            let kind = self.entry.file_type()?;
            Ok(if kind.is_dir() {
                DirEntryKind::Directory
            } else if kind.is_file() {
                DirEntryKind::File
            } else {
                DirEntryKind::Other
            })
        }
    }

    /// The entry's size in bytes and modification time in nanoseconds since the Unix epoch (`0`
    /// before it), as [`std::fs::DirEntry::metadata`] reports them. Windows listings carry both;
    /// elsewhere this reads the entry's metadata without following links.
    pub fn signature(&self) -> io::Result<(u64, u64)> {
        #[cfg(windows)]
        {
            Ok((self.listed.size, self.listed.modified_nanos))
        }
        #[cfg(not(windows))]
        {
            let metadata = self.entry.metadata()?;
            Ok((metadata.len(), metadata_modified_nanos(&metadata)))
        }
    }
}

/// Opens a file for reading, as [`File::open`] does, without updating its last-access time
/// where the platform allows that. The file's modification time and contents are untouched and,
/// on Windows, no change-journal record is written for it.
pub fn open_read_no_atime(path: &Path) -> io::Result<File> {
    #[cfg(windows)]
    {
        platform::open_read_no_atime(path)
    }
    #[cfg(not(windows))]
    {
        File::open(path)
    }
}

/// A file's contents, as [`std::fs::read`] gives them, opened with [`open_read_no_atime`].
pub fn read_no_atime(path: &Path) -> io::Result<Vec<u8>> {
    let mut file = open_read_no_atime(path)?;
    let size = file_len(&file)
        .ok()
        .and_then(|len| usize::try_from(len).ok());
    let mut bytes = Vec::new();
    bytes
        .try_reserve_exact(size.unwrap_or(0))
        .map_err(|_| io::Error::from(io::ErrorKind::OutOfMemory))?;
    file.read_to_end(&mut bytes)?;
    Ok(bytes)
}

/// An open file's size in bytes and modification time in nanoseconds since the Unix epoch (`0`
/// before it), or `None` when it is not a regular file: what [`File::metadata`] reports when
/// [`std::fs::Metadata::is_file`] holds.
pub fn file_signature(file: &File) -> io::Result<Option<(u64, u64)>> {
    #[cfg(windows)]
    {
        platform::file_signature(file)
    }
    #[cfg(not(windows))]
    {
        let metadata = file.metadata()?;
        Ok(metadata
            .is_file()
            .then(|| (metadata.len(), metadata_modified_nanos(&metadata))))
    }
}

/// Calls `visit` with each entry of `directory`, in the order the file system lists them, as
/// [`std::fs::read_dir`] would, skipping `.` and `..`. Stops early, successfully, when `visit`
/// returns `Ok(false)`, and at the first error either the listing or `visit` returns.
///
/// On Windows the listing is read in 64 KiB batches with `NtQueryDirectoryFile`, and each entry
/// carries its kind, size and modification time. Elsewhere this is [`std::fs::read_dir`].
pub fn visit_dir_entries(
    directory: &Path,
    mut visit: impl FnMut(DirEntryInfo<'_>) -> io::Result<bool>,
) -> io::Result<()> {
    #[cfg(windows)]
    {
        platform::visit_dir_entries(directory, &mut visit)
    }
    #[cfg(not(windows))]
    {
        for entry in std::fs::read_dir(directory)? {
            let entry = entry?;
            let name = entry.file_name();
            let info = DirEntryInfo {
                directory,
                name: &name,
                entry: &entry,
            };
            if !visit(info)? {
                break;
            }
        }
        Ok(())
    }
}

fn file_len(file: &File) -> io::Result<u64> {
    #[cfg(windows)]
    {
        platform::file_len(file)
    }
    #[cfg(not(windows))]
    {
        file.metadata().map(|metadata| metadata.len())
    }
}

#[cfg(not(windows))]
fn metadata_modified_nanos(metadata: &std::fs::Metadata) -> u64 {
    metadata
        .modified()
        .ok()
        .and_then(|modified| modified.duration_since(std::time::UNIX_EPOCH).ok())
        .map_or(0, |duration| {
            u64::try_from(duration.as_nanos()).unwrap_or(u64::MAX)
        })
}

#[cfg(test)]
mod tests;
