//! Package dependency walks over one committed Catalog generation, shared by every adapter.
//!
//! Adapters provide four primitives: the generation's mount points, the package stored at a path,
//! header evidence, and the packages whose dependencies name a target. This module owns package
//! name and path mapping, edge filtering, the walks, and result order, so every adapter answers a
//! dependency query identically. A page recomputes its walk: memory stays bounded by the walk's
//! frontier, and a page never depends on state from an earlier one.
//!
//! Package names compare without regard to ASCII case, as Unreal's names and Windows paths do.

use std::collections::{BTreeSet, HashMap, HashSet};

use super::catalog::{
    CatalogError, EdgeFilter, HeaderEvidence, MountPoint, PROJECT_INDEX_MAX_PAGE_STRINGS,
    QueryItem, QueryKind, ResolvedDependency,
};

/// Storage primitives a dependency walk reads from one committed generation.
pub(crate) trait DependencyGraph {
    /// A stored package. Ordering nodes must order their package paths.
    type Node: Clone + Ord + std::hash::Hash;

    fn mount_points(&self) -> &[MountPoint];

    /// The package stored at exactly this project-relative path, else, when `ignore_case`, the
    /// first package in path order whose path matches it without regard to ASCII case.
    fn package_at(
        &self,
        relative_path: &str,
        ignore_case: bool,
    ) -> Result<Option<Self::Node>, CatalogError>;

    fn package_path(&self, node: &Self::Node) -> String;

    /// Each node's header evidence, in the order given; `None` for an entry without a header.
    fn evidence(&self, nodes: &[Self::Node]) -> Result<Vec<Option<HeaderEvidence>>, CatalogError>;

    /// Packages whose dependencies name any of `package_names`, compared without regard to ASCII
    /// case. Their evidence decides which edges count.
    fn referrers(&self, package_names: &[String]) -> Result<Vec<Self::Node>, CatalogError>;

    /// Packages with any of these exact export classes.
    fn class_members(&self, classes: &[String]) -> Result<HashSet<Self::Node>, CatalogError>;
}

/// Package file extensions in the order a package name resolves to them.
const PACKAGE_EXTENSIONS: [&str; 2] = [".uasset", ".umap"];

/// The package name Unreal mounts a project-relative package file as, for example
/// `/Game/Maps/L_World` for `Content/Maps/L_World.umap`.
pub(crate) fn package_name_for_path(mounts: &[MountPoint], relative_path: &str) -> Option<String> {
    let stem = PACKAGE_EXTENSIONS
        .iter()
        .find_map(|extension| strip_suffix_ignore_ascii_case(relative_path, extension))?;
    mounts
        .iter()
        .filter_map(|mount| {
            strip_prefix_ignore_ascii_case(stem, &mount.path).map(|rest| (mount, rest))
        })
        .max_by_key(|(mount, _)| mount.path.len())
        .filter(|(_, rest)| !rest.is_empty())
        .map(|(mount, rest)| format!("{}{rest}", mount.name))
}

/// The project-relative file stem (without extension) a package name lives at, when a mount
/// holds it.
pub(crate) fn package_stem_for_name(mounts: &[MountPoint], package_name: &str) -> Option<String> {
    mounts
        .iter()
        .filter_map(|mount| {
            strip_prefix_ignore_ascii_case(package_name, &mount.name).map(|rest| (mount, rest))
        })
        .max_by_key(|(mount, _)| mount.name.len())
        .filter(|(_, rest)| !rest.is_empty())
        .map(|(mount, rest)| format!("{}{rest}", mount.path))
}

fn strip_prefix_ignore_ascii_case<'a>(value: &'a str, prefix: &str) -> Option<&'a str> {
    let head = value.get(..prefix.len())?;
    head.eq_ignore_ascii_case(prefix)
        .then(|| &value[prefix.len()..])
}

fn strip_suffix_ignore_ascii_case<'a>(value: &'a str, suffix: &str) -> Option<&'a str> {
    let split = value.len().checked_sub(suffix.len())?;
    let tail = value.get(split..)?;
    tail.eq_ignore_ascii_case(suffix).then(|| &value[..split])
}

/// One page of a dependency or dependents query, in package path order after `after`. A page ends
/// early, with a cursor, before its distinct strings would exceed the dictionary page bound.
pub(crate) fn dependency_page<G: DependencyGraph>(
    graph: &G,
    kind: &QueryKind,
    after: &str,
    limit: usize,
) -> Result<(Vec<QueryItem>, Option<String>), CatalogError> {
    let mut resolver = Resolver::new(graph);
    let selected = match kind {
        QueryKind::Dependencies {
            paths,
            transitive,
            edges,
        } => dependencies(graph, &mut resolver, paths, *transitive, edges)?,
        QueryKind::Dependents {
            paths,
            transitive,
            edges,
            classes,
        } => dependents(graph, paths, *transitive, edges, classes)?,
        _ => {
            return Err(CatalogError::InvalidRequest {
                message: "not a dependency query".into(),
            });
        }
    };
    let mut page = selected
        .into_iter()
        .map(|node| (graph.package_path(&node), node))
        .filter(|(path, _)| path.as_str() > after)
        .take(limit + 1)
        .collect::<Vec<_>>();
    let mut more = page.len() > limit;
    page.truncate(limit);
    let nodes = page.into_iter().map(|(_, node)| node).collect::<Vec<_>>();
    let mut items = package_items(graph, &mut resolver, &nodes)?;
    let kept = within_string_budget(&items, PROJECT_INDEX_MAX_PAGE_STRINGS);
    if kept < items.len() {
        items.truncate(kept);
        more = true;
    }
    let next_cursor = more.then(|| items.last().map(item_path)).flatten();
    Ok((items, next_cursor))
}

fn item_path(item: &QueryItem) -> String {
    match item {
        QueryItem::Package { package_path, .. } => package_path.clone(),
        _ => String::new(),
    }
}

/// How many leading items fit in `budget` distinct page strings (classes, dependency names and
/// resolved paths, as a dictionary page interns them). The first item is always kept: the index's
/// class and dependency limits make one package fit the dictionary bound.
fn within_string_budget(items: &[QueryItem], budget: usize) -> usize {
    let mut strings = HashSet::new();
    for (index, item) in items.iter().enumerate() {
        let QueryItem::Package {
            classes,
            dependencies,
            ..
        } = item
        else {
            continue;
        };
        let added = classes
            .iter()
            .map(String::as_str)
            .chain(dependencies.iter().flat_map(|resolved| {
                std::iter::once(resolved.dependency.package.as_str())
                    .chain(resolved.package_path.as_deref())
            }))
            .filter(|value| !strings.contains(*value))
            .collect::<HashSet<_>>();
        if index > 0 && strings.len() + added.len() > budget {
            return index;
        }
        strings.extend(added);
    }
    items.len()
}

/// Package names resolved to stored packages through the generation's mount points.
struct Resolver<'g, G: DependencyGraph> {
    graph: &'g G,
    resolved: HashMap<String, Option<G::Node>>,
}

impl<'g, G: DependencyGraph> Resolver<'g, G> {
    fn new(graph: &'g G) -> Self {
        Self {
            graph,
            resolved: HashMap::new(),
        }
    }

    fn resolve(&mut self, package_name: &str) -> Result<Option<G::Node>, CatalogError> {
        let key = package_name.to_ascii_lowercase();
        if let Some(node) = self.resolved.get(&key) {
            return Ok(node.clone());
        }
        let mut node = None;
        if let Some(stem) = package_stem_for_name(self.graph.mount_points(), package_name) {
            // Exact paths first: most names match their file's case, and an exact lookup is cheap.
            'resolve: for ignore_case in [false, true] {
                for extension in PACKAGE_EXTENSIONS {
                    node = self
                        .graph
                        .package_at(&format!("{stem}{extension}"), ignore_case)?;
                    if node.is_some() {
                        break 'resolve;
                    }
                }
            }
        }
        self.resolved.insert(key, node.clone());
        Ok(node)
    }
}

fn dependencies<G: DependencyGraph>(
    graph: &G,
    resolver: &mut Resolver<'_, G>,
    paths: &[String],
    transitive: bool,
    edges: &EdgeFilter,
) -> Result<BTreeSet<G::Node>, CatalogError> {
    let mut selected = BTreeSet::new();
    let mut frontier = Vec::new();
    for path in paths {
        if let Some(node) = graph.package_at(path, true)?
            && selected.insert(node.clone())
        {
            frontier.push(node);
        }
    }
    while transitive && !frontier.is_empty() {
        frontier.sort();
        let mut next = Vec::new();
        for header in graph.evidence(&frontier)?.into_iter().flatten() {
            for dependency in &header.dependencies {
                if edges.accepts(dependency)
                    && let Some(target) = resolver.resolve(&dependency.package)?
                    && selected.insert(target.clone())
                {
                    next.push(target);
                }
            }
        }
        frontier = next;
    }
    Ok(selected)
}

fn dependents<G: DependencyGraph>(
    graph: &G,
    paths: &[String],
    transitive: bool,
    edges: &EdgeFilter,
    classes: &[String],
) -> Result<BTreeSet<G::Node>, CatalogError> {
    let mounts = graph.mount_points();
    let mut walked = HashSet::new();
    let mut frontier = paths
        .iter()
        .filter_map(|path| package_name_for_path(mounts, path))
        .filter(|name| walked.insert(name.to_ascii_lowercase()))
        .collect::<Vec<_>>();
    // Referrers already name a frontier package, so only an edge filter needs their evidence.
    let filter_edges = *edges != EdgeFilter::default();
    let members = if classes.is_empty() {
        None
    } else {
        Some(graph.class_members(classes)?)
    };
    let mut selected = BTreeSet::new();
    let mut kept = BTreeSet::new();
    while !frontier.is_empty() {
        let targets = frontier
            .iter()
            .map(|name| name.to_ascii_lowercase())
            .collect::<HashSet<_>>();
        let candidates = graph
            .referrers(&frontier)?
            .into_iter()
            .filter(|node| !selected.contains(node))
            .collect::<BTreeSet<_>>()
            .into_iter()
            .collect::<Vec<_>>();
        let candidates = if filter_edges {
            let evidence = graph.evidence(&candidates)?;
            candidates
                .into_iter()
                .zip(evidence)
                .filter(|(_, header)| {
                    header.as_ref().is_some_and(|header| {
                        header.dependencies.iter().any(|dependency| {
                            edges.accepts(dependency)
                                && targets.contains(&dependency.package.to_ascii_lowercase())
                        })
                    })
                })
                .map(|(node, _)| node)
                .collect()
        } else {
            candidates
        };
        let mut next = Vec::new();
        for node in candidates {
            if !selected.insert(node.clone()) {
                continue;
            }
            if members
                .as_ref()
                .is_none_or(|members| members.contains(&node))
            {
                kept.insert(node.clone());
            }
            if transitive
                && let Some(name) = package_name_for_path(mounts, &graph.package_path(&node))
                && walked.insert(name.to_ascii_lowercase())
            {
                next.push(name);
            }
        }
        frontier = next;
    }
    Ok(kept)
}

fn package_items<G: DependencyGraph>(
    graph: &G,
    resolver: &mut Resolver<'_, G>,
    nodes: &[G::Node],
) -> Result<Vec<QueryItem>, CatalogError> {
    let mounts = graph.mount_points();
    let mut items = Vec::with_capacity(nodes.len());
    for (node, header) in nodes.iter().zip(graph.evidence(nodes)?) {
        let package_path = graph.package_path(node);
        let saved_name = header
            .as_ref()
            .map(|header| header.package_name.clone())
            .filter(|name| !name.is_empty());
        let package_name = package_name_for_path(mounts, &package_path)
            .or(saved_name)
            .unwrap_or_else(|| package_path.clone());
        let (classes, dependencies, failure_code) = match header {
            Some(header) => (header.classes, header.dependencies, header.failure_code),
            None => (Vec::new(), Vec::new(), Some("header_missing".to_owned())),
        };
        let mut resolved = Vec::with_capacity(dependencies.len());
        for dependency in dependencies {
            let package_path = resolver
                .resolve(&dependency.package)?
                .map(|target| graph.package_path(&target));
            resolved.push(ResolvedDependency {
                dependency,
                package_path,
            });
        }
        items.push(QueryItem::Package {
            package_path,
            package_name,
            classes,
            dependencies: resolved,
            failure_code,
        });
    }
    Ok(items)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn mounts() -> Vec<MountPoint> {
        vec![
            MountPoint::game(),
            MountPoint {
                name: "/Black_Eye/".into(),
                path: "Plugins/BlackEye/Content/".into(),
            },
        ]
    }

    #[test]
    fn package_names_and_paths_map_through_mount_points_without_regard_to_case() {
        let mounts = mounts();
        assert_eq!(
            package_name_for_path(&mounts, "Content/Maps/L_World.umap").as_deref(),
            Some("/Game/Maps/L_World")
        );
        assert_eq!(
            package_name_for_path(&mounts, "plugins/blackeye/content/T_Eye.UASSET").as_deref(),
            Some("/Black_Eye/T_Eye")
        );
        assert_eq!(package_name_for_path(&mounts, "Content/A.uexp"), None);
        assert_eq!(package_name_for_path(&mounts, "Config/A.uasset"), None);
        assert_eq!(package_name_for_path(&mounts, "Content/.uasset"), None);
        assert_eq!(
            package_stem_for_name(&mounts, "/game/Maps/L_World").as_deref(),
            Some("Content/Maps/L_World")
        );
        assert_eq!(
            package_stem_for_name(&mounts, "/Black_Eye/T_Eye").as_deref(),
            Some("Plugins/BlackEye/Content/T_Eye")
        );
        assert_eq!(package_stem_for_name(&mounts, "/Script/Engine"), None);
        assert_eq!(package_stem_for_name(&mounts, "/Game/"), None);
    }

    /// Packages `P0000`..: each has its own unresolved dependencies, so pages fill the string budget.
    struct WideGraph {
        mounts: Vec<MountPoint>,
        packages: usize,
        dependencies: usize,
    }

    impl DependencyGraph for WideGraph {
        type Node = usize;
        fn mount_points(&self) -> &[MountPoint] {
            &self.mounts
        }
        fn package_at(&self, path: &str, _: bool) -> Result<Option<usize>, CatalogError> {
            Ok((0..self.packages).find(|node| self.package_path(node) == path))
        }
        fn package_path(&self, node: &usize) -> String {
            format!("Content/P{node:04}.uasset")
        }
        fn evidence(&self, nodes: &[usize]) -> Result<Vec<Option<HeaderEvidence>>, CatalogError> {
            Ok(nodes
                .iter()
                .map(|node| {
                    Some(HeaderEvidence {
                        header_data: None,
                        profile_version: 3,
                        package_name: format!("/Game/P{node:04}"),
                        failure_code: None,
                        classes: vec!["/Script/Engine.Texture2D".into()],
                        serialized_names: Vec::new(),
                        dependencies: (0..self.dependencies)
                            .map(|index| {
                                super::super::catalog::PackageDependency::from_properties(
                                    format!("/Engine/Missing/P{node}_{index}"),
                                    3,
                                )
                            })
                            .collect(),
                    })
                })
                .collect())
        }
        fn referrers(&self, _: &[String]) -> Result<Vec<usize>, CatalogError> {
            Ok(Vec::new())
        }
        fn class_members(&self, _: &[String]) -> Result<HashSet<usize>, CatalogError> {
            Ok(HashSet::new())
        }
    }

    #[test]
    fn dependency_pages_end_before_the_dictionary_string_bound() {
        let graph = WideGraph {
            mounts: mounts(),
            packages: 1100,
            dependencies: 129,
        };
        let paths = (0..graph.packages)
            .map(|node| graph.package_path(&node))
            .collect::<Vec<_>>();
        let kind = QueryKind::Dependencies {
            paths: paths.clone(),
            transitive: false,
            edges: EdgeFilter::default(),
        };
        let (mut after, mut seen, mut pages) = (String::new(), Vec::new(), 0);
        loop {
            let (items, cursor) = dependency_page(&graph, &kind, &after, 1024).unwrap();
            let mut strings = HashSet::new();
            for item in &items {
                let QueryItem::Package {
                    classes,
                    dependencies,
                    package_path,
                    ..
                } = item
                else {
                    panic!("package item");
                };
                strings.extend(classes.iter().cloned());
                strings.extend(dependencies.iter().map(|d| d.dependency.package.clone()));
                assert_eq!(dependencies.len(), 129, "evidence is never truncated");
                seen.push(package_path.clone());
            }
            assert!(strings.len() <= PROJECT_INDEX_MAX_PAGE_STRINGS);
            pages += 1;
            match cursor {
                Some(cursor) => after = cursor,
                None => break,
            }
        }
        assert_eq!(seen, paths, "pages continue without gaps or repeats");
        assert!(pages >= 2);
    }

    #[test]
    fn edge_filters_require_only_the_properties_they_set() {
        use super::super::catalog::PackageDependency;
        let editor_only = PackageDependency::from_properties("/Game/A".into(), 1);
        assert!(EdgeFilter::default().accepts(&editor_only));
        assert!(
            EdgeFilter {
                hard: Some(true),
                ..EdgeFilter::default()
            }
            .accepts(&editor_only)
        );
        assert!(
            !EdgeFilter {
                game: Some(true),
                ..EdgeFilter::default()
            }
            .accepts(&editor_only)
        );
        assert!(
            EdgeFilter {
                game: Some(false),
                build: Some(false),
                ..EdgeFilter::default()
            }
            .accepts(&editor_only)
        );
    }
}
