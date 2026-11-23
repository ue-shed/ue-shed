//! Windows file access for [`crate::files`]: `CreateFileW` opens that keep last-access times,
//! `GetFileInformationByHandleEx` signatures and `NtQueryDirectoryFile` listings.
//!
//! Paths reach `CreateFileW` as the standard library passes them: short absolute paths as given,
//! anything else made absolute with `GetFullPathNameW` and given the verbatim `\\?\` prefix, so
//! paths past `MAX_PATH` open too.

use std::ffi::OsString;
use std::fs::File;
use std::io;
use std::mem::{offset_of, size_of};
use std::os::windows::ffi::{OsStrExt, OsStringExt};
use std::os::windows::io::{AsRawHandle, FromRawHandle, OwnedHandle};
use std::path::Path;
use std::ptr::{null, null_mut};

use windows_sys::Wdk::Storage::FileSystem::{
    FILE_FULL_DIR_INFORMATION, FileFullDirectoryInformation, NtQueryDirectoryFile,
};
use windows_sys::Win32::Foundation::{
    ERROR_ACCESS_DENIED, ERROR_DIRECTORY, ERROR_FILE_NOT_FOUND, ERROR_PATH_NOT_FOUND,
    ERROR_WRITE_PROTECT, FILETIME, NTSTATUS, RtlNtStatusToDosError, STATUS_NO_MORE_FILES,
    STATUS_NO_SUCH_FILE,
};
use windows_sys::Win32::Storage::FileSystem::{
    CreateFileW, FILE_ATTRIBUTE_DIRECTORY, FILE_ATTRIBUTE_REPARSE_POINT, FILE_ATTRIBUTE_TAG_INFO,
    FILE_BASIC_INFO, FILE_FLAG_BACKUP_SEMANTICS, FILE_FLAG_SEQUENTIAL_SCAN,
    FILE_FLAGS_AND_ATTRIBUTES, FILE_INFO_BY_HANDLE_CLASS, FILE_LIST_DIRECTORY,
    FILE_READ_ATTRIBUTES, FILE_READ_DATA, FILE_SHARE_DELETE, FILE_SHARE_READ, FILE_SHARE_WRITE,
    FILE_STANDARD_INFO, FILE_WRITE_ATTRIBUTES, FileAttributeTagInfo, FileBasicInfo,
    FileStandardInfo, GetFileInformationByHandleEx, GetFullPathNameW, OPEN_EXISTING, SYNCHRONIZE,
    SetFileTime,
};
use windows_sys::Win32::System::IO::IO_STATUS_BLOCK;

use crate::files::{DirEntryInfo, DirEntryKind, Listed};

/// `FILETIME` ticks (100 ns since 1601-01-01) at the Unix epoch.
const UNIX_EPOCH_TICKS: i64 = 116_444_736_000_000_000;
/// `IsReparseTagNameSurrogate`: the reparse point names another file (a symbolic link or a
/// junction), which the standard library reports as a link rather than a file or directory.
const REPARSE_TAG_NAME_SURROGATE: u32 = 0x2000_0000;
/// A last-access time `SetFileTime` reads as "keep it as it is for the rest of this handle".
const PRESERVE_TIME: FILETIME = FILETIME {
    dwLowDateTime: u32::MAX,
    dwHighDateTime: u32::MAX,
};
const SHARE_ALL: u32 = FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE;
const READ_ACCESS: u32 = FILE_READ_DATA | FILE_READ_ATTRIBUTES | SYNCHRONIZE;
const LIST_BUFFER_WORDS: usize = 64 * 1024 / size_of::<u64>();
/// Shorter paths (with their terminating nul) go to `CreateFileW` as given when absolute.
const LEGACY_MAX_PATH: usize = 248;

// `FileStandardInfo` is read into `[u64; 3]`, so its `BOOLEAN` fields are never read as `bool`.
const _: () = assert!(size_of::<FILE_STANDARD_INFO>() == size_of::<[u64; 3]>());
const _: () = assert!(offset_of!(FILE_STANDARD_INFO, EndOfFile) == size_of::<u64>());

pub(crate) fn open_read_no_atime(path: &Path) -> io::Result<File> {
    let path = wide_path(path)?;
    let handle = match open_handle(
        &path,
        READ_ACCESS | FILE_WRITE_ATTRIBUTES,
        FILE_FLAG_SEQUENTIAL_SCAN,
    ) {
        Ok(handle) => {
            // SAFETY: `handle` is open with `FILE_WRITE_ATTRIBUTES`; null times stay unchanged.
            // A file system that cannot keep the time fails here, and the read goes on.
            unsafe { SetFileTime(handle.as_raw_handle(), null(), &PRESERVE_TIME, null()) };
            handle
        }
        // An access list without the attributes right, or a read-only volume.
        Err(error)
            if error.raw_os_error().is_some_and(|code| {
                code == ERROR_ACCESS_DENIED as i32 || code == ERROR_WRITE_PROTECT as i32
            }) =>
        {
            open_handle(&path, READ_ACCESS, FILE_FLAG_SEQUENTIAL_SCAN)?
        }
        Err(error) => return Err(error),
    };
    Ok(File::from(handle))
}

pub(crate) fn file_signature(file: &File) -> io::Result<Option<(u64, u64)>> {
    let mut basic = FILE_BASIC_INFO::default();
    query_information(file, FileBasicInfo, &mut basic)?;
    if basic.FileAttributes & FILE_ATTRIBUTE_DIRECTORY != 0 {
        return Ok(None);
    }
    if basic.FileAttributes & FILE_ATTRIBUTE_REPARSE_POINT != 0 {
        let mut tag = FILE_ATTRIBUTE_TAG_INFO::default();
        query_information(file, FileAttributeTagInfo, &mut tag)?;
        if tag.FileAttributes & FILE_ATTRIBUTE_REPARSE_POINT != 0
            && tag.ReparseTag & REPARSE_TAG_NAME_SURROGATE != 0
        {
            return Ok(None);
        }
    }
    Ok(Some((file_len(file)?, filetime_nanos(basic.LastWriteTime))))
}

pub(crate) fn file_len(file: &File) -> io::Result<u64> {
    let mut standard = [0_u64; 3];
    query_information(file, FileStandardInfo, &mut standard)?;
    Ok(standard[1])
}

pub(crate) fn visit_dir_entries(
    directory: &Path,
    visit: &mut dyn FnMut(DirEntryInfo<'_>) -> io::Result<bool>,
) -> io::Result<()> {
    // `read_dir` refuses the empty path rather than list the current directory.
    if directory.as_os_str().is_empty() {
        return Err(io::Error::from_raw_os_error(ERROR_PATH_NOT_FOUND as i32));
    }
    let path = wide_path(directory)?;
    let handle = open_handle(
        &path,
        FILE_LIST_DIRECTORY | SYNCHRONIZE,
        FILE_FLAG_BACKUP_SEMANTICS,
    )
    .map_err(|error| {
        // `read_dir` lists `directory\*`, whose directory is the missing path.
        if error.raw_os_error() == Some(ERROR_FILE_NOT_FOUND as i32) {
            io::Error::from_raw_os_error(ERROR_PATH_NOT_FOUND as i32)
        } else {
            error
        }
    })?;
    let directory_file = File::from(handle);
    let mut buffer = vec![0_u64; LIST_BUFFER_WORDS];
    let mut name = Vec::new();
    let mut first = true;
    loop {
        let mut status_block = IO_STATUS_BLOCK::default();
        // SAFETY: the handle is a synchronous directory handle with `FILE_LIST_DIRECTORY`, and
        // `buffer` is 8-byte aligned and writable for the length given.
        let status = unsafe {
            NtQueryDirectoryFile(
                directory_file.as_raw_handle(),
                null_mut(),
                None,
                null(),
                &mut status_block,
                buffer.as_mut_ptr().cast(),
                (buffer.len() * size_of::<u64>()) as u32,
                FileFullDirectoryInformation,
                false,
                null(),
                false,
            )
        };
        if status == STATUS_NO_MORE_FILES || status == STATUS_NO_SUCH_FILE {
            return Ok(());
        }
        if status < 0 {
            return Err(listing_error(&directory_file, status, first));
        }
        first = false;
        let filled = status_block
            .Information
            .min(buffer.len() * size_of::<u64>());
        // SAFETY: a `u64` buffer is readable as bytes over its whole length.
        let bytes = unsafe {
            std::slice::from_raw_parts(
                buffer.as_ptr().cast::<u8>(),
                buffer.len() * size_of::<u64>(),
            )
        };
        let mut offset = 0;
        while let Some(entry) = bytes[..filled].get(offset..) {
            let Some(listed) = read_entry(entry, &mut name) else {
                break;
            };
            if !is_dot_entry(&name) {
                let file_name = OsString::from_wide(&name);
                if !visit(DirEntryInfo::listed(directory, &file_name, listed.0))? {
                    return Ok(());
                }
            }
            if listed.1 == 0 {
                break;
            }
            offset += listed.1;
        }
    }
}

/// One `FILE_FULL_DIR_INFORMATION` record: what it says, its name (into `name`) and the offset
/// of the next record (`0` for the last), or `None` when the record is truncated.
fn read_entry(entry: &[u8], name: &mut Vec<u16>) -> Option<(Listed, usize)> {
    let name_start = offset_of!(FILE_FULL_DIR_INFORMATION, FileName);
    let name_len = u32_at(entry, offset_of!(FILE_FULL_DIR_INFORMATION, FileNameLength))? as usize;
    let name_bytes = entry.get(name_start..name_start.checked_add(name_len)?)?;
    name.clear();
    name.extend(
        name_bytes
            .as_chunks::<2>()
            .0
            .iter()
            .map(|pair| u16::from_le_bytes(*pair)),
    );
    let attributes = u32_at(entry, offset_of!(FILE_FULL_DIR_INFORMATION, FileAttributes))?;
    // For a reparse point the listing's extended-attribute size holds its reparse tag, which is
    // what `FindFirstFileExW` reports and `std::fs::DirEntry::file_type` reads.
    let reparse_tag = u32_at(entry, offset_of!(FILE_FULL_DIR_INFORMATION, EaSize))?;
    let link = attributes & FILE_ATTRIBUTE_REPARSE_POINT != 0
        && reparse_tag & REPARSE_TAG_NAME_SURROGATE != 0;
    let kind = if link {
        DirEntryKind::Other
    } else if attributes & FILE_ATTRIBUTE_DIRECTORY != 0 {
        DirEntryKind::Directory
    } else {
        DirEntryKind::File
    };
    let size = i64_at(entry, offset_of!(FILE_FULL_DIR_INFORMATION, EndOfFile))?;
    let modified = i64_at(entry, offset_of!(FILE_FULL_DIR_INFORMATION, LastWriteTime))?;
    let next = u32_at(
        entry,
        offset_of!(FILE_FULL_DIR_INFORMATION, NextEntryOffset),
    )? as usize;
    Some((
        Listed {
            kind,
            size: size as u64,
            modified_nanos: filetime_nanos(modified),
        },
        next,
    ))
}

fn is_dot_entry(name: &[u16]) -> bool {
    const DOT: u16 = b'.' as u16;
    matches!(name, [DOT] | [DOT, DOT])
}

fn u32_at(bytes: &[u8], offset: usize) -> Option<u32> {
    let mut value = [0; 4];
    value.copy_from_slice(bytes.get(offset..offset.checked_add(4)?)?);
    Some(u32::from_le_bytes(value))
}

fn i64_at(bytes: &[u8], offset: usize) -> Option<i64> {
    let mut value = [0; 8];
    value.copy_from_slice(bytes.get(offset..offset.checked_add(8)?)?);
    Some(i64::from_le_bytes(value))
}

/// The error `read_dir` gives for a failed listing: a path that names a file is not a directory.
fn listing_error(directory: &File, status: NTSTATUS, first: bool) -> io::Error {
    if first {
        let mut basic = FILE_BASIC_INFO::default();
        if query_information(directory, FileBasicInfo, &mut basic).is_ok()
            && basic.FileAttributes & FILE_ATTRIBUTE_DIRECTORY == 0
        {
            return io::Error::from_raw_os_error(ERROR_DIRECTORY as i32);
        }
    }
    // SAFETY: a pure status-code translation.
    let code = unsafe { RtlNtStatusToDosError(status) };
    io::Error::from_raw_os_error(code as i32)
}

/// Nanoseconds since the Unix epoch, as `SystemTime::duration_since(UNIX_EPOCH)` gives them for
/// a Windows file time: `0` before the epoch, saturating past `u64`.
pub(crate) fn filetime_nanos(ticks: i64) -> u64 {
    if ticks < UNIX_EPOCH_TICKS {
        return 0;
    }
    let nanos = u128::from((ticks - UNIX_EPOCH_TICKS) as u64) * 100;
    u64::try_from(nanos).unwrap_or(u64::MAX)
}

/// Plain-data `GetFileInformationByHandleEx` results: every bit pattern of `T` is valid.
trait HandleInformation {}
impl HandleInformation for FILE_BASIC_INFO {}
impl HandleInformation for FILE_ATTRIBUTE_TAG_INFO {}
impl HandleInformation for [u64; 3] {}

fn query_information<T: HandleInformation>(
    file: &File,
    class: FILE_INFO_BY_HANDLE_CLASS,
    information: &mut T,
) -> io::Result<()> {
    // SAFETY: `information` is writable for its size, and any bytes written form a valid `T`.
    let succeeded = unsafe {
        GetFileInformationByHandleEx(
            file.as_raw_handle(),
            class,
            (information as *mut T).cast(),
            size_of::<T>() as u32,
        )
    };
    if succeeded == 0 {
        Err(io::Error::last_os_error())
    } else {
        Ok(())
    }
}

fn open_handle(
    path: &[u16],
    access: u32,
    flags: FILE_FLAGS_AND_ATTRIBUTES,
) -> io::Result<OwnedHandle> {
    // SAFETY: `path` is nul-terminated UTF-16; the remaining arguments are plain values or null.
    let handle = unsafe {
        CreateFileW(
            path.as_ptr(),
            access,
            SHARE_ALL,
            null(),
            OPEN_EXISTING,
            flags,
            null_mut(),
        )
    };
    if handle == windows_sys::Win32::Foundation::INVALID_HANDLE_VALUE {
        return Err(io::Error::last_os_error());
    }
    // SAFETY: `CreateFileW` returned a valid handle that nothing else owns.
    Ok(unsafe { OwnedHandle::from_raw_handle(handle) })
}

/// The nul-terminated path `CreateFileW` is given, the way the standard library builds it.
fn wide_path(path: &Path) -> io::Result<Vec<u16>> {
    let mut wide: Vec<u16> = path.as_os_str().encode_wide().collect();
    if wide.contains(&0) {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "path contains an interior nul",
        ));
    }
    wide.push(0);
    long_path(wide)
}

fn long_path(path: Vec<u16>) -> io::Result<Vec<u16>> {
    const SEP: u16 = b'\\' as u16;
    const ALT_SEP: u16 = b'/' as u16;
    const QUERY: u16 = b'?' as u16;
    const COLON: u16 = b':' as u16;
    const DOT: u16 = b'.' as u16;
    const VERBATIM_PREFIX: &[u16] = &[SEP, SEP, QUERY, SEP];
    const NT_PREFIX: &[u16] = &[SEP, QUERY, QUERY, SEP];
    const UNC_PREFIX: &[u16] = &[
        SEP,
        SEP,
        QUERY,
        SEP,
        b'U' as u16,
        b'N' as u16,
        b'C' as u16,
        SEP,
    ];

    if path.starts_with(VERBATIM_PREFIX) || path.starts_with(NT_PREFIX) || path == [0] {
        return Ok(path);
    }
    if path.len() < LEGACY_MAX_PATH {
        match path.as_slice() {
            [drive, COLON, 0] | [drive, COLON, SEP | ALT_SEP, ..]
                if *drive != SEP && *drive != ALT_SEP =>
            {
                return Ok(path);
            }
            [SEP | ALT_SEP, SEP | ALT_SEP, ..] => return Ok(path),
            _ => {}
        }
    }
    let absolute = full_path_name(&path)?;
    let (prefix, absolute): (&[u16], &[u16]) = match absolute.as_slice() {
        [_, COLON, SEP, ..] => (VERBATIM_PREFIX, &absolute),
        [SEP, SEP, DOT, SEP, rest @ ..] => (VERBATIM_PREFIX, rest),
        [SEP, SEP, QUERY, SEP, ..] | [SEP, QUERY, QUERY, SEP, ..] => (&[], &absolute),
        [SEP, SEP, rest @ ..] => (UNC_PREFIX, rest),
        _ => (&[], &absolute),
    };
    let mut verbatim = Vec::with_capacity(prefix.len() + absolute.len() + 1);
    verbatim.extend_from_slice(prefix);
    verbatim.extend_from_slice(absolute);
    verbatim.push(0);
    Ok(verbatim)
}

/// `GetFullPathNameW` of a nul-terminated path, without its nul.
fn full_path_name(path: &[u16]) -> io::Result<Vec<u16>> {
    let mut buffer = vec![0_u16; path.len().max(512)];
    loop {
        let capacity = u32::try_from(buffer.len()).unwrap_or(u32::MAX);
        // SAFETY: `path` is nul-terminated and `buffer` is writable for `capacity` units.
        let written =
            unsafe { GetFullPathNameW(path.as_ptr(), capacity, buffer.as_mut_ptr(), null_mut()) }
                as usize;
        if written == 0 {
            return Err(io::Error::last_os_error());
        }
        if written < buffer.len() {
            buffer.truncate(written);
            return Ok(buffer);
        }
        buffer.resize(written, 0);
    }
}
