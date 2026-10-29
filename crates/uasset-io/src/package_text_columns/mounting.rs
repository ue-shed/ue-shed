//! Object-path completion from packages/game-text/src/package-object-path.ts.
use super::{Evidence, Occurrence, Stored};
use crate::protocol_result::{
    SavedAssetPackageTextEvent, SavedAssetPackageTextRecord, TextExtractionIdentity,
    TextExtractionLocation,
};
use game_text_index::wtf8::Wtf8Buf;

fn view(text: &mut String) {
    *text = Wtf8Buf::from_utf8(text).into_view();
}
fn remount(path: &mut String, mounted: Option<&str>, serialized: Option<&str>) {
    if let Some(mounted) = mounted
        && !path.is_empty()
    {
        if !path.starts_with('/') {
            *path = format!("{mounted}.{path}");
        } else if let Some(from) = serialized
            && (path == from
                || path
                    .strip_prefix(from)
                    .is_some_and(|rest| rest.starts_with(['.', ':'])))
        {
            *path = format!("{mounted}{}", &path[from.len()..]);
        }
    }
    view(path);
}
pub fn native_stored(
    event: SavedAssetPackageTextEvent,
    path: &str,
    signature: &str,
) -> Option<Stored> {
    let evidence = match event {
        SavedAssetPackageTextEvent::Summary { .. } => return None,
        SavedAssetPackageTextEvent::Error {
            mut code,
            mut message,
            retry_safe,
            ..
        } => {
            view(&mut code);
            view(&mut message);
            Evidence::Error {
                code,
                message,
                path: Wtf8Buf::from_utf8(path).into_view(),
                retry_safe,
                json: None,
            }
        }
        SavedAssetPackageTextEvent::Package { record } => {
            let SavedAssetPackageTextRecord {
                file_bytes,
                path: _,
                mut package_name,
                mut asset_class,
                schema_version,
                status,
                decode_errors,
                occurrences,
                gap_counts,
                text_gap_counts,
                mut gap_samples,
                mut gather_coverage,
                mut blueprint_classes,
            } = record;
            let normalized = path.replace('\\', "/");
            let mounted = normalized
                .split_once('/')
                .filter(|(first, _)| first.eq_ignore_ascii_case("Content"))
                .and_then(|(_, rest)| rest.rsplit_once('.'))
                .filter(|(name, extension)| {
                    !name.is_empty()
                        && (extension.eq_ignore_ascii_case("uasset")
                            || extension.eq_ignore_ascii_case("umap"))
                })
                .map(|(name, _)| format!("/Game/{name}"));
            let serialized = package_name
                .as_deref()
                .filter(|s| s.starts_with('/') && Some(*s) != mounted.as_deref());
            let mut occurrences = occurrences
                .into_iter()
                .map(Occurrence::from)
                .collect::<Vec<_>>();
            for occurrence in &mut occurrences {
                match &mut occurrence.location {
                    TextExtractionLocation::AssetProperty {
                        object_path,
                        class_path,
                        property_path,
                    } => {
                        remount(object_path, mounted.as_deref(), serialized);
                        remount(class_path, mounted.as_deref(), serialized);
                        view(property_path);
                    }
                    TextExtractionLocation::DataTableCell {
                        object_path,
                        property_path,
                        row,
                    } => {
                        remount(object_path, mounted.as_deref(), serialized);
                        view(property_path);
                        view(row);
                    }
                    TextExtractionLocation::StringTableEntry {
                        object_path,
                        entry_key,
                    } => {
                        remount(object_path, mounted.as_deref(), serialized);
                        view(entry_key);
                    }
                    TextExtractionLocation::CodePlace {
                        file,
                        macro_name,
                        wrapper,
                        ..
                    } => {
                        view(file);
                        view(macro_name);
                        if let Some(wrapper) = wrapper {
                            view(wrapper);
                        }
                    }
                }
                view(&mut occurrence.source);
                view(&mut occurrence.dev_notes);
                match &mut occurrence.identity {
                    TextExtractionIdentity::Resolved { namespace, key } => {
                        view(namespace);
                        view(key);
                    }
                    TextExtractionIdentity::StringTable { table_id, key } => {
                        view(table_id);
                        view(key);
                    }
                    TextExtractionIdentity::Unresolved { .. } => {}
                }
            }
            for gap in &mut gap_samples {
                remount(&mut gap.object_path, mounted.as_deref(), serialized);
                view(&mut gap.property_path);
            }
            for classes in &mut blueprint_classes {
                for text in [&mut classes.blueprint, &mut classes.generated_class]
                    .into_iter()
                    .chain(
                        [
                            &mut classes.class_default,
                            &mut classes.skeleton_class,
                            &mut classes.skeleton_class_default,
                        ]
                        .into_iter()
                        .filter_map(Option::as_mut),
                    )
                {
                    remount(text, mounted.as_deref(), serialized);
                }
            }
            for text in [&mut package_name, &mut asset_class]
                .into_iter()
                .filter_map(Option::as_mut)
            {
                view(text);
            }
            if let Some(gather) = &mut gather_coverage {
                for sample in &mut gather.missing_samples {
                    for text in [
                        &mut sample.namespace,
                        &mut sample.key,
                        &mut sample.source,
                        &mut sample.site,
                    ] {
                        view(text);
                    }
                }
            }
            Evidence::Package {
                blueprint_json: None,
                record: Box::new(SavedAssetPackageTextRecord {
                    file_bytes,
                    path: Wtf8Buf::from_utf8(path).into_view(),
                    package_name,
                    asset_class,
                    schema_version,
                    status,
                    decode_errors,
                    occurrences,
                    gap_counts,
                    text_gap_counts,
                    gap_samples,
                    gather_coverage,
                    blueprint_classes,
                }),
            }
        }
    };
    Some(Stored {
        path: Wtf8Buf::from_utf8(path).into_view(),
        signature: Wtf8Buf::from_utf8(signature).into_view(),
        evidence,
    })
}
