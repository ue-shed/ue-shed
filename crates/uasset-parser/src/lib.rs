//! Read-only parser foundation for classic Unreal Engine asset packages.
//!
//! Dependencies flow from asset adapters down toward the archive layer:
//! `asset -> codec/property -> package -> archive/version`.

pub mod archive;
pub mod asset;
pub mod codec;
mod convert;
pub mod gatherable_text;
pub mod metadata;
pub mod native;
pub mod package;
pub mod property;
pub mod schema;
pub mod version;

#[cfg(test)]
mod test_support;

pub use archive::{ArchiveError, ArchiveErrorKind, ArchiveLimits, Reader, Span};
pub use asset::PropertyDecodeFilter;
pub use package::{Package, PackageError, PackageErrorKind, PackageSummary};
