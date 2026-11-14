//! Project plugin content mount points, as Unreal's plugin manager finds them.
//!
//! UE 5.8 `FPluginManager::FindPluginsInDirectory` walks the project's `Plugins` directory, skips
//! directories named `Content`, and takes the first `.uplugin` file a directory holds as a plugin
//! without looking further down. `FPlugin::GetMountedAssetPath` mounts a plugin that can contain
//! content at `/<descriptor file stem>/`, backed by the plugin's `Content` directory.
//!
//! Not modelled: whether the project enables the plugin, `AdditionalPluginDirectories` in the
//! project descriptor, mods, and plugin extensions. A name that is already mounted keeps its first
//! plugin, in path order.

use std::collections::HashSet;
use std::fs;
use std::path::{Path, PathBuf};

use serde::Deserialize;

use super::super::catalog::{MountPoint, project_relative_path};
use super::{CancellationToken, Failure, checkpoint, discovery_failure};

/// Mount points for the project's plugins that can contain content, ordered by plugin path.
pub(super) fn content_mount_points(
    project_root: &Path,
    cancellation: &CancellationToken,
) -> Result<Vec<MountPoint>, Failure> {
    let mut descriptors = plugin_descriptors(&project_root.join("Plugins"), cancellation)?;
    descriptors.sort();
    let root = project_root.to_string_lossy();
    let mut mounted = HashSet::from(["game".to_owned()]);
    let mut mounts = Vec::new();
    for descriptor in descriptors {
        checkpoint(cancellation, "discovery")?;
        let (Some(name), Some(directory)) = (
            descriptor.file_stem().and_then(|stem| stem.to_str()),
            descriptor.parent(),
        ) else {
            continue;
        };
        if !can_contain_content(&descriptor) || !mounted.insert(name.to_ascii_lowercase()) {
            continue;
        }
        let directory = project_relative_path(&root, &directory.to_string_lossy());
        mounts.push(MountPoint {
            name: format!("/{name}/"),
            path: format!("{directory}/Content/"),
        });
    }
    Ok(mounts)
}

/// Every plugin descriptor below `plugins`, one per plugin directory.
fn plugin_descriptors(
    plugins: &Path,
    cancellation: &CancellationToken,
) -> Result<Vec<PathBuf>, Failure> {
    let mut descriptors = Vec::new();
    if !plugins.is_dir() {
        return Ok(descriptors);
    }
    let mut pending = vec![plugins.to_path_buf()];
    while let Some(directory) = pending.pop() {
        checkpoint(cancellation, "discovery")?;
        let mut entries = fs::read_dir(&directory)
            .map_err(|error| discovery_failure(&directory, error))?
            .map(|entry| {
                let entry = entry.map_err(|error| discovery_failure(&directory, error))?;
                let kind = entry
                    .file_type()
                    .map_err(|error| discovery_failure(&entry.path(), error))?;
                Ok((entry.path(), kind.is_dir()))
            })
            .collect::<Result<Vec<_>, Failure>>()?;
        // Unreal visits in directory order and keeps the first descriptor; sort so a directory
        // with several descriptors resolves the same way on every machine.
        entries.sort();
        let descriptor = entries.iter().find(|(path, is_dir)| {
            !is_dir
                && path
                    .file_name()
                    .and_then(|name| name.to_str())
                    .is_some_and(|name| name.ends_with(".uplugin"))
        });
        match descriptor {
            Some((descriptor, _)) => descriptors.push(descriptor.clone()),
            None => pending.extend(
                entries
                    .into_iter()
                    .filter(|(path, is_dir)| {
                        *is_dir
                            && !path
                                .file_name()
                                .and_then(|name| name.to_str())
                                .is_some_and(|name| name.eq_ignore_ascii_case("Content"))
                    })
                    .map(|(path, _)| path),
            ),
        }
    }
    Ok(descriptors)
}

/// `FPluginDescriptor::bCanContainContent`; a descriptor that does not read can mount nothing.
fn can_contain_content(descriptor: &Path) -> bool {
    #[derive(Deserialize)]
    struct Descriptor {
        #[serde(rename = "CanContainContent", default)]
        can_contain_content: bool,
    }
    let Ok(bytes) = fs::read(descriptor) else {
        return false;
    };
    let bytes = bytes.strip_prefix(b"\xEF\xBB\xBF").unwrap_or(&bytes);
    serde_json::from_slice::<Descriptor>(bytes)
        .is_ok_and(|descriptor| descriptor.can_contain_content)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::{SystemTime, UNIX_EPOCH};

    struct TemporaryProject(PathBuf);
    impl Drop for TemporaryProject {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    fn descriptor(path: &Path, can_contain_content: bool) {
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(
            path,
            format!("\u{feff}{{\"FileVersion\": 3, \"CanContainContent\": {can_contain_content}}}"),
        )
        .unwrap();
    }

    #[test]
    fn plugins_mount_by_descriptor_stem_when_they_can_contain_content() {
        let unique = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let project =
            TemporaryProject(std::env::temp_dir().join(format!("ue-shed-plugins-{unique}")));
        let plugins = project.0.join("Plugins");
        descriptor(&plugins.join("BlackEye/Black_Eye.uplugin"), true);
        // A descriptor stops the walk: nested descriptors are part of the outer plugin.
        descriptor(&plugins.join("BlackEye/Nested/Inner.uplugin"), true);
        descriptor(&plugins.join("Marketplace/Tools/Tools.uplugin"), true);
        descriptor(&plugins.join("CodeOnly/CodeOnly.uplugin"), false);
        // Content directories are never searched for plugins.
        descriptor(&plugins.join("Loose/Content/Hidden/Hidden.uplugin"), true);
        // A second plugin with a mounted name keeps the first one in path order.
        descriptor(&plugins.join("Zed/Tools.uplugin"), true);
        fs::write(plugins.join("Broken.txt"), "not a plugin").unwrap();

        let mounts = content_mount_points(&project.0, &CancellationToken::new()).unwrap();
        assert_eq!(
            mounts,
            [
                MountPoint {
                    name: "/Black_Eye/".into(),
                    path: "Plugins/BlackEye/Content/".into()
                },
                MountPoint {
                    name: "/Tools/".into(),
                    path: "Plugins/Marketplace/Tools/Content/".into()
                },
            ]
        );
        assert!(
            content_mount_points(&project.0.join("Missing"), &CancellationToken::new())
                .unwrap()
                .is_empty()
        );
    }
}
