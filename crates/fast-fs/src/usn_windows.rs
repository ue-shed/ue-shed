//! The NTFS (and ReFS) change journal, read with `FSCTL_READ_UNPRIVILEGED_USN_JOURNAL`.
//!
//! Records come without names, so each changed file is placed by its parent directory's id:
//! `OpenFileById` and `GetFinalPathNameByHandleW` give that directory's path now, and the
//! directory is reported when the path lies below a root. A directory renamed, moved or deleted
//! is placed by the parent its record names; below a root it is a reason to fall back, since what
//! it carried moved with it. A parent that can no longer be opened was deleted: the journal's
//! record of that deletion says where it was. When none does, the read falls back rather than
//! risk missing a deletion.
//!
//! A directory this user may not open lies outside the roots as far as a listing goes. Opening
//! by id asks only for `READ_ATTRIBUTES` and `SYNCHRONIZE`, which listing the directory (or, for
//! the attributes, its parent) needs too, so a listing of the roots could not enter it either: it
//! would fail there rather than find entries.

use std::collections::{BTreeSet, HashMap, HashSet};
use std::fs::{File, OpenOptions};
use std::os::windows::fs::OpenOptionsExt;
use std::os::windows::io::{AsRawHandle, FromRawHandle, OwnedHandle, RawHandle};
use std::path::{Path, PathBuf};

use windows_sys::Win32::Foundation::{
    ERROR_ACCESS_DENIED, ERROR_JOURNAL_ENTRY_DELETED, GetLastError, HANDLE, INVALID_HANDLE_VALUE,
};
use windows_sys::Win32::Storage::FileSystem::{
    ExtendedFileIdType, FILE_ATTRIBUTE_DIRECTORY, FILE_FLAG_BACKUP_SEMANTICS, FILE_ID_128,
    FILE_ID_DESCRIPTOR, FILE_ID_DESCRIPTOR_0, FILE_ID_INFO, FILE_NAME_NORMALIZED,
    FILE_READ_ATTRIBUTES, FILE_SHARE_DELETE, FILE_SHARE_READ, FILE_SHARE_WRITE, FileIdInfo,
    GetFileInformationByHandleEx, GetFinalPathNameByHandleW, OpenFileById, SYNCHRONIZE,
    VOLUME_NAME_DOS,
};
use windows_sys::Win32::System::IO::DeviceIoControl;
use windows_sys::Win32::System::Ioctl::{
    FSCTL_QUERY_USN_JOURNAL, FSCTL_READ_UNPRIVILEGED_USN_JOURNAL, READ_USN_JOURNAL_DATA_V1,
    USN_JOURNAL_DATA_V0,
};

use crate::{ChangedDirectory, JournalPosition, RootIdentity, UsnCheckpoint, UsnDelta, UsnLimits};

// `USN_REASON_*` from winioctl.h.
const REASON_FILE_DELETE: u32 = 0x0000_0200;
const REASON_SECURITY_CHANGE: u32 = 0x0000_0800;
const REASON_RENAME_OLD_NAME: u32 = 0x0000_1000;
const REASON_RENAME_NEW_NAME: u32 = 0x0000_2000;
const REASON_INDEXABLE_CHANGE: u32 = 0x0000_4000;
const REASON_HARD_LINK_CHANGE: u32 = 0x0001_0000;
const REASON_OBJECT_ID_CHANGE: u32 = 0x0008_0000;
const REASON_REPARSE_POINT_CHANGE: u32 = 0x0010_0000;
const REASON_CLOSE: u32 = 0x8000_0000;
/// Changes that leave a name, size and modification time as they were. A close record repeats
/// the reasons its handle already recorded.
const IGNORED_REASONS: u32 =
    REASON_SECURITY_CHANGE | REASON_INDEXABLE_CHANGE | REASON_OBJECT_ID_CHANGE | REASON_CLOSE;
/// What a directory's record says when the entries below it may now be elsewhere.
const DIRECTORY_MOVED: u32 = REASON_FILE_DELETE
    | REASON_RENAME_OLD_NAME
    | REASON_RENAME_NEW_NAME
    | REASON_HARD_LINK_CHANGE
    | REASON_REPARSE_POINT_CHANGE;
/// Where a directory that has gone is placed: the parent it left.
const DIRECTORY_DEPARTED: u32 = REASON_FILE_DELETE | REASON_RENAME_OLD_NAME;

const READ_BUFFER_BYTES: usize = 64 * 1024;
/// Directories resolved on one thread before the resolution is spread over several.
const RESOLUTIONS_PER_THREAD: usize = 64;
const MAX_RESOLUTION_THREADS: usize = 16;
/// Parents followed through deleted directories before a place is called unknown.
const MAX_DEPARTED_DEPTH: usize = 64;

struct OpenRoot {
    file: File,
    identity: RootIdentity,
    wide_path: Vec<u16>,
}

pub(crate) fn query_checkpoint(roots: &[PathBuf]) -> Result<UsnCheckpoint, &'static str> {
    let opened = open_roots(roots)?;
    let mut journals: Vec<JournalPosition> = Vec::new();
    for root in &opened {
        if journals
            .iter()
            .any(|journal| journal.volume == root.identity.volume)
        {
            continue;
        }
        let journal = query_journal(&root.file)?;
        journals.push(JournalPosition {
            volume: root.identity.volume,
            journal_id: journal.UsnJournalID,
            next_usn: journal.NextUsn,
        });
    }
    Ok(UsnCheckpoint {
        roots: opened.into_iter().map(|root| root.identity).collect(),
        journals,
    })
}

pub(crate) fn read_changes_since(
    roots: &[PathBuf],
    since: &UsnCheckpoint,
    limits: &UsnLimits,
) -> UsnDelta {
    match read(roots, since, limits) {
        Ok(delta) => delta,
        Err(reason) => UsnDelta::Fallback(reason),
    }
}

fn read(
    roots: &[PathBuf],
    since: &UsnCheckpoint,
    limits: &UsnLimits,
) -> Result<UsnDelta, &'static str> {
    let opened = open_roots(roots)?;
    if opened
        .iter()
        .map(|root| &root.identity)
        .ne(since.roots.iter())
    {
        return Err("content_root_changed");
    }
    if opened.iter().any(|root| {
        !since
            .journals
            .iter()
            .any(|journal| journal.volume == root.identity.volume)
    }) {
        return Err("content_root_changed");
    }
    // Every volume's position is taken before any is read: whatever happens from here on lies
    // past the new checkpoint and is read next time.
    let mut volumes = Vec::with_capacity(since.journals.len());
    for position in &since.journals {
        let Some(root) = opened
            .iter()
            .find(|root| root.identity.volume == position.volume)
        else {
            return Err("content_root_changed");
        };
        let journal = query_journal(&root.file)?;
        if journal.UsnJournalID != position.journal_id || position.next_usn > journal.NextUsn {
            return Err("usn_journal_replaced");
        }
        if position.next_usn < journal.FirstUsn.max(journal.LowestValidUsn) {
            return Err("usn_journal_wrapped");
        }
        volumes.push((root, position, journal.NextUsn));
    }
    let checkpoint = UsnCheckpoint {
        roots: since.roots.clone(),
        journals: volumes
            .iter()
            .map(|(_, position, next_usn)| JournalPosition {
                volume: position.volume,
                journal_id: position.journal_id,
                next_usn: *next_usn,
            })
            .collect(),
    };
    let mut budget = Budget {
        records: limits.max_records,
        resolutions: limits.max_resolutions,
    };
    let mut directories = BTreeSet::new();
    for (hint, position, next_usn) in volumes {
        let mut volume = VolumeChanges::default();
        read_journal(
            &hint.file,
            position.journal_id,
            position.next_usn,
            next_usn,
            &mut budget,
            &mut |record| volume.add(record),
        )?;
        place_volume(
            hint,
            &opened,
            position.journal_id,
            next_usn,
            volume,
            &mut budget,
            &mut directories,
        )?;
        if directories.len() > limits.max_directories {
            return Err("usn_too_many_directories");
        }
    }
    Ok(UsnDelta::Changed {
        directories: directories.into_iter().collect(),
        checkpoint,
    })
}

struct Budget {
    records: usize,
    resolutions: usize,
}

/// One journal record, without the name it never carries in an unprivileged read.
#[derive(Clone, Copy)]
struct Record {
    file: u128,
    parent: u128,
    usn: i64,
    reason: u32,
    attributes: u32,
}

/// What one volume's records say, reduced to the directories to place.
#[derive(Default)]
struct VolumeChanges {
    /// Directories holding a file that changed.
    file_parents: HashSet<u128>,
    /// Directories renamed, moved or deleted, with the parent their record names.
    moved_directories: Vec<(u128, u128)>,
    /// Directories that left a parent (deleted or renamed away): where they were.
    departed: HashMap<u128, u128>,
}

impl VolumeChanges {
    fn add(&mut self, record: Record) {
        let reason = record.reason & !IGNORED_REASONS;
        if reason == 0 {
            return;
        }
        if record.attributes & FILE_ATTRIBUTE_DIRECTORY == 0 {
            self.file_parents.insert(record.parent);
            return;
        }
        // A directory's own creation and timestamps change no entry; its entries' records do.
        if reason & DIRECTORY_MOVED != 0 {
            self.moved_directories.push((record.file, record.parent));
        }
        self.learn_departure(record);
    }

    fn learn_departure(&mut self, record: Record) {
        if record.attributes & FILE_ATTRIBUTE_DIRECTORY != 0
            && record.reason & DIRECTORY_DEPARTED != 0
        {
            self.departed.insert(record.file, record.parent);
        }
    }
}

/// Where a directory lies: below which roots (with its path below each), outside them all, or
/// unknown (gone, with no record of where it was).
enum Place {
    Inside(Vec<(usize, String)>),
    Outside,
    Unknown,
}

fn place_volume(
    hint: &OpenRoot,
    roots: &[OpenRoot],
    journal_id: u64,
    read_until: i64,
    mut changes: VolumeChanges,
    budget: &mut Budget,
    directories: &mut BTreeSet<ChangedDirectory>,
) -> Result<(), &'static str> {
    let volume = hint.identity.volume;
    let on_volume = roots
        .iter()
        .enumerate()
        .filter(|(_, root)| root.identity.volume == volume)
        .collect::<Vec<_>>();
    for (directory, _) in &changes.moved_directories {
        if on_volume
            .iter()
            .any(|(_, root)| root.identity.file_id == *directory)
        {
            return Err("content_root_changed");
        }
    }
    let mut wanted = changes.file_parents.iter().copied().collect::<Vec<_>>();
    wanted.extend(changes.moved_directories.iter().map(|(_, parent)| *parent));
    wanted.sort_unstable();
    wanted.dedup();
    let mut resolver = Resolver {
        hint: &hint.file,
        paths: HashMap::with_capacity(wanted.len()),
    };
    resolver.prefetch(&wanted, budget)?;
    // A directory deleted after the records read was still there when they were written; its
    // deletion, read past the new checkpoint only to learn where it was, places it.
    let mut learned_later = false;
    loop {
        let mut unknown = false;
        for (_, parent) in &changes.moved_directories {
            match place(
                &mut resolver,
                &changes.departed,
                &on_volume,
                *parent,
                budget,
            )? {
                Place::Inside(_) => return Err("directory_moved_or_deleted"),
                Place::Outside => {}
                Place::Unknown => unknown = true,
            }
        }
        let mut found = Vec::new();
        for parent in &changes.file_parents {
            match place(
                &mut resolver,
                &changes.departed,
                &on_volume,
                *parent,
                budget,
            )? {
                Place::Inside(inside) => found.extend(inside),
                Place::Outside => {}
                Place::Unknown => unknown = true,
            }
        }
        if !unknown {
            directories.extend(
                found
                    .into_iter()
                    .map(|(root, relative)| ChangedDirectory { root, relative }),
            );
            return Ok(());
        }
        if learned_later {
            return Err("usn_parent_unresolvable");
        }
        learned_later = true;
        let now = query_journal(&hint.file)?;
        if now.UsnJournalID != journal_id {
            return Err("usn_journal_replaced");
        }
        let mut departures = VolumeChanges::default();
        read_journal(
            &hint.file,
            journal_id,
            read_until,
            now.NextUsn,
            budget,
            &mut |record| departures.learn_departure(record),
        )?;
        for (directory, parent) in departures.departed {
            changes.departed.entry(directory).or_insert(parent);
        }
    }
}

/// Where directory `id` lies. A directory that can no longer be opened is placed by the parent
/// it departed from; one that was below a root is a reason to fall back, since its entries went
/// with it.
fn place(
    resolver: &mut Resolver<'_>,
    departed: &HashMap<u128, u128>,
    roots: &[(usize, &OpenRoot)],
    id: u128,
    budget: &mut Budget,
) -> Result<Place, &'static str> {
    let mut current = id;
    for depth in 0..MAX_DEPARTED_DEPTH {
        match resolver.resolve(current, budget)? {
            Resolved::Path(path) => {
                let inside = locate(path, roots)?;
                return Ok(match (inside.is_empty(), depth) {
                    (true, _) => Place::Outside,
                    (false, 0) => Place::Inside(inside),
                    (false, _) => return Err("directory_moved_or_deleted"),
                });
            }
            Resolved::Denied => return Ok(Place::Outside),
            Resolved::Gone => {}
        }
        match departed.get(&current) {
            Some(parent) => current = *parent,
            None => return Ok(Place::Unknown),
        }
    }
    Ok(Place::Unknown)
}

/// The roots `path` lies in or below, with its `/`-separated path below each.
fn locate(
    path: &[u16],
    roots: &[(usize, &OpenRoot)],
) -> Result<Vec<(usize, String)>, &'static str> {
    const SEPARATOR: u16 = b'\\' as u16;
    let mut inside = Vec::new();
    for (index, root) in roots {
        let root_path = root.wide_path.as_slice();
        let Some(rest) = path.strip_prefix(root_path) else {
            continue;
        };
        let rest = if rest.is_empty() || root_path.last() == Some(&SEPARATOR) {
            rest
        } else if let Some(rest) = rest.strip_prefix(&[SEPARATOR]) {
            rest
        } else {
            // A sibling that shares the root's name as a prefix.
            continue;
        };
        let relative = String::from_utf16(rest).map_err(|_| "usn_path_not_unicode")?;
        inside.push((*index, relative.replace('\\', "/")));
    }
    Ok(inside)
}

/// What opening a directory by id found.
#[derive(Clone)]
enum Resolved {
    Path(Vec<u16>),
    /// It exists, but this user may not open it.
    Denied,
    /// It no longer exists (or cannot be named).
    Gone,
}

/// Directory paths by id, each resolved once.
struct Resolver<'a> {
    hint: &'a File,
    paths: HashMap<u128, Resolved>,
}

impl Resolver<'_> {
    fn spend(budget: &mut Budget, count: usize) -> Result<(), &'static str> {
        budget.resolutions = budget
            .resolutions
            .checked_sub(count)
            .ok_or("usn_too_many_directories")?;
        Ok(())
    }

    /// Resolves `ids` together, on several threads when there are many.
    fn prefetch(&mut self, ids: &[u128], budget: &mut Budget) -> Result<(), &'static str> {
        Self::spend(budget, ids.len())?;
        let threads = std::thread::available_parallelism()
            .map_or(4, std::num::NonZeroUsize::get)
            .min(MAX_RESOLUTION_THREADS)
            .min(ids.len().div_ceil(RESOLUTIONS_PER_THREAD))
            .max(1);
        let hint = self.hint;
        let resolved = if threads == 1 {
            ids.iter().map(|id| resolve(hint, *id)).collect::<Vec<_>>()
        } else {
            let chunk = ids.len().div_ceil(threads);
            std::thread::scope(|scope| {
                let workers = ids
                    .chunks(chunk)
                    .map(|ids| {
                        scope.spawn(move || {
                            ids.iter().map(|id| resolve(hint, *id)).collect::<Vec<_>>()
                        })
                    })
                    .collect::<Vec<_>>();
                workers
                    .into_iter()
                    .zip(ids.chunks(chunk))
                    // A worker that panicked resolved nothing: its directories stay unknown.
                    .flat_map(|(worker, ids)| {
                        worker
                            .join()
                            .unwrap_or_else(|_| vec![Resolved::Gone; ids.len()])
                    })
                    .collect::<Vec<_>>()
            })
        };
        self.paths.extend(ids.iter().copied().zip(resolved));
        Ok(())
    }

    fn resolve(&mut self, id: u128, budget: &mut Budget) -> Result<&Resolved, &'static str> {
        if !self.paths.contains_key(&id) {
            Self::spend(budget, 1)?;
            self.paths.insert(id, resolve(self.hint, id));
        }
        self.paths.get(&id).ok_or("usn_parent_unresolvable")
    }
}

fn open_roots(roots: &[PathBuf]) -> Result<Vec<OpenRoot>, &'static str> {
    roots
        .iter()
        .map(|root| {
            let file = open_directory(root).map_err(|_| "content_root_unavailable")?;
            let (volume, file_id) = file_identity(&file).ok_or("usn_unavailable")?;
            let wide_path = final_path(raw(&file)).ok_or("usn_unavailable")?;
            let path = String::from_utf16(&wide_path).map_err(|_| "usn_path_not_unicode")?;
            Ok(OpenRoot {
                file,
                identity: RootIdentity {
                    path,
                    volume,
                    file_id,
                },
                wide_path,
            })
        })
        .collect()
}

/// A directory opened to read its attributes, following junctions and symbolic links to their
/// target as listing it would.
fn open_directory(path: &Path) -> std::io::Result<File> {
    OpenOptions::new()
        .access_mode(FILE_READ_ATTRIBUTES | SYNCHRONIZE)
        .share_mode(FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE)
        .custom_flags(FILE_FLAG_BACKUP_SEMANTICS)
        .open(path)
}

fn raw(file: &File) -> HANDLE {
    file.as_raw_handle() as HANDLE
}

/// The volume serial number and file id of an open file.
fn file_identity(file: &File) -> Option<(u64, u128)> {
    let mut info = FILE_ID_INFO::default();
    // SAFETY: the handle is open for the duration of the call, and `info` is a writable
    // FILE_ID_INFO of the size passed, the structure the FileIdInfo class fills.
    let ok = unsafe {
        GetFileInformationByHandleEx(
            raw(file),
            FileIdInfo,
            (&mut info as *mut FILE_ID_INFO).cast(),
            std::mem::size_of::<FILE_ID_INFO>() as u32,
        )
    };
    (ok != 0).then(|| {
        (
            info.VolumeSerialNumber,
            u128::from_le_bytes(info.FileId.Identifier),
        )
    })
}

/// The final path of an open file or directory, as the file system spells it.
fn final_path(handle: HANDLE) -> Option<Vec<u16>> {
    let mut buffer = vec![0_u16; 512];
    // A path that grows between calls asks once more; past that it is treated as unreadable.
    for _ in 0..3 {
        // SAFETY: the handle is open for the duration of the call and `buffer` is writable for
        // the length passed; the function writes at most that many UTF-16 units.
        let length = unsafe {
            GetFinalPathNameByHandleW(
                handle,
                buffer.as_mut_ptr(),
                u32::try_from(buffer.len()).ok()?,
                FILE_NAME_NORMALIZED | VOLUME_NAME_DOS,
            )
        } as usize;
        if length == 0 {
            return None;
        }
        if length < buffer.len() {
            buffer.truncate(length);
            return Some(buffer);
        }
        // Too small: `length` is the size needed, terminating null included.
        buffer.resize(length, 0);
    }
    None
}

/// The final path of the file or directory with `id` on the hint's volume.
fn resolve(hint: &File, id: u128) -> Resolved {
    let descriptor = FILE_ID_DESCRIPTOR {
        dwSize: std::mem::size_of::<FILE_ID_DESCRIPTOR>() as u32,
        Type: ExtendedFileIdType,
        Anonymous: FILE_ID_DESCRIPTOR_0 {
            ExtendedFileId: FILE_ID_128 {
                Identifier: id.to_le_bytes(),
            },
        },
    };
    // SAFETY: the hint handle is open for the duration of the call and `descriptor` is a valid
    // extended FILE_ID_DESCRIPTOR. No access is requested, only the handle to name the file; a
    // null security descriptor is allowed.
    let handle = unsafe {
        OpenFileById(
            raw(hint),
            &descriptor,
            0,
            FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE,
            std::ptr::null(),
            FILE_FLAG_BACKUP_SEMANTICS,
        )
    };
    if handle == INVALID_HANDLE_VALUE || handle.is_null() {
        // SAFETY: reads the calling thread's last error, set by the failed call above.
        return if unsafe { GetLastError() } == ERROR_ACCESS_DENIED {
            Resolved::Denied
        } else {
            // A deleted file's id names an unused or reused record: an invalid parameter.
            Resolved::Gone
        };
    }
    // SAFETY: OpenFileById returned a new handle that nothing else owns; OwnedHandle closes it.
    let handle = unsafe { OwnedHandle::from_raw_handle(handle as RawHandle) };
    final_path(handle.as_raw_handle() as HANDLE).map_or(Resolved::Gone, Resolved::Path)
}

fn query_journal(file: &File) -> Result<USN_JOURNAL_DATA_V0, &'static str> {
    let mut journal = USN_JOURNAL_DATA_V0::default();
    let mut returned = 0_u32;
    // SAFETY: the handle is open for the call; the control code takes no input and writes a
    // USN_JOURNAL_DATA_V0 into the writable output buffer of the size passed. The call is
    // synchronous (no OVERLAPPED).
    let ok = unsafe {
        DeviceIoControl(
            raw(file),
            FSCTL_QUERY_USN_JOURNAL,
            std::ptr::null(),
            0,
            (&mut journal as *mut USN_JOURNAL_DATA_V0).cast(),
            std::mem::size_of::<USN_JOURNAL_DATA_V0>() as u32,
            &mut returned,
            std::ptr::null_mut(),
        )
    };
    if ok == 0 || returned as usize != std::mem::size_of::<USN_JOURNAL_DATA_V0>() {
        return Err("usn_journal_unavailable");
    }
    Ok(journal)
}

/// Calls `visit` with each record from `from` up to (not including) `until`.
fn read_journal(
    file: &File,
    journal_id: u64,
    from: i64,
    until: i64,
    budget: &mut Budget,
    visit: &mut dyn FnMut(Record),
) -> Result<(), &'static str> {
    let mut buffer = vec![0_u8; READ_BUFFER_BYTES];
    let mut start = from;
    while start < until {
        let input = READ_USN_JOURNAL_DATA_V1 {
            StartUsn: start,
            ReasonMask: u32::MAX,
            ReturnOnlyOnClose: 0,
            Timeout: 0,
            BytesToWaitFor: 0,
            UsnJournalID: journal_id,
            MinMajorVersion: 2,
            MaxMajorVersion: 3,
        };
        let mut returned = 0_u32;
        // SAFETY: the handle is open for the call; `input` is a READ_USN_JOURNAL_DATA_V1 of the
        // size passed and `buffer` is writable for its length. The call is synchronous and
        // returns at once (no timeout, no bytes to wait for).
        let ok = unsafe {
            DeviceIoControl(
                raw(file),
                FSCTL_READ_UNPRIVILEGED_USN_JOURNAL,
                (&input as *const READ_USN_JOURNAL_DATA_V1).cast(),
                std::mem::size_of::<READ_USN_JOURNAL_DATA_V1>() as u32,
                buffer.as_mut_ptr().cast(),
                READ_BUFFER_BYTES as u32,
                &mut returned,
                std::ptr::null_mut(),
            )
        };
        if ok == 0 {
            // SAFETY: reads the calling thread's last error, set by the failed call above.
            let error = unsafe { GetLastError() };
            return Err(if error == ERROR_JOURNAL_ENTRY_DELETED {
                "usn_journal_wrapped"
            } else {
                "usn_read_failed"
            });
        }
        let bytes = buffer
            .get(..returned as usize)
            .ok_or("usn_record_malformed")?;
        let next = read_i64(bytes, 0)?;
        let mut offset = 8;
        while offset < bytes.len() {
            let length = read_u32(bytes, offset)? as usize;
            let record = bytes
                .get(offset..offset.saturating_add(length))
                .filter(|_| length >= 8)
                .ok_or("usn_record_malformed")?;
            let record = parse_record(record)?;
            if record.usn >= until {
                return Ok(());
            }
            budget.records = budget
                .records
                .checked_sub(1)
                .ok_or("usn_too_many_records")?;
            visit(record);
            offset += length;
        }
        if next <= start {
            // The journal holds nothing more.
            break;
        }
        start = next;
    }
    Ok(())
}

/// A `USN_RECORD_V2` or `USN_RECORD_V3`; their names are empty in an unprivileged read.
fn parse_record(record: &[u8]) -> Result<Record, &'static str> {
    match read_u16(record, 4)? {
        2 => Ok(Record {
            file: u128::from(read_u64(record, 8)?),
            parent: u128::from(read_u64(record, 16)?),
            usn: read_i64(record, 24)?,
            reason: read_u32(record, 40)?,
            attributes: read_u32(record, 52)?,
        }),
        3 => Ok(Record {
            file: read_u128(record, 8)?,
            parent: read_u128(record, 24)?,
            usn: read_i64(record, 40)?,
            reason: read_u32(record, 56)?,
            attributes: read_u32(record, 68)?,
        }),
        _ => Err("usn_record_unsupported"),
    }
}

fn read_array<const N: usize>(bytes: &[u8], offset: usize) -> Result<[u8; N], &'static str> {
    bytes
        .get(offset..offset.saturating_add(N))
        .and_then(|slice| slice.try_into().ok())
        .ok_or("usn_record_malformed")
}

fn read_u16(bytes: &[u8], offset: usize) -> Result<u16, &'static str> {
    read_array(bytes, offset).map(u16::from_le_bytes)
}

fn read_u32(bytes: &[u8], offset: usize) -> Result<u32, &'static str> {
    read_array(bytes, offset).map(u32::from_le_bytes)
}

fn read_u64(bytes: &[u8], offset: usize) -> Result<u64, &'static str> {
    read_array(bytes, offset).map(u64::from_le_bytes)
}

fn read_i64(bytes: &[u8], offset: usize) -> Result<i64, &'static str> {
    read_array(bytes, offset).map(i64::from_le_bytes)
}

fn read_u128(bytes: &[u8], offset: usize) -> Result<u128, &'static str> {
    read_array(bytes, offset).map(u128::from_le_bytes)
}

#[cfg(test)]
mod tests {
    use std::fs;
    use std::time::{SystemTime, UNIX_EPOCH};

    use super::*;

    struct TemporaryRoot(PathBuf);

    impl TemporaryRoot {
        fn new(name: &str) -> Self {
            let unique = SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_nanos();
            let path = std::env::temp_dir()
                .join(format!("fast-fs-{name}-{}-{unique}", std::process::id()));
            fs::create_dir_all(path.join("Content/Nested/Deep")).unwrap();
            fs::create_dir_all(path.join("Content/Other")).unwrap();
            fs::write(path.join("Content/Nested/A.uasset"), [1]).unwrap();
            fs::write(path.join("Content/Other/B.uasset"), [1]).unwrap();
            fs::create_dir_all(path.join("Outside")).unwrap();
            Self(path)
        }

        fn roots(&self) -> Vec<PathBuf> {
            vec![self.0.join("Content")]
        }
    }

    impl Drop for TemporaryRoot {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    fn changed(roots: &[PathBuf], since: &UsnCheckpoint) -> Result<Vec<String>, &'static str> {
        match read_changes_since(roots, since, &UsnLimits::default()) {
            UsnDelta::Changed {
                directories,
                checkpoint,
            } => {
                assert_eq!(checkpoint.roots, since.roots);
                assert!(
                    checkpoint
                        .journals
                        .iter()
                        .zip(&since.journals)
                        .all(|(after, before)| after.next_usn >= before.next_usn)
                );
                Ok(directories
                    .into_iter()
                    .map(|directory| {
                        assert_eq!(directory.root, 0);
                        directory.relative
                    })
                    .collect())
            }
            UsnDelta::Fallback(reason) => Err(reason),
        }
    }

    /// Runs `change` after a checkpoint and returns what the journal says changed.
    fn after(
        root: &TemporaryRoot,
        change: impl FnOnce(&Path),
    ) -> Result<Vec<String>, &'static str> {
        let roots = root.roots();
        let since = query_checkpoint(&roots).unwrap();
        change(&root.0);
        changed(&roots, &since)
    }

    #[test]
    fn an_unprivileged_checkpoint_identifies_the_roots() {
        let root = TemporaryRoot::new("identity");
        let checkpoint = query_checkpoint(&root.roots()).unwrap();
        assert_eq!(checkpoint.roots.len(), 1);
        assert_eq!(checkpoint.journals.len(), 1);
        assert_eq!(checkpoint.journals[0].volume, checkpoint.roots[0].volume);
        assert!(checkpoint.roots[0].path.ends_with("\\Content"));
        assert_eq!(
            query_checkpoint(&[root.0.join("Missing")]),
            Err("content_root_unavailable")
        );
    }

    #[test]
    fn nothing_changed_names_no_directory() {
        let root = TemporaryRoot::new("noop");
        assert_eq!(after(&root, |_| {}), Ok(vec![]));
    }

    #[test]
    fn file_changes_name_their_directories() {
        let root = TemporaryRoot::new("files");
        assert_eq!(
            after(&root, |path| fs::write(
                path.join("Content/Nested/New.uasset"),
                [1]
            )
            .unwrap()),
            Ok(vec!["Nested".to_owned()])
        );
        assert_eq!(
            after(&root, |path| {
                let file = fs::OpenOptions::new()
                    .write(true)
                    .open(path.join("Content/Nested/A.uasset"))
                    .unwrap();
                file.set_modified(UNIX_EPOCH + std::time::Duration::from_secs(1_700_000_000))
                    .unwrap();
            }),
            Ok(vec!["Nested".to_owned()])
        );
        assert_eq!(
            after(&root, |path| fs::write(
                path.join("Content/Other/B.uexp"),
                [1, 2]
            )
            .unwrap()),
            Ok(vec!["Other".to_owned()])
        );
        assert_eq!(
            after(&root, |path| fs::remove_file(
                path.join("Content/Other/B.uasset")
            )
            .unwrap()),
            Ok(vec!["Other".to_owned()])
        );
        assert_eq!(
            after(&root, |path| fs::write(
                path.join("Content/Root.uasset"),
                [1]
            )
            .unwrap()),
            Ok(vec![String::new()])
        );
        assert_eq!(
            after(&root, |path| fs::rename(
                path.join("Content/Nested/A.uasset"),
                path.join("Content/Nested/Deep/A.uasset")
            )
            .unwrap()),
            Ok(vec!["Nested".to_owned(), "Nested/Deep".to_owned()])
        );
        // A file moved out of the roots leaves its old directory changed.
        assert_eq!(
            after(&root, |path| fs::rename(
                path.join("Content/Nested/Deep/A.uasset"),
                path.join("Outside/A.uasset")
            )
            .unwrap()),
            Ok(vec!["Nested/Deep".to_owned()])
        );
    }

    #[test]
    fn changes_outside_the_roots_are_ignored() {
        let root = TemporaryRoot::new("outside");
        assert_eq!(
            after(&root, |path| {
                fs::write(path.join("Outside/A.uasset"), [1]).unwrap();
                fs::create_dir(path.join("Outside/Gone")).unwrap();
                fs::write(path.join("Outside/Gone/B.uasset"), [1]).unwrap();
                fs::remove_dir_all(path.join("Outside/Gone")).unwrap();
                fs::write(path.join("Sibling.uasset"), [1]).unwrap();
            }),
            Ok(vec![])
        );
        // A sibling directory whose name starts with the root's is not below it.
        let sibling = root.0.join("ContentSibling");
        fs::create_dir(&sibling).unwrap();
        assert_eq!(
            after(&root, |_| fs::write(sibling.join("A.uasset"), [1]).unwrap()),
            Ok(vec![])
        );
    }

    #[test]
    fn a_new_directory_with_files_is_read_without_a_fallback() {
        let root = TemporaryRoot::new("new-directory");
        assert_eq!(
            after(&root, |path| {
                fs::create_dir(path.join("Content/Fresh")).unwrap();
                fs::write(path.join("Content/Fresh/A.uasset"), [1]).unwrap();
            }),
            Ok(vec!["Fresh".to_owned()])
        );
    }

    #[test]
    fn directories_renamed_moved_or_deleted_below_a_root_fall_back() {
        let root = TemporaryRoot::new("directories");
        assert_eq!(
            after(&root, |path| fs::rename(
                path.join("Content/Nested/Deep"),
                path.join("Content/Nested/Renamed")
            )
            .unwrap()),
            Err("directory_moved_or_deleted")
        );
        assert_eq!(
            after(&root, |path| fs::rename(
                path.join("Content/Other"),
                path.join("Outside/Other")
            )
            .unwrap()),
            Err("directory_moved_or_deleted")
        );
        fs::create_dir(root.0.join("Outside/Incoming")).unwrap();
        fs::write(root.0.join("Outside/Incoming/C.uasset"), [1]).unwrap();
        assert_eq!(
            after(&root, |path| fs::rename(
                path.join("Outside/Incoming"),
                path.join("Content/Incoming")
            )
            .unwrap()),
            Err("directory_moved_or_deleted")
        );
        assert_eq!(
            after(&root, |path| fs::remove_dir_all(
                path.join("Content/Nested")
            )
            .unwrap()),
            Err("directory_moved_or_deleted")
        );
    }

    #[test]
    fn a_replaced_root_or_journal_falls_back() {
        let root = TemporaryRoot::new("replaced");
        let roots = root.roots();
        let since = query_checkpoint(&roots).unwrap();
        fs::remove_dir_all(&roots[0]).unwrap();
        fs::create_dir(&roots[0]).unwrap();
        assert_eq!(changed(&roots, &since), Err("content_root_changed"));

        let since = query_checkpoint(&roots).unwrap();
        let mut replaced = since.clone();
        replaced.journals[0].journal_id ^= 1;
        assert_eq!(changed(&roots, &replaced), Err("usn_journal_replaced"));
        let mut wrapped = since.clone();
        wrapped.journals[0].next_usn = 0;
        assert_eq!(changed(&roots, &wrapped), Err("usn_journal_wrapped"));
        assert_eq!(
            changed(&[roots[0].clone(), root.0.join("Outside")], &since),
            Err("content_root_changed")
        );
    }

    #[test]
    fn limits_fall_back() {
        let root = TemporaryRoot::new("limits");
        let roots = root.roots();
        let since = query_checkpoint(&roots).unwrap();
        fs::write(root.0.join("Content/Nested/New.uasset"), [1]).unwrap();
        fs::write(root.0.join("Content/Other/New.uasset"), [1]).unwrap();
        let limited = |limits: UsnLimits| match read_changes_since(&roots, &since, &limits) {
            UsnDelta::Fallback(reason) => reason,
            UsnDelta::Changed { .. } => "changed",
        };
        let defaults = UsnLimits::default();
        assert_eq!(
            limited(UsnLimits {
                max_records: 0,
                ..defaults
            }),
            "usn_too_many_records"
        );
        assert_eq!(
            limited(UsnLimits {
                max_resolutions: 0,
                ..defaults
            }),
            "usn_too_many_directories"
        );
        assert_eq!(
            limited(UsnLimits {
                max_directories: 1,
                ..defaults
            }),
            "usn_too_many_directories"
        );
    }

    #[test]
    fn a_junctioned_root_is_identified_by_its_target() {
        let root = TemporaryRoot::new("junction");
        let link = root.0.join("Linked");
        let status = std::process::Command::new("cmd")
            .args(["/c", "mklink", "/J"])
            .arg(&link)
            .arg(root.0.join("Content"))
            .output()
            .unwrap();
        assert!(status.status.success());
        let roots = vec![link.clone()];
        let since = query_checkpoint(&roots).unwrap();
        let direct = query_checkpoint(&root.roots()).unwrap();
        assert_eq!(since.roots, direct.roots);
        fs::write(root.0.join("Content/Other/Linked.uasset"), [1]).unwrap();
        assert_eq!(changed(&roots, &since), Ok(vec!["Other".to_owned()]));
        // Removing the junction (never its target) and pointing it elsewhere changes the root.
        fs::remove_dir(&link).unwrap();
        let status = std::process::Command::new("cmd")
            .args(["/c", "mklink", "/J"])
            .arg(&link)
            .arg(root.0.join("Outside"))
            .output()
            .unwrap();
        assert!(status.status.success());
        assert_eq!(changed(&roots, &since), Err("content_root_changed"));
        fs::remove_dir(&link).unwrap();
    }
}
