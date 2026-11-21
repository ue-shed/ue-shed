//! Facts one decode session settles once for its borrowed package.
//!
//! An [`AssetDecodeSession`] borrows its context, and through it the package, for its whole life,
//! so the package's names, summary, imports and exports cannot change while these tables are in
//! use. Every fact here is a pure function of that package, the schemas and an export's class.

use std::collections::HashMap;
use std::hash::{BuildHasherDefault, Hasher};

use super::native_data::{ObjectTailFacts, TailSummary};
use super::{
    AssetDecodeContext, Export, ModeledDispatch, ObjectPath, PackageIndex,
    is_binary_only_export_class, is_blueprint_graph_node_class,
};

/// FNV-1a, for the session's small maps keyed by package indexes. Their keys come from one
/// package's own tables, so a keyed hash buys nothing over a cheap one.
pub(super) struct FnvHasher(u64);

impl Default for FnvHasher {
    fn default() -> Self {
        Self(0xcbf2_9ce4_8422_2325)
    }
}

impl Hasher for FnvHasher {
    fn finish(&self) -> u64 {
        self.0
    }

    fn write(&mut self, bytes: &[u8]) {
        for byte in bytes {
            self.0 ^= u64::from(*byte);
            self.0 = self.0.wrapping_mul(0x0100_0000_01b3);
        }
    }
}

pub(super) type FnvMap<K, V> = HashMap<K, V, BuildHasherDefault<FnvHasher>>;

/// Package-wide facts, computed once per session.
#[derive(Clone, Copy)]
pub(super) struct SummaryFlags {
    /// Some export's class path ends in `Blueprint`. Without one, no export is Blueprint-owned,
    /// so graph membership never needs to walk an outer chain.
    pub(super) has_blueprint_export: bool,
    /// Version facts read by native object tails.
    pub(super) tail: TailSummary,
}

/// Package-only facts for one class path, valid for any schema provider.
#[derive(Clone, Copy)]
struct PackageClassFacts {
    binary_only: bool,
    graph_node_class: bool,
}

/// How exports of one class dispatch, and the native tail facts of their class.
#[derive(Clone, Copy)]
pub(super) struct ClassFacts {
    pub(super) binary_only: bool,
    pub(super) graph_node_class: bool,
    pub(super) modeled: ModeledDispatch,
    pub(super) tail: ObjectTailFacts,
}

// Classes are bounded by the package's import and export tables; this only caps a hostile one.
const MAX_CACHED_CLASSES: usize = 4096;

pub(super) struct SessionTables {
    pub(super) summary: SummaryFlags,
    /// Whether `context.schemas` promised immutable answers for this session's lifetime.
    stable_schemas: bool,
    /// Package-only class facts per class index, with the class path they were computed for.
    package_classes: FnvMap<PackageIndex, (ObjectPath, PackageClassFacts)>,
    /// Full facts per class index, populated only when `stable_schemas` is true.
    classes: FnvMap<PackageIndex, (ObjectPath, ClassFacts)>,
    /// One flag per package name for the parser's own reads; only filtered decodes ask.
    pub(super) decoder_read_names: Option<Vec<bool>>,
}

impl SessionTables {
    pub(super) fn new(context: &AssetDecodeContext<'_>) -> Self {
        let package = context.package;
        Self {
            summary: SummaryFlags {
                has_blueprint_export: package.exports.iter().any(|export| {
                    export
                        .class_path
                        .as_ref()
                        .is_some_and(|class| class.as_str().ends_with("Blueprint"))
                }),
                tail: TailSummary::of(package),
            },
            stable_schemas: context.schemas.has_stable_schemas(),
            package_classes: FnvMap::default(),
            classes: FnvMap::default(),
            decoder_read_names: context
                .property_filter
                .map(|_| crate::codec::decoder_read_name_table(package)),
        }
    }

    /// The facts of `export`'s class. An export whose class path differs from the one cached
    /// for its class index (possible only for exports built outside the package) is answered
    /// without the cache. Schema-derived facts are cached only when the provider promises
    /// immutable schemas for the session.
    pub(super) fn class_facts(
        &mut self,
        export: &Export,
        class_path: &ObjectPath,
        context: &AssetDecodeContext<'_>,
    ) -> ClassFacts {
        if self.stable_schemas {
            if let Some((cached_path, facts)) = self.classes.get(&export.class_index) {
                if cached_path == class_path {
                    return *facts;
                }
                return self.compute(export, class_path, context);
            }
            let facts = self.compute(export, class_path, context);
            if self.classes.len() < MAX_CACHED_CLASSES {
                self.classes
                    .insert(export.class_index, (class_path.clone(), facts));
            }
            return facts;
        }
        let package_facts =
            if let Some((cached_path, facts)) = self.package_classes.get(&export.class_index) {
                if cached_path == class_path {
                    *facts
                } else {
                    Self::compute_package_facts(class_path)
                }
            } else {
                let facts = Self::compute_package_facts(class_path);
                if self.package_classes.len() < MAX_CACHED_CLASSES {
                    self.package_classes
                        .insert(export.class_index, (class_path.clone(), facts));
                }
                facts
            };
        ClassFacts {
            binary_only: package_facts.binary_only,
            graph_node_class: package_facts.graph_node_class,
            modeled: ModeledDispatch::of(context.schemas, class_path),
            tail: ObjectTailFacts::of(export, context, self.summary.tail),
        }
    }

    fn compute_package_facts(class_path: &ObjectPath) -> PackageClassFacts {
        PackageClassFacts {
            binary_only: is_binary_only_export_class(class_path.as_str()),
            graph_node_class: is_blueprint_graph_node_class(class_path.as_str()),
        }
    }

    fn compute(
        &self,
        export: &Export,
        class_path: &ObjectPath,
        context: &AssetDecodeContext<'_>,
    ) -> ClassFacts {
        let package_facts = Self::compute_package_facts(class_path);
        ClassFacts {
            binary_only: package_facts.binary_only,
            graph_node_class: package_facts.graph_node_class,
            modeled: ModeledDispatch::of(context.schemas, class_path),
            tail: ObjectTailFacts::of(export, context, self.summary.tail),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::hash::BuildHasher;

    #[test]
    fn fnv_matches_the_published_vectors_and_separates_package_indexes() {
        let hash = |bytes: &[u8]| {
            let mut hasher = FnvHasher::default();
            hasher.write(bytes);
            hasher.finish()
        };
        assert_eq!(hash(b""), 0xcbf2_9ce4_8422_2325);
        assert_eq!(hash(b"a"), 0xaf63_dc4c_8601_ec8c);
        assert_eq!(hash(b"foobar"), 0x8594_4171_f739_67e8);
        let build = BuildHasherDefault::<FnvHasher>::default();
        let index = |index: PackageIndex| build.hash_one(index);
        assert_ne!(
            index(PackageIndex::from_raw(1)),
            index(PackageIndex::from_raw(-1))
        );
        assert_ne!(
            index(PackageIndex::from_raw(0)),
            index(PackageIndex::from_raw(1))
        );
    }
}
