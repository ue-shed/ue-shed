//! The package summary's gatherable text table: the text Unreal's localization gather reads.
//!
//! The editor writes one `FGatherableTextData` per namespace/source pair when it saves a package,
//! with one site context per key that uses it. Gather reads this table instead of the exports, so
//! it is the authoritative list of localizable text a saved package contributes.

use std::fmt;

use crate::archive::{Guid, Reader};
use crate::package::{Package, PackageError, PackageErrorKind, PackageSummary};
use crate::version::PackageFlags;

// UE 5.7/5.8 ObjectVersion.h.
const UE4_PACKAGE_REQUIRES_LOCALIZATION_GATHER_FLAGGING: i32 = 320;
const UE4_SERIALIZE_TEXT_IN_PACKAGES: i32 = 459;
const UE4_DIALOGUE_WAVE_NAMESPACE_AND_CONTEXT_CHANGES: i32 = 486;
// EditorObjectVersion.h: GatheredTextEditorOnlyPackageLocId.
const EDITOR_OBJECT_VERSION: Guid = Guid {
    a: 0xE4B0_68ED,
    b: 0xF494_42E9,
    c: 0xA231_DA0B,
    d: 0x2E46_BB41,
};
const EDITOR_GATHERED_TEXT_EDITOR_ONLY_PACKAGE_LOC_ID: i32 = 20;
// FortniteMainBranchObjectVersions.inl: FixedLocalizationGatherForExternalActorPackage.
const FORTNITE_MAIN_VERSION: Guid = Guid {
    a: 0x601D_1886,
    b: 0xAC64_4F84,
    c: 0xAA16_D3DE,
    d: 0x0DEA_C7D6,
};
const FORTNITE_MAIN_FIXED_EXTERNAL_ACTOR_GATHER: i32 = 82;
const DIALOGUE_WAVE_CLASS: &str = "/Script/Engine.DialogueWave";
/// `FPackagePath::GetExternalActorsFolderName()`.
const EXTERNAL_ACTORS_FOLDER: &str = "__ExternalActors__";

/// Nested `FLocMetadataObject` values are validated and skipped, never retained.
const MAX_METADATA_DEPTH: usize = 32;

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct GatherableText {
    /// The namespace exactly as saved, which gather passes to the manifest unchanged.
    ///
    /// `FPropertyLocalizationDataGatherer::GatherTextInstance` has already stripped the package
    /// namespace marker from `FText` entries, and String Tables save their authored namespace,
    /// so a trailing `[...]` here is part of the namespace (UE 5.7 and 5.8).
    pub namespace: String,
    pub source: String,
    pub sites: Vec<GatherableTextSite>,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct GatherableTextSite {
    pub key: String,
    /// Unreal's site path, for example `/Game/Map.Map:Actor.Component.Text`.
    pub site_description: String,
    pub is_editor_only: bool,
    pub is_optional: bool,
}

/// Reads the gatherable text table from bytes that include the complete package header.
///
/// Returns `None` for packages saved before `VER_UE4_SERIALIZE_TEXT_IN_PACKAGES`, which have no
/// table, and an empty list when the table has no entries.
///
/// # Errors
///
/// Returns an error if the table lies outside `source` or any entry is malformed.
pub fn read_gatherable_text(
    source: &[u8],
    summary: &PackageSummary,
) -> Result<Option<Vec<GatherableText>>, PackageError> {
    let Some(table) = summary.gatherable_text_data else {
        return Ok(None);
    };
    // UE 5.8 GatherableTextData.cpp writes site DevNotes under the same gate as FText DevNotes.
    let site_dev_notes = summary.has_text_dev_notes();
    let mut reader = Reader::new(source);
    reader.seek(table.offset.get(), "GatherableTextData")?;
    let count = usize::try_from(table.count).map_err(|_| {
        PackageError::new(
            PackageErrorKind::ResourceLimit,
            Some(table.offset.get()),
            "GatherableTextData.Count",
            "count does not fit in usize",
        )
    })?;
    read_entries(&mut reader, count, site_dev_notes).map(Some)
}

fn read_entries(
    reader: &mut Reader<'_>,
    count: usize,
    site_dev_notes: bool,
) -> Result<Vec<GatherableText>, PackageError> {
    // Namespace, source string, metadata count and site count take four bytes each at minimum.
    let capacity =
        reader.checked_vec_capacity::<GatherableText>(count, 16, "GatherableTextData.Count")?;
    let mut entries = Vec::with_capacity(capacity);
    // Breadcrumbs render only when a read fails.
    for index in 0..count {
        let path = Indexed {
            parent: &"GatherableTextData",
            field: "",
            index,
        };
        let namespace = reader.read_fstring(&format_args!("{path}.NamespaceName"))?;
        let text_source = reader.read_fstring(&format_args!("{path}.SourceData.SourceString"))?;
        skip_metadata_object(
            reader,
            &Field {
                parent: &path,
                field: ".SourceData.SourceStringMetaData",
            },
            0,
        )?;
        let sites_path = Field {
            parent: &path,
            field: ".SourceSiteContexts",
        };
        let site_count = reader.read_count(&format_args!("{sites_path}.Count"))?;
        // Key, description, two bools and two metadata counts.
        let site_capacity = reader.checked_vec_capacity::<GatherableTextSite>(
            site_count,
            24,
            &format_args!("{sites_path}.Count"),
        )?;
        let mut sites = Vec::with_capacity(site_capacity);
        for site in 0..site_count {
            let path = Indexed {
                parent: &sites_path,
                field: "",
                index: site,
            };
            let key = reader.read_fstring(&format_args!("{path}.KeyName"))?;
            let site_description = reader.read_fstring(&format_args!("{path}.SiteDescription"))?;
            let is_editor_only = reader.read_bool(&format_args!("{path}.IsEditorOnly"))?;
            let is_optional = reader.read_bool(&format_args!("{path}.IsOptional"))?;
            if site_dev_notes {
                reader.skip_fstring(&format_args!("{path}.DevNotes"))?;
            }
            skip_metadata_object(
                reader,
                &Field {
                    parent: &path,
                    field: ".InfoMetaData",
                },
                0,
            )?;
            skip_metadata_object(
                reader,
                &Field {
                    parent: &path,
                    field: ".KeyMetaData",
                },
                0,
            )?;
            sites.push(GatherableTextSite {
                key,
                site_description,
                is_editor_only,
                is_optional,
            });
        }
        entries.push(GatherableText {
            namespace,
            source: text_source,
            sites,
        });
    }
    Ok(entries)
}

/// The `{parent}{field}` breadcrumb, formatted only when an error needs it.
struct Field<'a> {
    parent: &'a dyn fmt::Display,
    field: &'static str,
}

impl fmt::Display for Field<'_> {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(formatter, "{}{}", self.parent, self.field)
    }
}

/// The `{parent}{field}[{index}]` breadcrumb, formatted only when an error needs it.
struct Indexed<'a> {
    parent: &'a dyn fmt::Display,
    field: &'static str,
    index: usize,
}

impl fmt::Display for Indexed<'_> {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(formatter, "{}{}[{}]", self.parent, self.field, self.index)
    }
}

/// Whether Unreal's asset gather reads this package's saved gatherable text table.
///
/// Mirrors `UGatherTextFromAssetsCommandlet::CalculatePackageLocCacheState` (UE 5.7 and 5.8). When
/// it returns `false`, Unreal loads the package instead because the table may be missing or
/// stale, so the table is not evidence of what the package contributes. The project-level
/// `SkipGatherCache` setting is not modelled. `path` is the package path or file path; external
/// actor packages are recognized by their `__ExternalActors__` folder.
#[must_use]
pub fn gather_reads_table(package: &Package, path: &str) -> bool {
    let summary = &package.summary;
    let ue4 = summary.versions.ue4;
    let flagged = summary
        .versions
        .package_flags
        .contains(PackageFlags::REQUIRES_LOCALIZATION_GATHER);
    let version = |key: Guid| {
        summary
            .custom_versions
            .iter()
            .find(|version| version.key == key)
            .map(|version| version.version)
    };
    if ue4 < UE4_PACKAGE_REQUIRES_LOCALIZATION_GATHER_FLAGGING {
        return false;
    } else if ue4 < UE4_SERIALIZE_TEXT_IN_PACKAGES
        || version(EDITOR_OBJECT_VERSION)
            .is_none_or(|version| version < EDITOR_GATHERED_TEXT_EDITOR_ONLY_PACKAGE_LOC_ID)
    {
        if flagged {
            return false;
        }
    } else if ue4 < UE4_DIALOGUE_WAVE_NAMESPACE_AND_CONTEXT_CHANGES {
        if package.exports.iter().any(|export| {
            export
                .class_path
                .as_ref()
                .is_some_and(|class| class.as_str() == DIALOGUE_WAVE_CLASS)
        }) {
            return false;
        }
    } else if path.contains(EXTERNAL_ACTORS_FOLDER)
        && version(FORTNITE_MAIN_VERSION)
            .is_none_or(|version| version < FORTNITE_MAIN_FIXED_EXTERNAL_ACTOR_GATHER)
        && flagged
    {
        return false;
    }
    // A flagged package without a saved table must be loaded for gather.
    !(ue4 >= UE4_SERIALIZE_TEXT_IN_PACKAGES
        && summary
            .gatherable_text_data
            .is_none_or(|table| table.offset.get() == 0)
        && flagged)
}

/// `TextNamespaceUtil::StripPackageNamespace`: drops a trailing `[PACKAGE_NAMESPACE]` marker and,
/// like the engine's `StripPackageNamespaceInline`, trims the whitespace before it.
///
/// Apply it once, to a namespace serialized in an `FText`. Gather table namespaces are already
/// stripped, so stripping them again would remove an authored `[...]` suffix.
#[must_use]
pub fn strip_package_namespace(namespace: &str) -> &str {
    if !namespace.ends_with(']') {
        return namespace;
    }
    match namespace.rfind('[') {
        Some(open) => namespace[..open].trim_end(),
        None => namespace,
    }
}

// InternationalizationMetadata.cpp: `int32 ValueCount`, then `FString Key` and a typed value each.
fn skip_metadata_object(
    reader: &mut Reader<'_>,
    path: &dyn fmt::Display,
    depth: usize,
) -> Result<(), PackageError> {
    let count = reader.read_count(&format_args!("{path}.ValueCount"))?;
    // Key length and value type.
    reader.checked_vec_capacity::<()>(count, 8, &format_args!("{path}.ValueCount"))?;
    for index in 0..count {
        let path = Indexed {
            parent: path,
            field: ".Values",
            index,
        };
        reader.skip_fstring(&format_args!("{path}.Key"))?;
        skip_metadata_value(reader, &path, depth)?;
    }
    Ok(())
}

// ELocMetadataType is an int32: None, Boolean, String, Array, Object.
fn skip_metadata_value(
    reader: &mut Reader<'_>,
    path: &dyn fmt::Display,
    depth: usize,
) -> Result<(), PackageError> {
    let type_offset = reader.tell();
    let value_type = reader.read_i32(&format_args!("{path}.Type"))?;
    if matches!(value_type, 3 | 4) && depth >= MAX_METADATA_DEPTH {
        return Err(PackageError::new(
            PackageErrorKind::ResourceLimit,
            Some(type_offset),
            path,
            format!("localization metadata nests deeper than {MAX_METADATA_DEPTH}"),
        ));
    }
    match value_type {
        1 => {
            reader.read_bool(&format_args!("{path}.Value"))?;
        }
        2 => {
            reader.skip_fstring(&format_args!("{path}.Value"))?;
        }
        3 => {
            let count = reader.read_count(&format_args!("{path}.Value.Count"))?;
            reader.checked_vec_capacity::<()>(count, 4, &format_args!("{path}.Value.Count"))?;
            for index in 0..count {
                skip_metadata_value(
                    reader,
                    &Indexed {
                        parent: path,
                        field: ".Value",
                        index,
                    },
                    depth + 1,
                )?;
            }
        }
        4 => skip_metadata_object(
            reader,
            &Field {
                parent: path,
                field: ".Value",
            },
            depth + 1,
        )?,
        other => {
            return Err(PackageError::new(
                PackageErrorKind::MalformedData,
                Some(type_offset),
                format_args!("{path}.Type"),
                format!("unknown localization metadata type {other}"),
            ));
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::{
        EDITOR_OBJECT_VERSION, FORTNITE_MAIN_VERSION, gather_reads_table, read_entries,
        read_gatherable_text, strip_package_namespace,
    };
    use crate::archive::Reader;
    use crate::package::Package;
    use crate::package::{CustomVersion, ObjectPath};
    use crate::test_support::{push_fstring, push_i32};
    use crate::version::PackageFlags;

    fn fixture(path: &str) -> Vec<u8> {
        std::fs::read(format!(
            "{}/../../fixtures/{path}",
            env!("CARGO_MANIFEST_DIR")
        ))
        .expect("fixture package")
    }

    fn sites(path: &str) -> Vec<(String, String, String, bool)> {
        let bytes = fixture(path);
        let package = Package::parse(&bytes).expect("fixture parses");
        read_gatherable_text(&bytes, &package.summary)
            .expect("gather table reads")
            .expect("package has a gather table")
            .into_iter()
            .flat_map(|entry| {
                entry.sites.into_iter().map(move |site| {
                    (
                        entry.namespace.clone(),
                        site.key,
                        entry.source.clone(),
                        site.is_editor_only,
                    )
                })
            })
            .collect()
    }

    #[test]
    fn reads_the_text_unreal_gathers_from_a_saved_data_asset() {
        let sites = sites("unreal-project/Content/Fixture/Text/DA_TextOccurrences.uasset");
        let entry = |namespace: &str, key: &str, source: &str| {
            (
                namespace.to_owned(),
                key.to_owned(),
                source.to_owned(),
                false,
            )
        };
        // Both shared sites keep the one identity; the String Table reference is not gathered here.
        assert_eq!(
            sites,
            [
                entry("Fixture.Shared", "SharedHoldPrompt", "Hold to skip"),
                entry("Fixture.Shared", "SharedHoldPrompt", "Hold to skip"),
                entry("Fixture.Context", "ConfirmAction", "Confirm"),
                entry("Fixture.Context", "ConfirmDeletion", "Confirm"),
            ]
        );
    }

    /// The display names are saved as `Fixture.Enum [<package id>]`; Unreal stripped the marker
    /// once when it wrote the table, so the table namespace is read as saved.
    #[test]
    fn reads_the_gather_table_saved_for_enum_display_names() {
        let sites = sites("unreal-project/Content/Fixture/Text/E_TextDisplayNames.uasset");
        let entry = |key: &str, source: &str| {
            (
                "Fixture.Enum".to_owned(),
                key.to_owned(),
                source.to_owned(),
                false,
            )
        };
        assert_eq!(
            sites,
            [
                entry("CommonItem", "Common Item"),
                entry("RareItem", "Rare Item")
            ]
        );
    }

    #[test]
    fn reads_gather_tables_saved_by_legacy_engines() {
        for engine in ["4.27", "5.3"] {
            let sites = sites(&format!(
                "legacy-unreal-project/Generated/{engine}/Content/Legacy/DT_LegacyText.uasset"
            ));
            assert_eq!(sites.len(), 8, "{engine}");
            assert!(
                sites
                    .iter()
                    .all(|site| site.0 == "LegacyFixture" && !site.3)
            );
        }
    }

    fn push_metadata_string(bytes: &mut Vec<u8>, key: &str, value: &str) {
        push_fstring(bytes, key);
        push_i32(bytes, 2);
        push_fstring(bytes, value);
    }

    /// One entry with two sites; every metadata value type, nested, and optional 5.8 DevNotes.
    /// Gather saved the namespace already stripped, so `[Tutorial]` is authored text.
    fn synthetic_table(dev_notes: bool) -> Vec<u8> {
        let mut bytes = Vec::new();
        push_fstring(&mut bytes, "UI [Tutorial]");
        push_fstring(&mut bytes, "Start");
        push_i32(&mut bytes, 1);
        push_metadata_string(&mut bytes, "Context", "Menu");
        push_i32(&mut bytes, 2);
        for (key, editor_only) in [("Start", false), ("StartTooltip", true)] {
            push_fstring(&mut bytes, key);
            push_fstring(&mut bytes, "/Game/Menu.Menu:Start");
            push_i32(&mut bytes, i32::from(editor_only));
            push_i32(&mut bytes, 0);
            if dev_notes {
                push_fstring(&mut bytes, "Shown on the title screen");
            }
            push_i32(&mut bytes, 3); // InfoMetaData
            push_fstring(&mut bytes, "Flag");
            push_i32(&mut bytes, 1);
            push_i32(&mut bytes, 1);
            push_fstring(&mut bytes, "List");
            push_i32(&mut bytes, 3);
            push_i32(&mut bytes, 2);
            push_i32(&mut bytes, 2);
            push_fstring(&mut bytes, "a");
            push_i32(&mut bytes, 1);
            push_i32(&mut bytes, 0);
            push_fstring(&mut bytes, "Object");
            push_i32(&mut bytes, 4);
            push_i32(&mut bytes, 1);
            push_metadata_string(&mut bytes, "Inner", "b");
            push_i32(&mut bytes, 0); // KeyMetaData
        }
        bytes
    }

    #[test]
    fn skips_every_metadata_type_and_site_dev_notes() {
        for dev_notes in [false, true] {
            let bytes = synthetic_table(dev_notes);
            let mut reader = Reader::new(&bytes);
            let entries = read_entries(&mut reader, 1, dev_notes).expect("table reads");
            assert_eq!(reader.tell(), bytes.len() as u64, "consumed whole table");
            assert_eq!(entries[0].source, "Start");
            let sites: Vec<_> = entries[0]
                .sites
                .iter()
                .map(|site| (site.key.as_str(), site.is_editor_only))
                .collect();
            assert_eq!(sites, [("Start", false), ("StartTooltip", true)]);
        }
    }

    /// Regression: the table namespace was stripped a second time, turning `UI [Tutorial]` into
    /// `UI` and reporting fully decoded text as unread.
    #[test]
    fn keeps_the_saved_namespace_verbatim() {
        let bytes = synthetic_table(false);
        let entries = read_entries(&mut Reader::new(&bytes), 1, false).expect("table reads");
        assert_eq!(entries[0].namespace, "UI [Tutorial]");
    }

    #[test]
    fn rejects_unknown_metadata_types_and_runaway_nesting() {
        let mut bytes = Vec::new();
        push_fstring(&mut bytes, "UI");
        push_fstring(&mut bytes, "Start");
        push_i32(&mut bytes, 1);
        push_fstring(&mut bytes, "Bad");
        push_i32(&mut bytes, 9);
        let error = read_entries(&mut Reader::new(&bytes), 1, false).unwrap_err();
        assert_eq!(
            error.path(),
            "GatherableTextData[0].SourceData.SourceStringMetaData.Values[0].Type"
        );
        assert_eq!(error.detail(), "unknown localization metadata type 9");

        let mut bytes = Vec::new();
        push_fstring(&mut bytes, "UI");
        push_fstring(&mut bytes, "Start");
        for _ in 0..40 {
            push_i32(&mut bytes, 1);
            push_fstring(&mut bytes, "Nested");
            push_i32(&mut bytes, 4);
        }
        push_i32(&mut bytes, 0);
        let error = read_entries(&mut Reader::new(&bytes), 1, false).unwrap_err();
        assert_eq!(
            error.path(),
            format!(
                "GatherableTextData[0].SourceData.SourceStringMetaData.Values[0]{}",
                ".Value.Values[0]".repeat(32)
            )
        );
    }

    #[test]
    fn strips_only_a_trailing_package_namespace_marker() {
        assert_eq!(
            strip_package_namespace("[FB116F38B2A310748E8E2BF32F64A50B]"),
            ""
        );
        assert_eq!(strip_package_namespace("UI [FB116F38]"), "UI");
        assert_eq!(strip_package_namespace("UI"), "UI");
        assert_eq!(strip_package_namespace("[Open"), "[Open");
    }

    /// A flagged UE 5.7 package with a table, then each condition under which Unreal's
    /// `CalculatePackageLocCacheState` stops trusting the table and loads the package instead.
    #[test]
    fn trusts_the_table_only_when_unreal_gather_would() {
        let bytes = fixture("unreal-project/Content/Fixture/Text/DA_TextOccurrences.uasset");
        let saved = Package::parse(&bytes).expect("fixture parses");
        let flagged = |package: &mut Package, flagged: bool| {
            let bits = package.summary.versions.package_flags.bits();
            package.summary.versions.package_flags = PackageFlags::from_bits(if flagged {
                bits | PackageFlags::REQUIRES_LOCALIZATION_GATHER
            } else {
                bits & !PackageFlags::REQUIRES_LOCALIZATION_GATHER
            });
        };
        let set_version = |package: &mut Package, key, version| {
            package
                .summary
                .custom_versions
                .retain(|custom| custom.key != key);
            package.summary.custom_versions.push(CustomVersion {
                key,
                version,
                friendly_name: None,
            });
        };
        let mut package = saved.clone();
        flagged(&mut package, true);
        assert!(gather_reads_table(&package, "Content/Text/DA.uasset"));

        // Saved before gather flagging existed.
        let mut old = package.clone();
        old.summary.versions.ue4 = 319;
        assert!(!gather_reads_table(&old, "Content/Text/DA.uasset"));

        // Table predates GatheredTextEditorOnlyPackageLocId: untrusted only when flagged.
        let mut stale = package.clone();
        set_version(&mut stale, EDITOR_OBJECT_VERSION, 19);
        assert!(!gather_reads_table(&stale, "Content/Text/DA.uasset"));
        flagged(&mut stale, false);
        assert!(gather_reads_table(&stale, "Content/Text/DA.uasset"));

        // External actor packages saved before the external actor gather fix.
        let actor = "Content/__ExternalActors__/Maps/Main/0/AB/XYZ.uasset";
        let mut external = package.clone();
        set_version(&mut external, FORTNITE_MAIN_VERSION, 81);
        assert!(!gather_reads_table(&external, actor));
        assert!(gather_reads_table(&external, "Content/Text/DA.uasset"));
        set_version(&mut external, FORTNITE_MAIN_VERSION, 82);
        assert!(gather_reads_table(&external, actor));

        // Dialogue waves saved before their namespace and context change.
        let mut dialogue = package.clone();
        dialogue.summary.versions.ue4 = 485;
        assert!(gather_reads_table(&dialogue, "Content/Text/DA.uasset"));
        dialogue.exports[0].class_path = Some(ObjectPath::new("/Script/Engine.DialogueWave"));
        assert!(!gather_reads_table(&dialogue, "Content/Text/DA.uasset"));

        // Flagged for gather but saved without a table.
        let mut missing = package.clone();
        missing.summary.gatherable_text_data = None;
        assert!(!gather_reads_table(&missing, "Content/Text/DA.uasset"));
        flagged(&mut missing, false);
        assert!(gather_reads_table(&missing, "Content/Text/DA.uasset"));
    }
}
