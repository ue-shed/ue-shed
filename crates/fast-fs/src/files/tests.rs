#![allow(clippy::unwrap_used, clippy::expect_used)]

use super::*;
use std::collections::BTreeMap;
use std::fs;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

struct TemporaryDirectory(PathBuf);

impl TemporaryDirectory {
    fn new(label: &str) -> Self {
        let unique = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let path =
            std::env::temp_dir().join(format!("fast-fs-{label}-{}-{unique}", std::process::id()));
        fs::create_dir_all(&path).unwrap();
        Self(path)
    }
}

impl Drop for TemporaryDirectory {
    fn drop(&mut self) {
        clear_read_only(&self.0);
        let _ = fs::remove_dir_all(&self.0);
    }
}

fn clear_read_only(directory: &Path) {
    let Ok(entries) = fs::read_dir(directory) else {
        return;
    };
    for entry in entries.flatten() {
        let Ok(kind) = entry.file_type() else {
            continue;
        };
        if kind.is_dir() {
            clear_read_only(&entry.path());
        } else if kind.is_file()
            && let Ok(metadata) = entry.metadata()
        {
            let mut permissions = metadata.permissions();
            if permissions.readonly() {
                #[allow(clippy::permissions_set_readonly_false)]
                permissions.set_readonly(false);
                let _ = fs::set_permissions(entry.path(), permissions);
            }
        }
    }
}

fn modified_nanos(metadata: &fs::Metadata) -> u64 {
    metadata
        .modified()
        .ok()
        .and_then(|modified| modified.duration_since(UNIX_EPOCH).ok())
        .map_or(0, |duration| {
            u64::try_from(duration.as_nanos()).unwrap_or(u64::MAX)
        })
}

fn set_modified(path: &Path, time: SystemTime) {
    fs::OpenOptions::new()
        .write(true)
        .open(path)
        .unwrap()
        .set_modified(time)
        .unwrap();
}

/// Files of assorted sizes, names and modification times (including one before 1970), nested.
fn populate(root: &Path) {
    let nested = root.join("Maps").join("Sub Dir").join("Deeper");
    fs::create_dir_all(&nested).unwrap();
    fs::create_dir_all(root.join("EMPTY")).unwrap();
    let files: [(PathBuf, usize); 8] = [
        (root.join("Asset.UASSET"), 0),
        (root.join("lower.uasset"), 1),
        (root.join("MiXeD.Uexp"), 4096),
        (root.join("Maps").join("Level.umap"), 70_001),
        (root.join("Maps").join("Unicodé ✓.ubulk"), 17),
        (root.join("Maps").join("Sub Dir").join("no_extension"), 3),
        (nested.join("Deep.uasset"), 65_536),
        (nested.join("Before1970.uasset"), 9),
    ];
    for (index, (path, size)) in files.iter().enumerate() {
        fs::write(path, vec![u8::try_from(index).unwrap(); *size]).unwrap();
    }
    set_modified(
        &root.join("lower.uasset"),
        UNIX_EPOCH + Duration::new(1_234_567_890, 123_456_700),
    );
    set_modified(
        &nested.join("Before1970.uasset"),
        UNIX_EPOCH - Duration::from_secs(86_400 * 400),
    );
}

#[derive(Debug, PartialEq, Eq)]
struct Listed {
    kind: DirEntryKind,
    size: u64,
    modified_nanos: u64,
    path: PathBuf,
}

fn std_listing(directory: &Path) -> BTreeMap<std::ffi::OsString, Listed> {
    fs::read_dir(directory)
        .unwrap()
        .map(|entry| {
            let entry = entry.unwrap();
            let kind = entry.file_type().unwrap();
            let kind = if kind.is_dir() {
                DirEntryKind::Directory
            } else if kind.is_file() {
                DirEntryKind::File
            } else {
                DirEntryKind::Other
            };
            let metadata = entry.metadata().unwrap();
            (
                entry.file_name(),
                Listed {
                    kind,
                    size: metadata.len(),
                    modified_nanos: modified_nanos(&metadata),
                    path: entry.path(),
                },
            )
        })
        .collect()
}

fn fast_listing(directory: &Path) -> BTreeMap<std::ffi::OsString, Listed> {
    let mut listed = BTreeMap::new();
    visit_dir_entries(directory, |entry| {
        let (size, modified_nanos) = entry.signature()?;
        let previous = listed.insert(
            entry.file_name().to_owned(),
            Listed {
                kind: entry.kind()?,
                size,
                modified_nanos,
                path: entry.path(),
            },
        );
        assert!(previous.is_none(), "listed twice: {:?}", entry.file_name());
        Ok(true)
    })
    .unwrap();
    listed
}

/// Compares the listings of `directory` and every directory below it.
fn assert_listings_match(directory: &Path) -> usize {
    let expected = std_listing(directory);
    let actual = fast_listing(directory);
    assert_eq!(actual, expected, "listing of {}", directory.display());
    let mut compared = expected.len();
    for listed in expected.values() {
        if listed.kind == DirEntryKind::Directory {
            compared += assert_listings_match(&listed.path);
        }
    }
    compared
}

#[test]
fn listing_matches_read_dir_on_nested_directories() {
    let directory = TemporaryDirectory::new("listing");
    populate(&directory.0);
    assert_eq!(assert_listings_match(&directory.0), 12);
    let root = fast_listing(&directory.0);
    assert!(!root.contains_key(std::ffi::OsStr::new(".")));
    assert!(!root.contains_key(std::ffi::OsStr::new("..")));
    assert_eq!(
        root[std::ffi::OsStr::new("lower.uasset")].modified_nanos,
        1_234_567_890_123_456_700
    );
    let deeper = directory.0.join("Maps").join("Sub Dir").join("Deeper");
    assert_eq!(
        fast_listing(&deeper)[std::ffi::OsStr::new("Before1970.uasset")].modified_nanos,
        0
    );
    assert!(fast_listing(&directory.0.join("EMPTY")).is_empty());
}

#[test]
fn listing_of_many_entries_spans_several_batches() {
    let directory = TemporaryDirectory::new("batches");
    // Long names fill a 64 KiB batch with a few hundred entries.
    for index in 0..1_500 {
        let name = format!("{index:05}_{}.uasset", "x".repeat(120));
        fs::write(directory.0.join(name), [1, 2, 3]).unwrap();
    }
    assert_eq!(assert_listings_match(&directory.0), 1_500);
}

#[test]
fn listing_stops_when_the_visitor_says_so_and_passes_its_errors_on() {
    let directory = TemporaryDirectory::new("stop");
    for index in 0..10 {
        fs::write(directory.0.join(format!("{index}.uasset")), [1]).unwrap();
    }
    let mut visited = 0;
    visit_dir_entries(&directory.0, |_| {
        visited += 1;
        Ok(visited < 3)
    })
    .unwrap();
    assert_eq!(visited, 3);

    let mut visited = 0;
    let error = visit_dir_entries(&directory.0, |_| {
        visited += 1;
        Err(io::Error::other("stop here"))
    })
    .unwrap_err();
    assert_eq!(visited, 1);
    assert_eq!(error.to_string(), "stop here");
}

#[test]
fn listing_fails_as_read_dir_does() {
    let directory = TemporaryDirectory::new("listing-errors");
    let file = directory.0.join("file.uasset");
    fs::write(&file, [1]).unwrap();
    for path in [
        directory.0.join("missing"),
        directory.0.join("missing").join("below"),
        file,
        PathBuf::new(),
    ] {
        let expected = fs::read_dir(&path).map(|_| ()).unwrap_err();
        let actual = visit_dir_entries(&path, |_| Ok(true)).unwrap_err();
        assert_eq!(actual.kind(), expected.kind(), "{}", path.display());
        assert_eq!(
            actual.raw_os_error(),
            expected.raw_os_error(),
            "{}",
            path.display()
        );
    }
}

#[test]
fn file_signature_matches_metadata() {
    let directory = TemporaryDirectory::new("signature");
    populate(&directory.0);
    let mut compared = 0;
    let mut pending = vec![directory.0.clone()];
    while let Some(next) = pending.pop() {
        for entry in fs::read_dir(&next).unwrap() {
            let entry = entry.unwrap();
            if entry.file_type().unwrap().is_dir() {
                pending.push(entry.path());
                continue;
            }
            for file in [
                File::open(entry.path()).unwrap(),
                open_read_no_atime(&entry.path()).unwrap(),
            ] {
                let metadata = file.metadata().unwrap();
                assert!(metadata.is_file());
                assert_eq!(
                    file_signature(&file).unwrap(),
                    Some((metadata.len(), modified_nanos(&metadata))),
                    "{}",
                    entry.path().display()
                );
            }
            compared += 1;
        }
    }
    assert_eq!(compared, 8);
    assert_eq!(file_signature(&open_directory(&directory.0)).unwrap(), None);
}

#[cfg(windows)]
fn open_directory(path: &Path) -> File {
    use std::os::windows::fs::OpenOptionsExt;
    const FILE_FLAG_BACKUP_SEMANTICS: u32 = 0x0200_0000;
    fs::OpenOptions::new()
        .read(true)
        .custom_flags(FILE_FLAG_BACKUP_SEMANTICS)
        .open(path)
        .unwrap()
}

#[cfg(not(windows))]
fn open_directory(path: &Path) -> File {
    File::open(path).unwrap()
}

#[test]
fn reads_match_the_standard_library() {
    let directory = TemporaryDirectory::new("read");
    populate(&directory.0);
    for path in [
        directory.0.join("Asset.UASSET"),
        directory.0.join("Maps").join("Level.umap"),
        directory
            .0
            .join("Maps")
            .join("Sub Dir")
            .join("Deeper")
            .join("Deep.uasset"),
    ] {
        assert_eq!(read_no_atime(&path).unwrap(), fs::read(&path).unwrap());
        let mut bytes = Vec::new();
        open_read_no_atime(&path)
            .unwrap()
            .read_to_end(&mut bytes)
            .unwrap();
        assert_eq!(bytes, fs::read(&path).unwrap());
    }
    for path in [directory.0.join("missing.uasset"), directory.0.clone()] {
        let expected = File::open(&path).map(|_| ()).unwrap_err();
        let actual = open_read_no_atime(&path).map(|_| ()).unwrap_err();
        assert_eq!(actual.kind(), expected.kind(), "{}", path.display());
        assert_eq!(actual.raw_os_error(), expected.raw_os_error());
    }
}

#[test]
fn paths_past_max_path_open_and_list() {
    let directory = TemporaryDirectory::new("long");
    let mut deep = directory.0.clone();
    while deep.as_os_str().len() < 400 {
        deep.push("a_long_directory_name_segment");
    }
    fs::create_dir_all(&deep).unwrap();
    let file = deep.join("Long.uasset");
    fs::write(&file, b"long path").unwrap();
    assert_eq!(read_no_atime(&file).unwrap(), b"long path");
    assert_eq!(
        file_signature(&open_read_no_atime(&file).unwrap()).unwrap(),
        Some((9, modified_nanos(&fs::metadata(&file).unwrap())))
    );
    assert_listings_match(&directory.0);
}

#[cfg(windows)]
mod windows {
    use super::*;
    use std::fs::FileTimes;
    use std::os::windows::fs::OpenOptionsExt;
    use std::os::windows::io::AsRawHandle;
    use std::process::Command;

    use windows_sys::Win32::Storage::FileSystem::{
        FILE_READ_ATTRIBUTES, FILE_SHARE_DELETE, FILE_SHARE_READ, FILE_SHARE_WRITE,
    };
    use windows_sys::Win32::System::IO::DeviceIoControl;
    use windows_sys::Win32::System::Ioctl::FSCTL_READ_FILE_USN_DATA;

    /// The file's current USN, or `None` when its volume keeps no change journal.
    fn file_usn(path: &Path) -> Option<i64> {
        let file = fs::OpenOptions::new()
            .access_mode(FILE_READ_ATTRIBUTES)
            .share_mode(FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE)
            .open(path)
            .unwrap();
        let mut record = [0_u64; 128];
        let mut returned = 0_u32;
        // SAFETY: the output buffer is writable for its size; no input buffer.
        let succeeded = unsafe {
            DeviceIoControl(
                file.as_raw_handle(),
                FSCTL_READ_FILE_USN_DATA,
                std::ptr::null(),
                0,
                record.as_mut_ptr().cast(),
                u32::try_from(size_of_val(&record)).unwrap(),
                &mut returned,
                std::ptr::null_mut(),
            )
        };
        if succeeded == 0 {
            return None;
        }
        let bytes: Vec<u8> = record.iter().flat_map(|word| word.to_le_bytes()).collect();
        let major = u16::from_le_bytes([bytes[4], bytes[5]]);
        // `USN_RECORD_V2` keeps the USN after two 64-bit references, V3 after two 128-bit ones.
        let offset = if major >= 3 { 40 } else { 24 };
        Some(i64::from_le_bytes(
            bytes[offset..offset + 8].try_into().unwrap(),
        ))
    }

    fn accessed(path: &Path) -> SystemTime {
        fs::metadata(path).unwrap().accessed().unwrap()
    }

    /// On a volume that updates access times, a plain read of this file moves its access time
    /// (a year-2001 time is far older than any update interval); these reads must not.
    #[test]
    fn reading_a_read_only_file_keeps_its_access_time_and_usn() {
        let directory = TemporaryDirectory::new("atime");
        let path = directory.0.join("ReadOnly.uasset");
        let contents: Vec<u8> = (0..200_000_u32).map(|value| value as u8).collect();
        fs::write(&path, &contents).unwrap();
        let old = UNIX_EPOCH + Duration::from_secs(1_000_000_000);
        fs::OpenOptions::new()
            .write(true)
            .open(&path)
            .unwrap()
            .set_times(FileTimes::new().set_accessed(old).set_modified(old))
            .unwrap();
        let mut permissions = fs::metadata(&path).unwrap().permissions();
        permissions.set_readonly(true);
        fs::set_permissions(&path, permissions).unwrap();
        assert!(fs::metadata(&path).unwrap().permissions().readonly());
        assert_eq!(accessed(&path), old);
        let usn = file_usn(&path);

        for _ in 0..3 {
            assert_eq!(read_no_atime(&path).unwrap(), contents);
            let file = open_read_no_atime(&path).unwrap();
            assert_eq!(
                file_signature(&file).unwrap(),
                Some((
                    contents.len() as u64,
                    modified_nanos(&fs::metadata(&path).unwrap())
                ))
            );
            drop(file);
        }

        assert_eq!(accessed(&path), old);
        assert_eq!(fs::metadata(&path).unwrap().modified().unwrap(), old);
        assert!(fs::metadata(&path).unwrap().permissions().readonly());
        assert_eq!(
            file_usn(&path),
            usn,
            "reading wrote a change-journal record"
        );
    }

    /// Links are neither files nor directories, as `read_dir` reports them, and a listing does
    /// not enter them.
    #[test]
    fn links_are_listed_as_read_dir_lists_them() {
        let directory = TemporaryDirectory::new("links");
        let target = directory.0.join("Target");
        fs::create_dir(&target).unwrap();
        fs::write(target.join("Inside.uasset"), [1]).unwrap();
        let listing = directory.0.join("Listing");
        fs::create_dir(&listing).unwrap();
        let junction = Command::new("cmd")
            .arg("/C")
            .arg("mklink")
            .arg("/J")
            .arg(listing.join("Junction"))
            .arg(&target)
            .output()
            .is_ok_and(|output| output.status.success());
        let directory_link =
            std::os::windows::fs::symlink_dir(&target, listing.join("DirectoryLink")).is_ok();
        let file_link = std::os::windows::fs::symlink_file(
            target.join("Inside.uasset"),
            listing.join("FileLink.uasset"),
        )
        .is_ok();
        if !(junction || directory_link || file_link) {
            eprintln!("skipped: this account can create neither junctions nor symbolic links");
            return;
        }
        assert_listings_match(&listing);
        let listed = fast_listing(&listing);
        assert!(
            listed
                .values()
                .all(|entry| entry.kind == DirEntryKind::Other)
        );
    }
}
