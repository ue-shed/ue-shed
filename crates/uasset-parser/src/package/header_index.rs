//! A package header read for indexing: every table checked, almost nothing copied.

use std::borrow::Cow;

use super::{
    ChainsOnly, Export, ExportLinks, Import, ImportLinks, IndexPathResolver, PackageError,
    PackageErrorKind, PackageIndex, PackageSummary, normalize_object_path_string,
    read_export_map_into, read_import_map_into, read_name_map, resolve_every_index,
    resolve_name_ref_cow, summary_fits, walk_soft_object_path_list,
};
use crate::archive::{NameRef, Reader};
use crate::dependencies::{HeaderTables, PackageDependency, asset_registry_dependencies};

/// What an index reads of an import: the links its object path and package are made of.
#[derive(Clone, Copy, Debug)]
pub(crate) struct IndexImport {
    outer_index: PackageIndex,
    object_name: NameRef,
    package_name: Option<NameRef>,
}

/// What an index reads of an export: its links and its class.
#[derive(Clone, Copy, Debug)]
pub(crate) struct IndexExport {
    class_index: PackageIndex,
    outer_index: PackageIndex,
    object_name: NameRef,
}

impl ImportLinks for IndexImport {
    fn outer_index(&self) -> PackageIndex {
        self.outer_index
    }
    fn object_name(&self) -> NameRef {
        self.object_name
    }
    fn package_name(&self) -> Option<NameRef> {
        self.package_name
    }
}

impl ExportLinks for IndexExport {
    fn outer_index(&self) -> PackageIndex {
        self.outer_index
    }
    fn object_name(&self) -> NameRef {
        self.object_name
    }
    fn class_index(&self) -> PackageIndex {
        self.class_index
    }
}

/// A package header as an index reads it: the summary, the name map, and the import and export
/// maps, without the object paths [`super::Package`] builds for every import and export.
///
/// It accepts and rejects exactly the headers [`super::Package::parse_header`] does: it reads the
/// same tables (soft object paths included) and checks every outer chain the same way. Names
/// borrow the header bytes when they are ASCII, imports and exports keep only the links an index
/// reads (a few words each, not the full entries), and only export class paths are ever built, on
/// request
/// ([`HeaderIndex::export_class_paths`]).
#[derive(Debug)]
pub struct HeaderIndex<'a> {
    pub summary: PackageSummary,
    names: Vec<Cow<'a, str>>,
    imports: Vec<IndexImport>,
    exports: Vec<IndexExport>,
}

impl<'a> HeaderIndex<'a> {
    /// Reads a header as [`super::Package::parse_header`] does.
    ///
    /// # Errors
    ///
    /// Returns the error [`super::Package::parse_header`] would for the same bytes.
    pub fn parse(source: &'a [u8], file_len: usize) -> Result<Self, PackageError> {
        let summary = PackageSummary::parse_with_file_len(source, file_len)?;
        Self::parse_with_summary(source, file_len, summary)
    }

    /// [`HeaderIndex::parse`] with the summary a caller already read from a prefix of `source`
    /// (with the same `file_len`), so the summary is parsed once.
    ///
    /// # Errors
    ///
    /// Returns the error [`super::Package::parse_header`] would for the same bytes.
    pub fn parse_with_summary(
        source: &'a [u8],
        file_len: usize,
        summary: PackageSummary,
    ) -> Result<Self, PackageError> {
        summary_fits(&summary, source)?;
        let mut reader = Reader::new(source);
        let names = read_name_map(&mut reader, &summary, |name| name)?;
        // Nothing reads the table here, but a malformed one fails the header as it does in full.
        walk_soft_object_path_list(source, &summary, |_| {})?;
        let mut imports = Vec::new();
        read_import_map_into(
            &mut reader,
            &summary,
            names.len(),
            &mut imports,
            |import: Import| IndexImport {
                outer_index: import.outer_index,
                object_name: import.object_name,
                package_name: import.package_name,
            },
        )?;
        let mut exports = Vec::new();
        read_export_map_into(
            &mut reader,
            &summary,
            names.len(),
            file_len,
            &mut exports,
            |export: Export| IndexExport {
                class_index: export.class_index,
                outer_index: export.outer_index,
                object_name: export.object_name,
            },
        )?;
        resolve_every_index(
            &mut IndexPathResolver::with_builder(ChainsOnly, &imports, &exports),
            |_, _| Ok(()),
        )?;
        Ok(Self {
            summary,
            names,
            imports,
            exports,
        })
    }

    /// The name map, in order.
    #[must_use]
    pub fn names(&self) -> &[Cow<'a, str>] {
        &self.names
    }

    /// The class path of every export that has a class, as [`super::Export::class_path`] holds
    /// it, once per distinct class index, in class-index order. Only these chains are built.
    ///
    /// # Errors
    ///
    /// Never for a header [`HeaderIndex::parse`] accepted: its chains are already checked.
    pub fn export_class_paths(&self) -> Result<Vec<String>, PackageError> {
        let mut classes = self
            .exports
            .iter()
            .map(|export| export.class_index)
            .filter(|index| *index != PackageIndex::Null)
            .collect::<Vec<_>>();
        classes.sort_unstable();
        classes.dedup();
        classes
            .into_iter()
            .map(|class_index| {
                let mut path = String::new();
                self.write_path(class_index, &mut path)?;
                Ok(normalize_object_path_string(path))
            })
            .collect()
    }

    /// Writes the object path of a non-null `index` to `out` (replacing what it held), as
    /// [`super::Package`] builds it for the import or export there: its outer's path, then its
    /// own name. An accepted header's outer chains are in range, acyclic and within the depth
    /// limit, so this recursion is bounded.
    fn write_path(&self, index: PackageIndex, out: &mut String) -> Result<(), PackageError> {
        let name = |name| resolve_name_ref_cow(&self.names, name);
        let missing = || {
            PackageError::new(
                PackageErrorKind::MalformedData,
                None,
                "Exports.ClassIndex",
                "export class index did not resolve to an object path",
            )
        };
        match index {
            PackageIndex::Null => return Err(missing()),
            PackageIndex::Import(slot) => {
                let import = self.imports.get(slot as usize).ok_or_else(missing)?;
                let object_name = name(import.object_name)?;
                match import.outer_index {
                    PackageIndex::Null => {
                        out.clear();
                        if object_name == "None" {
                            // An outermost `None` import has no path.
                        } else if let Some(package) = import.package_name {
                            out.push('/');
                            out.push_str(&name(package)?);
                            out.push('.');
                            out.push_str(&object_name);
                        } else {
                            if !object_name.starts_with('/') {
                                out.push('/');
                            }
                            out.push_str(&object_name);
                        }
                    }
                    outer => {
                        self.write_path(outer, out)?;
                        if out.is_empty() || out == "/None" {
                            out.clear();
                        } else {
                            out.push('.');
                        }
                        out.push_str(&object_name);
                    }
                }
            }
            PackageIndex::Export(slot) => {
                let export = self.exports.get(slot as usize).ok_or_else(missing)?;
                match export.outer_index {
                    PackageIndex::Null => {
                        out.clear();
                        out.push_str(&self.summary.package_name);
                    }
                    outer => self.write_path(outer, out)?,
                }
                out.push('.');
                out.push_str(&name(export.object_name)?);
            }
        }
        Ok(())
    }

    /// [`super::Package::asset_registry_dependencies`] for this header.
    ///
    /// # Errors
    ///
    /// As [`super::Package::asset_registry_dependencies`].
    pub fn asset_registry_dependencies(
        &self,
        source: &[u8],
        package_name: &str,
    ) -> Result<Vec<PackageDependency>, PackageError> {
        asset_registry_dependencies(self, source, package_name)
    }
}

impl HeaderTables for HeaderIndex<'_> {
    type Import = IndexImport;
    fn summary(&self) -> &PackageSummary {
        &self.summary
    }
    fn imports(&self) -> &[IndexImport] {
        &self.imports
    }
    fn name_count(&self) -> usize {
        self.names.len()
    }
    fn name_text(&self, index: usize) -> &str {
        &self.names[index]
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::package::Package;

    fn fixtures() -> Vec<(std::path::PathBuf, Vec<u8>)> {
        let root = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../../fixtures");
        let mut pending = vec![root];
        let mut found = Vec::new();
        while let Some(directory) = pending.pop() {
            let Ok(entries) = std::fs::read_dir(&directory) else {
                continue;
            };
            for entry in entries.flatten() {
                let path = entry.path();
                if path.is_dir() {
                    pending.push(path);
                } else if path
                    .extension()
                    .and_then(|value| value.to_str())
                    .is_some_and(|value| {
                        value.eq_ignore_ascii_case("uasset") || value.eq_ignore_ascii_case("umap")
                    })
                {
                    found.push((path.clone(), std::fs::read(&path).unwrap()));
                }
            }
        }
        found.sort();
        found
    }

    /// The index read and the full read agree on every fixture package: the same acceptance, and
    /// the same names, class paths and dependencies, from whole files and from header prefixes.
    #[test]
    fn header_index_matches_the_full_header_parse_on_every_fixture() {
        let fixtures = fixtures();
        assert!(fixtures.len() > 20, "found {} fixtures", fixtures.len());
        let mut parsed = 0;
        for (path, bytes) in &fixtures {
            let header_len = PackageSummary::parse(bytes)
                .ok()
                .map(|summary| summary.total_header_size as usize)
                .filter(|len| *len <= bytes.len());
            let mut sources = vec![bytes.as_slice()];
            if let Some(len) = header_len {
                sources.push(&bytes[..len]);
            }
            for source in sources {
                let full = Package::parse_header(source, bytes.len());
                let index = HeaderIndex::parse(source, bytes.len());
                match (&full, &index) {
                    (Ok(full), Ok(index)) => {
                        parsed += 1;
                        assert_eq!(full.summary, index.summary, "{}", path.display());
                        assert_eq!(
                            full.names,
                            index
                                .names()
                                .iter()
                                .map(|name| name.to_string())
                                .collect::<Vec<_>>()
                        );
                        let mut expected = full
                            .exports
                            .iter()
                            .filter_map(|export| export.class_path.clone())
                            .map(|path| path.into_string())
                            .collect::<Vec<_>>();
                        expected.sort();
                        expected.dedup();
                        let mut actual = index.export_class_paths().unwrap();
                        actual.sort();
                        actual.dedup();
                        assert_eq!(expected, actual, "{}", path.display());
                        for package_name in ["/Game/Fixture/Some/Asset", &full.summary.package_name]
                        {
                            assert_eq!(
                                full.asset_registry_dependencies(source, package_name)
                                    .map_err(|error| error.kind()),
                                index
                                    .asset_registry_dependencies(source, package_name)
                                    .map_err(|error| error.kind()),
                                "{}",
                                path.display()
                            );
                        }
                    }
                    (Err(full), Err(index)) => assert_eq!(full.kind(), index.kind()),
                    _ => panic!(
                        "{}: full {:?}, index {:?}",
                        path.display(),
                        full.as_ref().err(),
                        index.as_ref().err()
                    ),
                }
            }
        }
        assert!(parsed > 20);
    }

    /// Truncated headers fail both reads the same way.
    #[test]
    fn header_index_rejects_every_truncation_the_full_parse_rejects() {
        for (path, bytes) in fixtures().iter().take(12) {
            let Ok(summary) = PackageSummary::parse(bytes) else {
                continue;
            };
            let header_len = (summary.total_header_size as usize).min(bytes.len());
            for len in (0..header_len).step_by(97) {
                let source = &bytes[..len];
                let full = Package::parse_header(source, bytes.len()).map(|_| ());
                let index = HeaderIndex::parse(source, bytes.len()).map(|_| ());
                assert_eq!(
                    full.map_err(|error| error.kind()),
                    index.map_err(|error| error.kind()),
                    "{} at {len}",
                    path.display()
                );
                // A summary read from the whole file and reused for a shorter header must
                // fail exactly when reading that header in full fails.
                let reused = HeaderIndex::parse_with_summary(source, bytes.len(), summary.clone())
                    .map(|_| ());
                assert_eq!(
                    Package::parse_header(source, bytes.len()).is_ok(),
                    reused.is_ok(),
                    "{} at {len}",
                    path.display()
                );
            }
        }
    }
}
