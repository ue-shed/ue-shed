//! Package dependencies as Unreal's Asset Registry records them, read from a saved package header.
//!
//! UE 5.8 `FPackageReader::ReadDependencyData` reads three header sections, and
//! `FPackageDependencyData::LoadDependenciesFromPackageHeader` turns them into package
//! dependencies:
//!
//! - the import map: one hard dependency per import, on the import's package (its `PackageName`
//!   when set, else its outermost import);
//! - the soft package reference list: one dependency per entry, not hard;
//! - the asset registry dependency section (`WritePackageData`): which imports and soft references
//!   the game uses, and from UE 5 `ASSETREGISTRY_PACKAGEBUILDDEPENDENCIES` the extra build
//!   dependencies.
//!
//! `UAssetRegistryImpl::DependencyDataGathered` then drops hard dependencies on four core script
//! packages and dependencies on the package itself, and keeps one set of properties per target.
//! Everything lives before `TotalHeaderSize`, so a header-only read has every byte it needs.
//!
//! Not applied: `FCoreRedirects` package redirects from configuration, and package relocation
//! (`Package.Relocation`, off by default in UE 5.8). Searchable-name and manage dependencies are
//! other Asset Registry categories, not package dependencies.

use std::borrow::Cow;

use crate::archive::{NameRef, Reader};
use crate::package::{
    Import, ImportLinks, Package, PackageError, PackageErrorKind, PackageIndex, PackageSummary,
};
use crate::version::PackageFlags;

const UE4_ADD_STRING_ASSET_REFERENCES_MAP: i32 = 384;
const UE4_ADDED_SOFT_OBJECT_PATH: i32 = 514;
const UE4_ASSETREGISTRY_DEPENDENCYFLAGS: i32 = 521;
const UE5_ASSETREGISTRY_PACKAGEBUILDDEPENDENCIES: i32 = 1013;

/// `FPackagePath::GetExternalActorsFolderName`.
const EXTERNAL_ACTORS_FOLDER: &str = "__ExternalActors__";

/// `ScriptPackagesToSkip` in `UAssetRegistryImpl::DependencyDataGathered`: every package depends
/// on these, so Unreal does not record hard dependencies on them.
const SKIPPED_SCRIPT_PACKAGES: [&str; 4] = [
    "/Script/CoreUObject",
    "/Script/Engine",
    "/Script/BlueprintGraph",
    "/Script/UnrealEd",
];

/// One package another package depends on, with Unreal's `EDependencyProperty` package bits.
///
/// A package can depend on the same target with more than one set of properties (for example
/// an editor-only import and a game import of the same package); Unreal keeps each set.
#[derive(Clone, Debug, Eq, Hash, Ord, PartialEq, PartialOrd)]
pub struct PackageDependency {
    pub package: String,
    /// From the import map: the target must load before this package finishes loading. Soft
    /// references and build dependencies are not hard.
    pub hard: bool,
    /// The game uses the reference, not only the editor.
    pub game: bool,
    /// An extra build dependency SavePackage recorded (cooking reads it).
    pub build: bool,
}

impl PackageDependency {
    /// Unreal's `EDependencyProperty` bits: hard 1, game 2, build 4.
    #[must_use]
    pub fn properties(&self) -> u8 {
        u8::from(self.hard) | u8::from(self.game) << 1 | u8::from(self.build) << 2
    }

    /// The dependency these `EDependencyProperty` bits describe.
    #[must_use]
    pub fn from_properties(package: String, properties: u8) -> Self {
        Self {
            package,
            hard: properties & 1 != 0,
            game: properties & 2 != 0,
            build: properties & 4 != 0,
        }
    }
}

/// The header tables Unreal's dependency reader needs: the summary, the import map and the name
/// map. `Package` and `HeaderIndex` both provide them, so both read dependencies identically.
pub(crate) trait HeaderTables {
    type Import: ImportLinks;
    fn summary(&self) -> &PackageSummary;
    fn imports(&self) -> &[Self::Import];
    fn name_count(&self) -> usize;
    /// The name map entry at `index`, which is below `name_count`.
    fn name_text(&self, index: usize) -> &str;

    /// A name reference as `Package::resolve_name` renders it, borrowing unnumbered names.
    fn name(&self, name: NameRef) -> Option<Cow<'_, str>> {
        let index = usize::try_from(name.index().get()).ok()?;
        if index >= self.name_count() {
            return None;
        }
        let base = self.name_text(index);
        Some(if name.number() == 0 {
            Cow::Borrowed(base)
        } else {
            Cow::Owned(format!("{base}_{}", name.number() - 1))
        })
    }

    /// Whether a name reference renders as `None`. A numbered name renders as `Base_N`, never as
    /// `None`, so only an unnumbered reference to a `None` entry does.
    fn is_none_name(&self, name: NameRef) -> bool {
        name.number() == 0
            && usize::try_from(name.index().get())
                .ok()
                .filter(|index| *index < self.name_count())
                .is_some_and(|index| self.name_text(index) == "None")
    }
}

impl HeaderTables for Package {
    type Import = Import;
    fn summary(&self) -> &PackageSummary {
        &self.summary
    }
    fn imports(&self) -> &[Import] {
        &self.imports
    }
    fn name_count(&self) -> usize {
        self.names.len()
    }
    fn name_text(&self, index: usize) -> &str {
        &self.names[index]
    }
}

impl Package {
    /// This package's dependencies as Unreal's Asset Registry records them.
    ///
    /// `package_name` is the name Unreal gives the package from its file location (for example
    /// `/Game/Maps/L_World` for `Content/Maps/L_World.umap`); the saved name in the summary can
    /// be stale after a move outside Unreal. Unreal uses it to drop self-references and to apply
    /// its external-actor rule. `source` must hold the header through `summary.total_header_size`.
    ///
    /// Targets compare without regard to ASCII case, as Unreal's names do. The result is sorted by
    /// target, then properties, and holds each target and property set once.
    ///
    /// # Errors
    ///
    /// Returns an error when the soft package reference list or the asset registry dependency
    /// section is malformed or its counts disagree with the import map.
    pub fn asset_registry_dependencies(
        &self,
        source: &[u8],
        package_name: &str,
    ) -> Result<Vec<PackageDependency>, PackageError> {
        asset_registry_dependencies(self, source, package_name)
    }
}

/// [`Package::asset_registry_dependencies`] for any header tables.
pub(crate) fn asset_registry_dependencies<'t, T: HeaderTables + ?Sized>(
    tables: &'t T,
    source: &'t [u8],
    package_name: &str,
) -> Result<Vec<PackageDependency>, PackageError> {
    let soft = read_soft_package_references(tables, source)?;
    let flags = read_dependency_flags(tables, source, soft.len())?;
    let world = ExternalActorWorld::of(package_name);
    let imports = tables.imports();

    // Many imports name the same package. Read each package name reference and game flag
    // once: the result keeps one entry per target and property set either way.
    let mut roots = (0..imports.len())
        .filter_map(|index| {
            let name = import_package_name(tables, index)?;
            let used_in_game = flags
                .import_used_in_game
                .get(index)
                .copied()
                .unwrap_or(true);
            Some((name, used_in_game))
        })
        .collect::<Vec<_>>();
    roots.sort_unstable();
    roots.dedup();

    let mut dependencies: Vec<(Cow<'t, str>, u8)> =
        Vec::with_capacity(roots.len() + soft.len() + flags.build.len());
    for (name, used_in_game) in roots {
        let Some(package) = tables.name(name) else {
            continue;
        };
        let game = used_in_game && !world.contains(&package);
        dependencies.push((package, properties(true, game, false)));
    }
    for (index, package) in soft.into_iter().enumerate() {
        let used_in_game = flags.soft_used_in_game.get(index).copied().unwrap_or(true);
        let game = used_in_game && !world.contains(&package);
        dependencies.push((package, properties(false, game, false)));
    }
    for package in flags.build {
        if !world.contains(&package) {
            dependencies.push((package, properties(false, false, true)));
        }
    }
    Ok(registry_dependencies(dependencies, package_name))
}

const fn properties(hard: bool, game: bool, build: bool) -> u8 {
    (hard as u8) | (game as u8) << 1 | (build as u8) << 2
}

/// UE 5.8 `FPackageDependencyData::GetImportPackageName`: the name reference naming an import's
/// package. Imports that name no package (a broken outer chain, or `None`) give no dependency.
fn import_package_name<T: HeaderTables + ?Sized>(tables: &T, mut index: usize) -> Option<NameRef> {
    let imports = tables.imports();
    let names = |name: NameRef| tables.name(name).is_some() && !tables.is_none_name(name);
    for _ in 0..imports.len() {
        let import = imports.get(index)?;
        if let Some(name) = import.package_name().filter(|name| names(*name)) {
            return Some(name);
        }
        match import.outer_index() {
            PackageIndex::Null => return Some(import.object_name()).filter(|name| names(*name)),
            PackageIndex::Import(outer) => index = usize::try_from(outer).ok()?,
            PackageIndex::Export(_) => return None,
        }
    }
    None
}

/// UE 5.8 `FPackageReader::SerializeSoftPackageReferenceList`.
fn read_soft_package_references<'t, T: HeaderTables + ?Sized>(
    tables: &'t T,
    source: &'t [u8],
) -> Result<Vec<Cow<'t, str>>, PackageError> {
    let versions = &tables.summary().versions;
    let Some(table) = tables.summary().soft_package_references else {
        return Ok(Vec::new());
    };
    if !versions.is_at_least_ue4(UE4_ADD_STRING_ASSET_REFERENCES_MAP)
        || table.offset.get() == 0
        || table.count == 0
    {
        return Ok(Vec::new());
    }
    let mut reader = Reader::new(source);
    reader.seek(table.offset.get(), "SoftPackageReferences")?;
    let count = crate::convert::usize_from_u32(table.count);
    let capacity =
        reader.checked_vec_capacity::<String>(count, 1, "SoftPackageReferences.Count")?;
    let mut references = Vec::with_capacity(capacity);
    for index in 0..count {
        if versions.is_at_least_ue4(UE4_ADDED_SOFT_OBJECT_PATH) {
            let name = reader.read_name_ref(&format_args!("SoftPackageReferences[{index}]"))?;
            let name = tables.name(name).ok_or_else(|| {
                PackageError::new(
                    PackageErrorKind::MalformedData,
                    Some(reader.tell()),
                    format_args!("SoftPackageReferences[{index}]"),
                    "soft package reference is outside the name map",
                )
            })?;
            references.push(name);
        } else {
            // Older packages saved object paths; Unreal keeps their package part.
            let path = reader.read_fstring_cow(&format_args!("SoftPackageReferences[{index}]"))?;
            references.push(match path {
                Cow::Borrowed(path) => Cow::Borrowed(package_part(path)),
                Cow::Owned(path) => Cow::Owned(package_part(&path).to_owned()),
            });
        }
    }
    Ok(references)
}

/// An object path's package: the part before its first `.`.
fn package_part(path: &str) -> &str {
    path.split_once('.').map_or(path, |(package, _)| package)
}

/// UE 5.8 `ReadPackageDataMain` (only its leading offset) and `ReadPackageDataDependencies`.
fn read_dependency_flags<'t, T: HeaderTables + ?Sized>(
    tables: &'t T,
    source: &[u8],
    soft_count: usize,
) -> Result<DependencyFlags<'t>, PackageError> {
    let summary = tables.summary();
    let import_count = tables.imports().len();
    let all_game = || DependencyFlags {
        import_used_in_game: vec![true; import_count],
        soft_used_in_game: vec![true; soft_count],
        build: Vec::new(),
    };
    let pre_dependency_format = !summary
        .versions
        .is_at_least_ue4(UE4_ASSETREGISTRY_DEPENDENCYFLAGS)
        || summary
            .versions
            .package_flags
            .contains(PackageFlags::FILTER_EDITOR_ONLY);
    let registry_offset = summary.asset_registry_data_offset.get();
    if pre_dependency_format || registry_offset == 0 {
        return Ok(all_game());
    }
    let mut reader = Reader::new(source);
    reader.seek(registry_offset, "AssetRegistryData")?;
    let offset = reader.read_i64("AssetRegistryData.DependencyDataOffset")?;
    if offset == -1 {
        return Ok(all_game());
    }
    let offset = u64::try_from(offset).map_err(|_| {
        PackageError::new(
            PackageErrorKind::MalformedData,
            Some(registry_offset),
            "AssetRegistryData.DependencyDataOffset",
            format!("negative dependency data offset {offset}"),
        )
    })?;
    reader.seek(offset, "AssetRegistryDependencyData")?;
    let import_used_in_game =
        read_bit_array(&mut reader, "AssetRegistryDependencyData.ImportUsedInGame")?;
    let soft_used_in_game = read_bit_array(
        &mut reader,
        "AssetRegistryDependencyData.SoftPackageUsedInGame",
    )?;
    let mut build = Vec::new();
    if summary
        .versions
        .is_at_least_ue5(UE5_ASSETREGISTRY_PACKAGEBUILDDEPENDENCIES)
    {
        let count = reader.read_count("AssetRegistryDependencyData.ExtraPackageDependencies")?;
        let capacity = reader.checked_vec_capacity::<String>(
            count,
            12,
            "AssetRegistryDependencyData.ExtraPackageDependencies",
        )?;
        build.reserve(capacity);
        for index in 0..count {
            let path =
                format_args!("AssetRegistryDependencyData.ExtraPackageDependencies[{index}]");
            let name = reader.read_name_ref(&path)?;
            let _flags = reader.read_u32(&path)?;
            let name = tables.name(name).ok_or_else(|| {
                PackageError::new(
                    PackageErrorKind::MalformedData,
                    Some(reader.tell()),
                    path,
                    "build dependency is outside the name map",
                )
            })?;
            build.push(name);
        }
    }
    if import_used_in_game.len() != import_count || soft_used_in_game.len() != soft_count {
        return Err(PackageError::new(
            PackageErrorKind::MalformedData,
            Some(offset),
            "AssetRegistryDependencyData",
            format!(
                "dependency flags cover {} imports and {} soft references, the header has {} and {soft_count}",
                import_used_in_game.len(),
                soft_used_in_game.len(),
                import_count
            ),
        ));
    }
    Ok(DependencyFlags {
        import_used_in_game,
        soft_used_in_game,
        build,
    })
}

struct DependencyFlags<'t> {
    import_used_in_game: Vec<bool>,
    soft_used_in_game: Vec<bool>,
    build: Vec<Cow<'t, str>>,
}

/// `UAssetRegistryImpl::DependencyDataGathered`: drop hard dependencies on the skipped script
/// packages and dependencies on the package itself, then keep each target and property set once
/// (`FPackageFlagSet`). Names compare without regard to ASCII case, as `FName` does. Only the
/// kept targets are copied out.
fn registry_dependencies(
    mut dependencies: Vec<(Cow<'_, str>, u8)>,
    package_name: &str,
) -> Vec<PackageDependency> {
    dependencies.retain(|(package, properties)| {
        !(properties & 1 != 0
            && SKIPPED_SCRIPT_PACKAGES
                .iter()
                .any(|skipped| skipped.eq_ignore_ascii_case(package)))
            && !package.eq_ignore_ascii_case(package_name)
    });
    // Ordered by the ASCII-folded target, then properties, then exact spelling: the order of
    // `(target.to_ascii_lowercase(), properties)` without lowercasing every comparison.
    dependencies.sort_by(|(left, left_properties), (right, right_properties)| {
        folded_order(left, right)
            .then(left_properties.cmp(right_properties))
            .then_with(|| left.cmp(right))
    });
    dependencies.dedup_by(|(later, later_properties), (earlier, earlier_properties)| {
        later_properties == earlier_properties && later.eq_ignore_ascii_case(earlier)
    });
    dependencies
        .into_iter()
        .map(|(package, properties)| {
            PackageDependency::from_properties(package.into_owned(), properties)
        })
        .collect()
}

fn folded_order(left: &str, right: &str) -> std::cmp::Ordering {
    left.bytes()
        .map(|byte| byte.to_ascii_lowercase())
        .cmp(right.bytes().map(|byte| byte.to_ascii_lowercase()))
}

/// The external-actor rule of `LoadDependenciesFromPackageHeader`: an external actor package
/// (`/Root/__ExternalActors__/Path/To/World/...`) is editor-only, so its dependencies on its
/// world do not count as game dependencies, and its build dependencies on the world are dropped.
struct ExternalActorWorld<'a> {
    /// The package name after the external actors folder; `None` when that is empty or absent.
    relative_path: Option<&'a str>,
}

impl<'a> ExternalActorWorld<'a> {
    fn of(package_name: &'a str) -> Self {
        let relative_path = find_ignore_ascii_case(package_name, EXTERNAL_ACTORS_FOLDER)
            .map(|index| &package_name[index + EXTERNAL_ACTORS_FOLDER.len()..])
            .filter(|path| !path.is_empty());
        Self { relative_path }
    }

    /// `IsWorldOfExternalActor`: the target's path below its mount point appears in this
    /// package's path below the external actors folder.
    fn contains(&self, target: &str) -> bool {
        self.relative_path.is_some_and(|relative_path| {
            find_ignore_ascii_case(relative_path, path_below_mount_point(target)).is_some()
        })
    }
}

/// `FStringView(Target).RightChop(GetMountPointNameFromPath(Target).Len() + 1)`, including
/// `GetMountPointNameFromPath` dropping a `Classes_` prefix from the mount point name.
fn path_below_mount_point(target: &str) -> &str {
    let mount_point = target.strip_prefix('/').map_or("", |rest| {
        let name = rest.split_once('/').map_or(rest, |(name, _)| name);
        name.strip_prefix("Classes_").unwrap_or(name)
    });
    let chop = mount_point.chars().count() + 1;
    target
        .char_indices()
        .nth(chop)
        .map_or("", |(index, _)| &target[index..])
}

/// `UE::String::FindFirst(Text, Search, ESearchCase::IgnoreCase)`: an empty search matches at 0.
fn find_ignore_ascii_case(text: &str, search: &str) -> Option<usize> {
    if search.is_empty() {
        return Some(0);
    }
    let (text, search) = (text.as_bytes(), search.as_bytes());
    (0..=text.len().checked_sub(search.len())?)
        .find(|&start| text[start..start + search.len()].eq_ignore_ascii_case(search))
}

/// UE 5.8 `TBitArray::Serialize`: `int32 NumBits`, then whole 32-bit words, low bit first.
fn read_bit_array(reader: &mut Reader<'_>, path: &str) -> Result<Vec<bool>, PackageError> {
    let count = reader.read_count(path)?;
    let words = count.div_ceil(32);
    let mut bits = Vec::with_capacity(reader.checked_vec_capacity::<bool>(count, 0, path)?);
    for word_index in 0..words {
        let word = reader.read_u32(path)?;
        for bit in 0..32 {
            if word_index * 32 + bit < count {
                bits.push(word & (1 << bit) != 0);
            }
        }
    }
    Ok(bits)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn dependency(package: &str, hard: bool, game: bool) -> PackageDependency {
        PackageDependency {
            package: package.to_owned(),
            hard,
            game,
            build: false,
        }
    }

    fn header_dependencies(bytes: &[u8], package_name: &str) -> Vec<PackageDependency> {
        let package = Package::parse(bytes).unwrap();
        let header = &bytes[..package.summary.total_header_size as usize];
        let header_only = Package::parse_header(header, bytes.len()).unwrap();
        let dependencies = header_only
            .asset_registry_dependencies(header, package_name)
            .unwrap();
        assert_eq!(
            dependencies,
            package
                .asset_registry_dependencies(bytes, package_name)
                .unwrap()
        );
        dependencies
    }

    #[test]
    fn imports_soft_references_and_game_flags_come_from_the_header() {
        // The table imports /Script/Engine twice (editor-only and game); Unreal skips hard
        // dependencies on /Script/Engine entirely.
        let dependencies = header_dependencies(
            include_bytes!(
                "../../../fixtures/unreal-project/Content/Fixture/Authoring/DT_AssetReferences.uasset"
            ),
            "/Game/Fixture/Authoring/DT_AssetReferences",
        );
        assert_eq!(
            dependencies,
            [
                dependency("/Engine/EngineResources/DefaultTexture", false, true),
                dependency("/Script/UEShedFixture", true, true),
            ]
        );
    }

    #[test]
    fn import_dependencies_name_the_outermost_package_once() {
        let bytes = include_bytes!(
            "../../../fixtures/unreal-project/Content/Fixture/Input/IMC_Fixture.uasset"
        );
        assert_eq!(
            header_dependencies(bytes, "/Game/Fixture/Input/IMC_Fixture"),
            [
                dependency("/Game/Fixture/Input/IA_Jump", true, true),
                dependency("/Game/Fixture/Input/IA_Move", true, true),
                dependency("/Script/EnhancedInput", true, true),
            ]
        );
        // Unreal drops a dependency on the package itself, by its mounted name in any case.
        assert_eq!(
            header_dependencies(bytes, "/game/fixture/input/ia_jump"),
            [
                dependency("/Game/Fixture/Input/IA_Move", true, true),
                dependency("/Script/EnhancedInput", true, true),
            ]
        );
    }

    #[test]
    fn an_external_actor_does_not_use_its_world_in_game() {
        let bytes = include_bytes!(
            "../../../fixtures/perforce-map-history/revisions/baseline/Content/__ExternalActors__/Fixture/History/L_MapHistoryWorld/0/6T/BA5Z8RENRA6081VFA9SSIZ.uasset"
        );
        let world = "/Game/Fixture/History/L_MapHistoryWorld";
        let as_actor = header_dependencies(
            bytes,
            "/Game/__ExternalActors__/Fixture/History/L_MapHistoryWorld/0/6T/BA5Z8RENRA6081VFA9SSIZ",
        );
        let as_plain_package = header_dependencies(bytes, "/Game/Fixture/History/Moved");
        let to_world = |dependencies: &[PackageDependency]| {
            dependencies
                .iter()
                .filter(|dependency| dependency.package == world)
                .cloned()
                .collect::<Vec<_>>()
        };
        assert_eq!(to_world(&as_plain_package), [dependency(world, true, true)]);
        assert_eq!(to_world(&as_actor), [dependency(world, true, false)]);
        let others = |dependencies: &[PackageDependency]| {
            dependencies
                .iter()
                .filter(|dependency| dependency.package != world)
                .cloned()
                .collect::<Vec<_>>()
        };
        assert_eq!(others(&as_actor), others(&as_plain_package));
    }

    #[test]
    fn legacy_engine_packages_read_with_every_reference_used_in_game() {
        for bytes in [
            include_bytes!(
                "../../../fixtures/legacy-unreal-project/Generated/4.27/Content/Legacy/DT_LegacyText.uasset"
            )
            .as_slice(),
            include_bytes!(
                "../../../fixtures/legacy-unreal-project/Generated/5.3/Content/Legacy/DT_LegacyText.uasset"
            )
            .as_slice(),
        ] {
            let dependencies = header_dependencies(bytes, "/Game/Legacy/DT_LegacyText");
            assert!(!dependencies.is_empty());
            assert!(dependencies.iter().all(|dependency| !dependency.build));
            assert!(
                dependencies
                    .iter()
                    .all(|dependency| !dependency.package.eq_ignore_ascii_case("/Script/Engine")
                        || !dependency.hard)
            );
        }
    }

    #[test]
    fn targets_keep_each_property_set_once_without_regard_to_case() {
        let dependencies = registry_dependencies(
            [
                dependency("/Game/B", true, true),
                dependency("/game/b", true, true),
                dependency("/Game/B", true, false),
                dependency("/Game/A", false, true),
                dependency("/script/engine", true, true),
                dependency("/Script/Engine", false, true),
                dependency("/Game/Self", true, true),
            ]
            .into_iter()
            .map(|dependency| {
                let properties = dependency.properties();
                (Cow::Owned(dependency.package), properties)
            })
            .collect(),
            "/Game/self",
        );
        assert_eq!(
            dependencies,
            [
                dependency("/Game/A", false, true),
                dependency("/Game/B", true, false),
                dependency("/Game/B", true, true),
                dependency("/Script/Engine", false, true),
            ]
        );
    }

    #[test]
    fn external_actor_worlds_match_below_the_mount_point() {
        let actor = ExternalActorWorld::of("/Game/__ExternalActors__/Maps/L_World/0/AB/XYZ");
        assert!(actor.contains("/Game/Maps/L_World"));
        assert!(actor.contains("/Plugin/maps/l_world"));
        assert!(!actor.contains("/Game/Maps/L_Other"));
        assert!(!ExternalActorWorld::of("/Game/Maps/L_World").contains("/Game/Maps/L_World"));
        assert!(!ExternalActorWorld::of("/Game/__ExternalActors__").contains("/Game/Maps"));
        assert_eq!(
            path_below_mount_point("/Game/Maps/L_World"),
            "/Maps/L_World"
        );
        // Unreal chops the length of the stripped name plus one, not the whole first segment.
        assert_eq!(
            path_below_mount_point("/Classes_Game/Thing"),
            "ses_Game/Thing"
        );
        assert_eq!(path_below_mount_point("/Game"), "");
        assert_eq!(path_below_mount_point("Relative/Path"), "elative/Path");
    }

    #[test]
    fn a_dependency_section_that_disagrees_with_the_import_map_is_malformed() {
        let bytes = include_bytes!(
            "../../../fixtures/unreal-project/Content/Fixture/Input/IMC_Fixture.uasset"
        );
        let package = Package::parse(bytes).unwrap();
        let mut reader = Reader::new(bytes);
        reader
            .seek(package.summary.asset_registry_data_offset.get(), "test")
            .unwrap();
        let offset = usize::try_from(reader.read_i64("test").unwrap()).unwrap();
        let mut corrupt = bytes.to_vec();
        corrupt[offset..offset + 4].copy_from_slice(&1_i32.to_le_bytes());
        let error = Package::parse(&corrupt)
            .unwrap()
            .asset_registry_dependencies(&corrupt, "/Game/Fixture/Input/IMC_Fixture")
            .unwrap_err();
        assert_eq!(error.kind(), PackageErrorKind::MalformedData);
    }

    #[test]
    fn bit_arrays_read_whole_words_low_bit_first() {
        let mut bytes = 33_i32.to_le_bytes().to_vec();
        bytes.extend(0x8000_0001_u32.to_le_bytes());
        bytes.extend(1_u32.to_le_bytes());
        let bits = read_bit_array(&mut Reader::new(&bytes), "bits").unwrap();
        assert_eq!(bits.len(), 33);
        assert!(bits[0] && bits[31] && bits[32]);
        assert_eq!(bits.iter().filter(|bit| **bit).count(), 3);
    }

    #[test]
    fn properties_round_trip_unreal_bits() {
        for properties in 0..8 {
            let dependency = PackageDependency::from_properties("/Game/A".into(), properties);
            assert_eq!(dependency.properties(), properties);
        }
        assert_eq!(dependency("/Game/A", true, true).properties(), 3);
    }
}
