//! v1.24 header reads from a package's leading bytes, checked against a header-depth scan of
//! the whole file.

use std::fs;
use std::path::{Path, PathBuf};

use super::{package_header_with_cancellation, scan_with_cancellation};
use crate::cancellation::CancellationToken;
use crate::direct_executor::Failure;
use crate::protocol::Request;
use crate::protocol_result::{PackageHeaderOutcome, SavedAssetHeader, SavedAssetScanEntry};

/// Current and legacy packages whose last export's data ends past their header.
const PACKAGES: &[&str] = &[
    "unreal-project/Content/Fixture/Input/IA_Jump.uasset",
    "unreal-project/Content/Fixture/Authoring/DT_Scalars.uasset",
    "legacy-unreal-project/Generated/4.27/Content/Legacy/DT_LegacyText.uasset",
];

/// A scratch project root with a `Content` folder, removed when dropped.
struct Scratch(PathBuf);

impl Scratch {
    fn new(label: &str) -> Self {
        let suffix = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .expect("system time after epoch")
            .as_nanos();
        let root = std::env::temp_dir().join(format!("ue-shed-leading-header-{label}-{suffix}"));
        fs::create_dir_all(root.join("Content")).expect("create scratch Content");
        Self(root)
    }

    fn write(&self, relative: &str, bytes: &[u8]) -> PathBuf {
        let path = self.0.join(relative);
        fs::write(&path, bytes).expect("write scratch file");
        path
    }
}

impl Drop for Scratch {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}

fn fixture(relative: &str) -> (String, Vec<u8>) {
    let path = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../../fixtures")
        .join(relative);
    let name = path.file_name().unwrap().to_string_lossy().into_owned();
    (name, fs::read(path).expect("read fixture"))
}

fn header_len(bytes: &[u8]) -> usize {
    uasset_parser::PackageSummary::parse(bytes)
        .unwrap()
        .total_header_size as usize
}

fn last_export_end(bytes: &[u8]) -> u64 {
    uasset_parser::Package::parse(bytes)
        .unwrap()
        .exports
        .iter()
        .map(|export| export.serial_offset.get() + export.serial_size)
        .max()
        .unwrap()
}

/// What a header-depth scan of the scratch project's `Content` gives: headers, and the codes of
/// packages it could not read.
fn header_scan(project_root: &Path) -> (Vec<SavedAssetHeader>, Vec<String>) {
    let request: Request = serde_json::from_value(serde_json::json!({
        "contract": { "name": "uasset-io", "version": { "major": 1, "minor": 24 } },
        "limits": {},
        "operation": {
            "kind": "scan",
            "depth": "header",
            "projectRoot": project_root.to_string_lossy()
        },
        "requestId": "leading-header-scan"
    }))
    .unwrap();
    let output = scan_with_cancellation(&request, &CancellationToken::new()).unwrap();
    let headers = output
        .entries
        .into_iter()
        .map(|entry| match entry {
            SavedAssetScanEntry::Header { header, .. } => header,
            SavedAssetScanEntry::Full { .. } => panic!("a header scan gave a full entry"),
        })
        .collect();
    let codes = output
        .diagnostics
        .into_iter()
        .map(|diagnostic| diagnostic.code)
        .collect();
    (headers, codes)
}

fn read(path: &Path, file_bytes: u64, package_path: Option<&str>) -> PackageHeaderOutcome {
    try_read(path, file_bytes, package_path).unwrap()
}

fn try_read(
    path: &Path,
    file_bytes: u64,
    package_path: Option<&str>,
) -> Result<PackageHeaderOutcome, Failure> {
    package_header_with_cancellation(
        &path.to_string_lossy(),
        file_bytes,
        package_path,
        &CancellationToken::new(),
    )
}

fn header(outcome: PackageHeaderOutcome) -> SavedAssetHeader {
    match outcome {
        PackageHeaderOutcome::Header { header } => header,
        other => panic!("expected a header, got {other:?}"),
    }
}

fn required(outcome: PackageHeaderOutcome) -> u64 {
    match outcome {
        PackageHeaderOutcome::NeedsBytes { required_bytes } => required_bytes,
        other => panic!("expected a request for more bytes, got {other:?}"),
    }
}

#[test]
fn the_header_bytes_and_the_package_size_give_the_header_a_scan_gives_the_whole_file() {
    for relative in PACKAGES {
        let (name, bytes) = fixture(relative);
        let scratch = Scratch::new("same");
        scratch.write(&format!("Content/{name}"), &bytes);
        let (scanned, failures) = header_scan(&scratch.0);
        assert_eq!(failures, Vec::<String>::new(), "{name}");
        let [scanned] = <[_; 1]>::try_from(scanned).unwrap();

        let leading = scratch.write("leading.bin", &bytes[..header_len(&bytes)]);
        let file_bytes = bytes.len() as u64;
        // Named as the scan named it, the header is the scan's to the byte.
        assert_eq!(
            header(read(&leading, file_bytes, Some(&scanned.path))),
            scanned,
            "{name}"
        );
        // Unnamed, only `path` differs: it is the file of leading bytes.
        let unnamed = header(read(&leading, file_bytes, None));
        assert_eq!(unnamed.path, leading.to_string_lossy());
        assert_eq!(
            SavedAssetHeader {
                path: scanned.path.clone(),
                ..unnamed
            },
            scanned,
            "{name}"
        );
        assert!(
            scanned
                .exports
                .iter()
                .all(|export| export.class_path.is_some())
        );

        // Bytes past the header are never read: overwriting them changes nothing.
        let mut garbage = bytes.clone();
        garbage[header_len(&bytes)..].fill(0xFF);
        let whole = scratch.write("whole.bin", &garbage);
        assert_eq!(
            header(read(&whole, file_bytes, Some(&scanned.path))),
            scanned,
            "{name}"
        );
    }
}

#[test]
fn a_file_truncated_on_disk_still_fails_as_malformed() {
    for relative in PACKAGES {
        let (name, bytes) = fixture(relative);
        let header_bytes = &bytes[..header_len(&bytes)];
        let scratch = Scratch::new("truncated");
        scratch.write(&format!("Content/{name}"), header_bytes);
        let (scanned, failures) = header_scan(&scratch.0);
        assert!(scanned.is_empty(), "{name}");
        assert_eq!(failures, ["asset_malformed_data"], "{name}");

        // The same bytes read as leading bytes of the whole package.
        let leading = scratch.write("leading.bin", header_bytes);
        header(read(&leading, bytes.len() as u64, None));
        // Read as leading bytes of a package that ends where they do, they fail the same way.
        let failure = try_read(&leading, header_bytes.len() as u64, None).unwrap_err();
        assert_eq!(
            failure.code, "malformed_data",
            "{name}: {}",
            failure.message
        );
    }
}

#[test]
fn too_few_leading_bytes_name_the_count_to_supply_next() {
    for relative in PACKAGES {
        let (name, bytes) = fixture(relative);
        let header_len = header_len(&bytes);
        let file_bytes = bytes.len() as u64;
        let scratch = Scratch::new("short");
        let leading = scratch.0.join("leading.bin");

        // Too few for the summary: the summary window, capped by the package's size.
        fs::write(&leading, &bytes[..100]).unwrap();
        assert_eq!(
            required(read(&leading, file_bytes, None)),
            file_bytes,
            "{name}"
        );
        assert_eq!(
            required(read(&leading, 300_000_000, None)),
            65_536,
            "{name}"
        );
        // A readable summary: exactly the header.
        fs::write(&leading, &bytes[..header_len - 1]).unwrap();
        assert_eq!(
            required(read(&leading, file_bytes, None)),
            header_len as u64,
            "{name}"
        );
        assert_eq!(
            required(read(&leading, 300_000_000, None)),
            header_len as u64,
            "{name}"
        );
        // Supplying that many reads the header.
        fs::write(&leading, &bytes[..header_len]).unwrap();
        header(read(&leading, file_bytes, None));
        header(read(&leading, 300_000_000, None));
        // An empty file asks for the summary window too.
        fs::write(&leading, b"").unwrap();
        assert_eq!(
            required(read(&leading, 300_000_000, None)),
            65_536,
            "{name}"
        );
    }
}

#[test]
fn a_declared_size_of_zero_or_below_the_bytes_is_invalid_input() {
    let (name, bytes) = fixture(PACKAGES[0]);
    let scratch = Scratch::new("invalid");
    let leading = scratch.write("leading.bin", &bytes);
    for file_bytes in [0, bytes.len() as u64 - 1] {
        let failure = try_read(&leading, file_bytes, None).unwrap_err();
        assert_eq!(failure.code, "invalid_request", "{name}: {file_bytes}");
        assert!(!failure.retry_safe);
    }
}

#[test]
fn a_declared_size_short_of_the_export_data_is_malformed() {
    for relative in PACKAGES {
        let (name, bytes) = fixture(relative);
        let scratch = Scratch::new("short-size");
        let leading = scratch.write("leading.bin", &bytes[..header_len(&bytes)]);
        let end = last_export_end(&bytes);
        let failure = try_read(&leading, end - 1, None).unwrap_err();
        assert_eq!(failure.code, "malformed_data", "{name}");
        assert!(
            failure.message.contains(&format!(
                "export span ends at {end}, outside file length {}",
                end - 1
            )),
            "{name}: {}",
            failure.message
        );
        header(read(&leading, end, None));
    }
}

#[test]
fn a_missing_file_of_leading_bytes_is_a_retryable_read_failure() {
    let scratch = Scratch::new("missing");
    let failure = try_read(&scratch.0.join("absent.bin"), 1024, None).unwrap_err();
    assert_eq!(failure.code, "io");
    assert!(failure.retry_safe);
}
