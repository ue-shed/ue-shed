//! UE 5.7 package metadata section. Header-only package reads never visit this section.
use crate::archive::{Reader, Span};
use crate::codec::native_values::{property, read_layout};
use crate::package::{Package, PackageError, PackageErrorKind};
use crate::property::PropertyValue;
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;

#[derive(Clone, Debug, Default, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields)]
pub struct PackageMetadata {
    pub root: BTreeMap<String, String>,
    pub objects: BTreeMap<String, BTreeMap<String, String>>,
}

fn malformed(offset: u64, message: impl Into<String>) -> PackageError {
    PackageError::new(
        PackageErrorKind::MalformedData,
        Some(offset),
        "Package.MetaData",
        message,
    )
}

fn layout(reader: &mut Reader<'_>, name: &str) -> Result<PropertyValue, PackageError> {
    read_layout(reader, name, "Package.MetaData")
        .map(property)
        .map_err(|error| {
            PackageError::new(
                match error.kind() {
                    crate::property::PropertyErrorKind::ResourceLimit => {
                        PackageErrorKind::ResourceLimit
                    }
                    crate::property::PropertyErrorKind::UnsupportedCapability
                    | crate::property::PropertyErrorKind::UnsupportedVersion => {
                        PackageErrorKind::UnsupportedCapability
                    }
                    crate::property::PropertyErrorKind::MalformedData => {
                        PackageErrorKind::MalformedData
                    }
                },
                error.offset(),
                "Package.MetaData",
                error.to_string(),
            )
        })
}

impl Package {
    /// Loads optional saved package/object annotations, bounded to the next known section.
    pub fn read_metadata(&self, source: &[u8]) -> Result<Option<PackageMetadata>, PackageError> {
        let Some(offset) = self
            .summary
            .metadata_offset
            .map(|offset| offset.get())
            .filter(|offset| *offset != 0)
        else {
            return Ok(None);
        };
        let length = source.len() as u64;
        let mut boundaries = vec![
            length,
            u64::from(self.summary.total_header_size),
            self.summary.asset_registry_data_offset.get(),
            self.summary.bulk_data_start_offset,
            self.summary.thumbnail_table_offset.get(),
            self.summary.depends_offset.get(),
        ];
        boundaries.extend(self.exports.iter().map(|export| export.serial_offset.get()));
        boundaries.extend(
            [
                self.summary.world_tile_info_data_offset,
                self.summary.payload_toc_offset,
                self.summary.data_resource_offset,
                self.summary.searchable_names_offset,
            ]
            .into_iter()
            .flatten()
            .map(|offset| offset.get()),
        );
        let end = boundaries
            .into_iter()
            .filter(|end| *end > offset && *end <= length)
            .min()
            .ok_or_else(|| malformed(offset, "metadata offset is outside the package"))?;
        let mut reader =
            Reader::new(source).bounded(Span::new(offset, end - offset)?, "Package.MetaData")?;
        let PropertyValue::NativeStruct { fields } = layout(&mut reader, "FPackageMetaDataHeader")?
        else {
            unreachable!()
        };
        let PropertyValue::Int(objects) = fields[0].value else {
            unreachable!()
        };
        let PropertyValue::Int(root) = fields[1].value else {
            unreachable!()
        };
        if objects < 0 || root < 0 {
            return Err(malformed(offset, "negative package metadata count"));
        }
        reader.checked_vec_capacity::<(String, BTreeMap<String, String>)>(
            objects as usize,
            8,
            "Package.MetaData.Objects",
        )?;
        reader.checked_vec_capacity::<(String, String)>(
            root as usize,
            12,
            "Package.MetaData.Root",
        )?;
        let mut result = PackageMetadata::default();
        for _ in 0..objects {
            // FSoftObjectPath is serialized by the package linker as a soft-path table index.
            let index = reader.read_i32("Package.MetaData.Object")?;
            let object = usize::try_from(index)
                .ok()
                .and_then(|index| self.soft_object_paths.get(index))
                .ok_or_else(|| {
                    malformed(reader.tell() - 4, "invalid metadata soft-object-path index")
                })?;
            let PropertyValue::Map(entries) = layout(&mut reader, "FNameStringMap")? else {
                unreachable!()
            };
            let mut values = BTreeMap::new();
            for entry in entries {
                let (PropertyValue::Name(name), PropertyValue::String(value)) =
                    (entry.key, entry.value)
                else {
                    unreachable!()
                };
                let name = self
                    .resolve_name(name)
                    .ok_or_else(|| malformed(reader.tell(), "unresolved metadata name"))?;
                if values.insert(name, value).is_some() {
                    return Err(malformed(reader.tell(), "duplicate metadata key"));
                }
            }
            if result.objects.insert(object.clone(), values).is_some() {
                return Err(malformed(reader.tell(), "duplicate metadata object"));
            }
        }
        for _ in 0..root {
            let PropertyValue::NativeStruct { mut fields } =
                layout(&mut reader, "FNameStringPair")?
            else {
                unreachable!()
            };
            let PropertyValue::String(value) = fields.pop().unwrap().value else {
                unreachable!()
            };
            let PropertyValue::Name(name) = fields.pop().unwrap().value else {
                unreachable!()
            };
            let name = self
                .resolve_name(name)
                .ok_or_else(|| malformed(reader.tell(), "unresolved root metadata name"))?;
            if result.root.insert(name, value).is_some() {
                return Err(malformed(reader.tell(), "duplicate root metadata key"));
            }
        }
        Ok(Some(result))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    const FIXTURE: &[u8] = include_bytes!(
        "../../../fixtures/unreal-project/Content/Fixture/ParserNative/DA_Native.uasset"
    );
    #[test]
    fn metadata_is_optional_bounded_and_does_not_affect_header_reads() {
        let package = Package::parse(FIXTURE).unwrap();
        let offset = package.summary.metadata_offset.unwrap().get() as usize;
        let metadata = package.read_metadata(FIXTURE).unwrap().unwrap();
        assert_eq!(metadata.root["EmptyRoot"], "");
        assert_eq!(
            metadata.objects.values().next().unwrap()["Comment"],
            "café / 保存"
        );
        for (relative, value) in [
            (0, -1_i32),
            (4, -1),
            (0, i32::MAX),
            (8, i32::MAX),
            (12, -1),
            (16, i32::MAX),
        ] {
            let mut malformed = FIXTURE.to_vec();
            malformed[offset + relative..offset + relative + 4]
                .copy_from_slice(&value.to_le_bytes());
            let header = Package::parse(&malformed)
                .expect("metadata does not participate in header parsing");
            assert!(
                header.read_metadata(&malformed).is_err(),
                "metadata mutation at {relative}"
            );
        }
        for end in offset..offset + 24 {
            assert!(package.read_metadata(&FIXTURE[..end]).is_err());
        }
        let mut no_metadata = package.clone();
        no_metadata.summary.metadata_offset = None;
        assert_eq!(no_metadata.read_metadata(FIXTURE).unwrap(), None);
        assert!(
            Package::parse_header(
                &FIXTURE[..package.summary.total_header_size as usize],
                FIXTURE.len()
            )
            .is_ok()
        );
    }
}
