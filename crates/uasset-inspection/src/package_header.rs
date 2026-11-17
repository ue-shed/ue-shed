//! Portable saved-header evidence; no payload decode or filesystem authority.
use serde::{Deserialize, Serialize};
use uasset_parser::PackageSummary;
use uasset_parser::package::{Package, PackageError, PackageErrorKind};

/// The leading bytes a package summary must parse within; a summary that does not is malformed.
pub const MAX_SUMMARY_BYTES: usize = 64 * 1024;
/// The largest serialized header (`total_header_size`) a header read accepts.
pub const MAX_HEADER_BYTES: usize = 64 * 1024 * 1024;

/// A package header read from the package's leading bytes.
#[derive(Debug)]
pub enum LeadingHeader {
    /// The header parsed, with every export span checked against the declared file length.
    Parsed(Box<Package>),
    /// The bytes end before the header does. Supply at least this many leading bytes and read
    /// again: the whole header once the summary is readable, otherwise the summary window
    /// ([`MAX_SUMMARY_BYTES`], or the whole file when it is smaller). Always more than supplied.
    NeedsBytes(u64),
}

/// Why a header could not be read from a package's leading bytes.
#[derive(Debug)]
pub enum LeadingHeaderError {
    /// The declared file length is zero or smaller than the bytes supplied.
    InvalidFileLength { supplied: u64, file_len: u64 },
    /// The header is larger than [`MAX_HEADER_BYTES`], or the file length is not addressable here.
    ResourceLimit,
    /// The parser refused the summary or header.
    Package(PackageError),
}

impl LeadingHeaderError {
    /// The failure code a single-package read reports, as for an inspection.
    #[must_use]
    pub fn code(&self) -> &'static str {
        match self {
            Self::InvalidFileLength { .. } => "invalid_request",
            Self::ResourceLimit => "resource_limit",
            Self::Package(error) => match error.kind() {
                PackageErrorKind::MalformedData => "malformed_data",
                PackageErrorKind::ResourceLimit => "resource_limit",
                PackageErrorKind::UnsupportedFormat => "unsupported_format",
                PackageErrorKind::UnsupportedVersion => "unsupported_version",
                PackageErrorKind::UnsupportedCapability => "unsupported_capability",
            },
        }
    }
}

impl std::fmt::Display for LeadingHeaderError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::InvalidFileLength { supplied, file_len } => write!(
                formatter,
                "the package's declared size ({file_len} bytes) must be positive and at least \
                 the {supplied} leading bytes supplied"
            ),
            Self::ResourceLimit => write!(
                formatter,
                "the package header is larger than the {MAX_HEADER_BYTES}-byte header limit"
            ),
            Self::Package(error) => write!(formatter, "{error}"),
        }
    }
}

/// Reads a package's header from its first bytes and the length of the whole file, such as a
/// version-control server reports, without the rest of the file.
///
/// This is the read a header scan makes of a file on disk, with the file length declared rather
/// than measured: the summary and header must parse from `leading`, and every export span must
/// end within `file_len`, exactly as when the whole file is present. Bytes past the header are
/// never read.
///
/// # Errors
///
/// Returns [`LeadingHeaderError::InvalidFileLength`] when `file_len` is zero or smaller than
/// `leading`, and a resource-limit or parser error for a header the reader refuses.
pub fn parse_leading_header(
    leading: &[u8],
    file_len: u64,
) -> Result<LeadingHeader, LeadingHeaderError> {
    let supplied = u64::try_from(leading.len()).map_err(|_| LeadingHeaderError::ResourceLimit)?;
    if file_len == 0 || supplied > file_len {
        return Err(LeadingHeaderError::InvalidFileLength { supplied, file_len });
    }
    let file_bytes = usize::try_from(file_len).map_err(|_| LeadingHeaderError::ResourceLimit)?;
    // A disk read grows its summary probe up to this window before it calls a summary malformed.
    let summary_window = MAX_SUMMARY_BYTES.min(file_bytes);
    let summary_bytes = &leading[..leading.len().min(summary_window)];
    let summary = match PackageSummary::parse_with_file_len(summary_bytes, file_bytes) {
        Ok(summary) => summary,
        Err(error)
            if error.kind() == PackageErrorKind::MalformedData
                && summary_bytes.len() < summary_window =>
        {
            return Ok(LeadingHeader::NeedsBytes(byte_count(summary_window)?));
        }
        Err(error) => return Err(LeadingHeaderError::Package(error)),
    };
    let header_len = usize::try_from(summary.total_header_size)
        .map_err(|_| LeadingHeaderError::ResourceLimit)?;
    if header_len > MAX_HEADER_BYTES {
        return Err(LeadingHeaderError::ResourceLimit);
    }
    let Some(header) = leading.get(..header_len) else {
        return Ok(LeadingHeader::NeedsBytes(byte_count(header_len)?));
    };
    Package::parse_header(header, file_bytes)
        .map(|package| LeadingHeader::Parsed(Box::new(package)))
        .map_err(LeadingHeaderError::Package)
}

fn byte_count(len: usize) -> Result<u64, LeadingHeaderError> {
    u64::try_from(len).map_err(|_| LeadingHeaderError::ResourceLimit)
}

#[derive(Clone, Debug, Default, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PackageHeaderData {
    pub package_flags: u32,
    pub gatherable_text_data_count: u32,
    pub gatherable_text_data_offset: u64,
    /// Probe the complete name map, rather than the bounded Project Index name sample.
    pub has_text_property: bool,
}

impl PackageHeaderData {
    #[must_use]
    pub fn from_package(package: &Package) -> Self {
        let table = package.summary.gatherable_text_data;
        Self {
            package_flags: package.summary.versions.package_flags.bits(),
            gatherable_text_data_count: table.map_or(0, |table| table.count),
            gatherable_text_data_offset: table.map_or(0, |table| table.offset.get()),
            has_text_property: package.names.iter().any(|name| name == "TextProperty"),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Current and legacy packages whose last export's data ends past their header.
    const PACKAGES: &[(&str, &[u8])] = &[
        (
            "IA_Jump",
            include_bytes!("../../../fixtures/unreal-project/Content/Fixture/Input/IA_Jump.uasset"),
        ),
        (
            "DT_Scalars",
            include_bytes!(
                "../../../fixtures/unreal-project/Content/Fixture/Authoring/DT_Scalars.uasset"
            ),
        ),
        (
            "4.27 DT_LegacyText",
            include_bytes!(
                "../../../fixtures/legacy-unreal-project/Generated/4.27/Content/Legacy/DT_LegacyText.uasset"
            ),
        ),
        (
            "5.3 ST_LegacyText",
            include_bytes!(
                "../../../fixtures/legacy-unreal-project/Generated/5.3/Content/Legacy/ST_LegacyText.uasset"
            ),
        ),
    ];

    fn header_len(bytes: &[u8]) -> usize {
        PackageSummary::parse(bytes).unwrap().total_header_size as usize
    }

    fn last_export_end(bytes: &[u8]) -> usize {
        let package = Package::parse(bytes).unwrap();
        package
            .exports
            .iter()
            .map(|export| (export.serial_offset.get() + export.serial_size) as usize)
            .max()
            .unwrap()
    }

    fn parsed(result: Result<LeadingHeader, LeadingHeaderError>) -> Package {
        match result {
            Ok(LeadingHeader::Parsed(package)) => *package,
            other => panic!("expected a parsed header, got {other:?}"),
        }
    }

    fn needs(result: Result<LeadingHeader, LeadingHeaderError>) -> u64 {
        match result {
            Ok(LeadingHeader::NeedsBytes(required)) => required,
            other => panic!("expected a request for more bytes, got {other:?}"),
        }
    }

    #[test]
    fn the_header_bytes_and_the_file_length_read_what_the_whole_file_does() {
        for (name, bytes) in PACKAGES {
            let header_len = header_len(bytes);
            let file_len = bytes.len() as u64;
            assert!(last_export_end(bytes) > header_len, "{name}");
            // As a file, the header alone is truncated: its last export's data is missing.
            assert!(Package::parse(&bytes[..header_len]).is_err(), "{name}");

            let whole = Package::parse(bytes).unwrap();
            assert_eq!(
                parsed(parse_leading_header(&bytes[..header_len], file_len)),
                whole,
                "{name}"
            );
            // Bytes past the header change nothing; a whole file is also valid leading bytes.
            for supplied in [header_len + 1, bytes.len()] {
                assert_eq!(
                    parsed(parse_leading_header(&bytes[..supplied], file_len)),
                    whole,
                    "{name} with {supplied} bytes"
                );
            }
        }
    }

    #[test]
    fn too_few_bytes_ask_for_the_summary_window_then_the_exact_header() {
        for (name, bytes) in PACKAGES {
            let header_len = header_len(bytes);
            let file_len = bytes.len() as u64;
            // Too short for the summary: the summary window, which a smaller file caps.
            for supplied in [0, 16] {
                assert_eq!(
                    needs(parse_leading_header(&bytes[..supplied], file_len)),
                    file_len.min(MAX_SUMMARY_BYTES as u64),
                    "{name}"
                );
                assert_eq!(
                    needs(parse_leading_header(&bytes[..supplied], 300_000_000)),
                    MAX_SUMMARY_BYTES as u64,
                    "{name}"
                );
            }
            // A readable summary: exactly the header, wherever the file ends.
            for declared in [file_len, 300_000_000] {
                assert_eq!(
                    needs(parse_leading_header(&bytes[..header_len - 1], declared)),
                    header_len as u64,
                    "{name}"
                );
            }
        }
    }

    #[test]
    fn a_host_that_supplies_what_is_asked_reaches_the_header_within_three_reads() {
        for (name, bytes) in PACKAGES {
            for start in [0, 1, 100, header_len(bytes) - 1] {
                let mut supplied = start;
                let mut reads = 0;
                loop {
                    reads += 1;
                    match parse_leading_header(&bytes[..supplied], bytes.len() as u64) {
                        Ok(LeadingHeader::Parsed(_)) => break,
                        Ok(LeadingHeader::NeedsBytes(required)) => {
                            assert!(required as usize > supplied, "{name} from {start}");
                            supplied = required as usize;
                        }
                        Err(error) => panic!("{name} from {start}: {error:?}"),
                    }
                }
                assert!(reads <= 3, "{name} from {start} took {reads} reads");
            }
        }
    }

    #[test]
    fn a_file_length_of_zero_or_below_the_bytes_is_invalid_input() {
        let (_, bytes) = PACKAGES[0];
        let supplied = bytes.len() as u64;
        for file_len in [0, supplied - 1] {
            assert!(
                matches!(
                    parse_leading_header(bytes, file_len),
                    Err(LeadingHeaderError::InvalidFileLength { supplied: s, file_len: f })
                        if s == supplied && f == file_len
                ),
                "{file_len}"
            );
        }
        assert!(matches!(
            parse_leading_header(&[], 0),
            Err(LeadingHeaderError::InvalidFileLength { .. })
        ));
    }

    #[test]
    fn a_file_length_short_of_the_data_is_malformed_as_a_short_file_is() {
        for (name, bytes) in PACKAGES {
            let header_len = header_len(bytes);
            let end = last_export_end(bytes);
            // The check a truncated file fails: its last export's data ends past the file.
            let short = Package::parse(&bytes[..end - 1]).unwrap_err();
            assert_eq!(short.kind(), PackageErrorKind::MalformedData, "{name}");
            let declared_short = parse_leading_header(&bytes[..header_len], end as u64 - 1);
            assert!(
                matches!(
                    &declared_short,
                    Err(LeadingHeaderError::Package(error))
                        if error.kind() == PackageErrorKind::MalformedData
                            && error.detail() == short.detail()
                ),
                "{name}: {declared_short:?}"
            );
            parsed(parse_leading_header(&bytes[..header_len], end as u64));
            // A file shorter than its own header.
            let short_header = (header_len - 1) as u64;
            assert!(
                matches!(
                    parse_leading_header(&bytes[..header_len - 1], short_header),
                    Err(LeadingHeaderError::Package(error))
                        if error.kind() == PackageErrorKind::MalformedData
                ),
                "{name}"
            );
        }
    }

    #[test]
    fn saved_summary_evidence_covers_legacy_and_current_packages() {
        for bytes in [
            include_bytes!("../../../fixtures/legacy-unreal-project/Generated/4.27/Content/Legacy/ST_LegacyText.uasset").as_slice(),
            include_bytes!("../../../fixtures/legacy-unreal-project/Generated/5.3/Content/Legacy/ST_LegacyText.uasset").as_slice(),
            include_bytes!("../../../fixtures/unreal-project/Content/Fixture/Text/ST_Game.uasset").as_slice(),
        ] {
            let package = Package::parse(bytes).unwrap();
            let data = PackageHeaderData::from_package(&package);
            assert!(!data.has_text_property);
            assert!(data.gatherable_text_data_count > 0);
            assert!(data.gatherable_text_data_offset > 0);
            assert_eq!(data.package_flags, package.summary.versions.package_flags.bits());
        }
    }
}
