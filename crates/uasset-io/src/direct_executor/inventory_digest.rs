//! The canonical inventory digest: one SHA-256 fingerprint of every fact an inventory query returns
//! (each package path, its bundle stamps and its header data), so a host can tell whether a
//! generation's inventory changed without paging through it.
//!
//! Each package contributes a leaf, the SHA-256 of its canonical facts. Leaves are summed as 256-bit
//! little-endian integers (wrapping), so a refresh that touches a few packages updates the sum by
//! subtracting their old leaves and adding their new ones instead of rereading every package. The
//! digest is the SHA-256 of the package count and that sum. It depends only on the facts: the same
//! inventory gives the same digest however its generations were written.

use sha2::{Digest, Sha256};
use uasset_inspection::package_header::PackageHeaderData;

const LEAF_DOMAIN: &[u8] = b"ue-shed.project-index.inventory-leaf.v1\0";
const DIGEST_DOMAIN: &[u8] = b"ue-shed.project-index.inventory-digest.v1\0";

/// Sidecar extensions a bundle signature carries, in its order after the package's own stamp.
pub(crate) const BUNDLE_SIDECARS: [&str; 3] = ["uexp", "ubulk", "uptnl"];

/// A package's own stamp, then its `.uexp`, `.ubulk` and `.uptnl` stamps: (size, modified ns).
pub(crate) type BundleParts = [Option<(u64, u64)>; 4];

/// One package's leaf: the SHA-256 of its path, bundle stamps and header data.
pub(crate) fn inventory_leaf(
    path: &str,
    parts: &BundleParts,
    header: Option<&PackageHeaderData>,
) -> [u8; 32] {
    let mut hasher = Sha256::new();
    hasher.update(LEAF_DOMAIN);
    hasher.update((path.len() as u64).to_le_bytes());
    hasher.update(path.as_bytes());
    for part in parts {
        match part {
            Some((size, modified)) => {
                hasher.update([1]);
                hasher.update(size.to_le_bytes());
                hasher.update(modified.to_le_bytes());
            }
            None => hasher.update([0]),
        }
    }
    match header {
        Some(data) => {
            hasher.update([1]);
            hasher.update(data.package_flags.to_le_bytes());
            hasher.update(data.gatherable_text_data_count.to_le_bytes());
            hasher.update(data.gatherable_text_data_offset.to_le_bytes());
            hasher.update([u8::from(data.has_text_property)]);
        }
        None => hasher.update([0]),
    }
    hasher.finalize().into()
}

/// The wrapping 256-bit sum of package leaves.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub(crate) struct InventorySum([u64; 4]);

impl InventorySum {
    fn limbs(leaf: &[u8; 32]) -> [u64; 4] {
        let mut limbs = [0; 4];
        for (limb, bytes) in limbs.iter_mut().zip(leaf.as_chunks::<8>().0) {
            *limb = u64::from_le_bytes(*bytes);
        }
        limbs
    }

    pub(crate) fn add(&mut self, leaf: &[u8; 32]) {
        let mut carry = false;
        for (limb, value) in self.0.iter_mut().zip(Self::limbs(leaf)) {
            let (sum, first) = limb.overflowing_add(value);
            let (sum, second) = sum.overflowing_add(u64::from(carry));
            *limb = sum;
            carry = first || second;
        }
    }

    pub(crate) fn subtract(&mut self, leaf: &[u8; 32]) {
        let mut borrow = false;
        for (limb, value) in self.0.iter_mut().zip(Self::limbs(leaf)) {
            let (difference, first) = limb.overflowing_sub(value);
            let (difference, second) = difference.overflowing_sub(u64::from(borrow));
            *limb = difference;
            borrow = first || second;
        }
    }

    /// Adds every leaf of `other`.
    pub(crate) fn absorb(&mut self, other: &Self) {
        let mut bytes = [0; 32];
        for (chunk, limb) in bytes.as_chunks_mut::<8>().0.iter_mut().zip(other.0) {
            *chunk = limb.to_le_bytes();
        }
        self.add(&bytes);
    }

    /// Removes every leaf of `other`.
    pub(crate) fn remove(&mut self, other: &Self) {
        let mut bytes = [0; 32];
        for (chunk, limb) in bytes.as_chunks_mut::<8>().0.iter_mut().zip(other.0) {
            *chunk = limb.to_le_bytes();
        }
        self.subtract(&bytes);
    }

    /// Lowercase hex of the sum's 32 little-endian bytes.
    pub(crate) fn to_hex(self) -> String {
        let mut out = String::with_capacity(64);
        for limb in self.0 {
            for byte in limb.to_le_bytes() {
                out.push_str(&format!("{byte:02x}"));
            }
        }
        out
    }

    pub(crate) fn from_hex(value: &str) -> Option<Self> {
        if value.len() != 64 || !value.bytes().all(|byte| byte.is_ascii_hexdigit()) {
            return None;
        }
        let mut limbs = [0; 4];
        for (index, limb) in limbs.iter_mut().enumerate() {
            let mut bytes = [0; 8];
            for (offset, byte) in bytes.iter_mut().enumerate() {
                let at = (index * 8 + offset) * 2;
                *byte = u8::from_str_radix(value.get(at..at + 2)?, 16).ok()?;
            }
            *limb = u64::from_le_bytes(bytes);
        }
        Some(Self(limbs))
    }

    /// The inventory digest of `packages` packages whose leaves sum to this: lowercase hex SHA-256.
    pub(crate) fn digest(&self, packages: u64) -> String {
        let mut hasher = Sha256::new();
        hasher.update(DIGEST_DOMAIN);
        hasher.update(packages.to_le_bytes());
        for limb in self.0 {
            hasher.update(limb.to_le_bytes());
        }
        hasher
            .finalize()
            .iter()
            .map(|byte| format!("{byte:02x}"))
            .collect()
    }
}

/// Where a path sits in a bundle: the stem it shares with its package and sidecars, and which
/// bundle part it is. A package's stem is its path without its last extension; a sidecar belongs
/// to the packages with exactly its stem.
pub(crate) fn bundle_stem(path: &str) -> Option<&str> {
    path.rsplit_once('.').map(|(stem, _)| stem)
}

fn sidecar_slot(path: &str) -> Option<usize> {
    let (_, extension) = path.rsplit_once('.')?;
    BUNDLE_SIDECARS
        .iter()
        .position(|sidecar| *sidecar == extension)
}

/// The leaves of the packages whose stem is exactly `stem`, from entries that include every entry
/// whose path starts with `stem.` (others are ignored): each entry's path, whether it is a
/// package, its stamp and its header data.
pub(crate) fn stem_sum<'a>(
    stem: &str,
    entries: impl IntoIterator<Item = (&'a str, bool, (u64, u64), Option<&'a PackageHeaderData>)>,
) -> InventorySum {
    let mut packages = Vec::new();
    let mut sidecars = [None; 3];
    for (path, package, stamp, header) in entries {
        if bundle_stem(path) != Some(stem) {
            continue;
        }
        if package {
            packages.push((path, stamp, header));
        } else if let Some(slot) = sidecar_slot(path) {
            sidecars[slot] = Some(stamp);
        }
    }
    let mut sum = InventorySum::default();
    for (path, stamp, header) in packages {
        let parts = [Some(stamp), sidecars[0], sidecars[1], sidecars[2]];
        sum.add(&inventory_leaf(path, &parts, header));
    }
    sum
}

/// Package bundles whose entries are still arriving: every entry whose path starts with `stem.`
/// lies in one contiguous run of path order, so each open bundle closes at the first path outside
/// its run. Nested stems (`A` and `A.b`) nest their runs, so the open bundles form a stack.
struct OpenBundle {
    stem: String,
    packages: Vec<(String, (u64, u64), Option<PackageHeaderData>)>,
    sidecars: [Option<(u64, u64)>; 3],
}

/// Sums package leaves over entries arriving in strictly increasing path order, as a snapshot
/// writer sees them, holding only the bundles whose runs are still open.
#[derive(Default)]
pub(crate) struct BundleWalker {
    open: Vec<OpenBundle>,
    sum: InventorySum,
}

impl BundleWalker {
    pub(crate) fn push(
        &mut self,
        path: &str,
        package: bool,
        stamp: (u64, u64),
        header: Option<&PackageHeaderData>,
    ) {
        while let Some(top) = self.open.last() {
            let inside = path.len() > top.stem.len()
                && path.starts_with(top.stem.as_str())
                && path.as_bytes()[top.stem.len()] == b'.';
            if inside {
                break;
            }
            if let Some(bundle) = self.open.pop() {
                self.close(bundle);
            }
        }
        let Some(stem) = bundle_stem(path) else {
            return;
        };
        let slot = sidecar_slot(path);
        if !package && slot.is_none() {
            return;
        }
        // Every open stem prefixes `path`, and `stem` is the longest stem that can, so it is
        // either the innermost open bundle or a new one inside it.
        if self.open.last().is_none_or(|top| top.stem != stem) {
            self.open.push(OpenBundle {
                stem: stem.to_owned(),
                packages: Vec::new(),
                sidecars: [None; 3],
            });
        }
        let Some(bundle) = self.open.last_mut() else {
            return;
        };
        if package {
            bundle
                .packages
                .push((path.to_owned(), stamp, header.cloned()));
        } else if let Some(slot) = slot {
            bundle.sidecars[slot] = Some(stamp);
        }
    }

    fn close(&mut self, bundle: OpenBundle) {
        for (path, stamp, header) in &bundle.packages {
            let parts = [
                Some(*stamp),
                bundle.sidecars[0],
                bundle.sidecars[1],
                bundle.sidecars[2],
            ];
            self.sum.add(&inventory_leaf(path, &parts, header.as_ref()));
        }
    }

    pub(crate) fn finish(mut self) -> InventorySum {
        while let Some(bundle) = self.open.pop() {
            self.close(bundle);
        }
        self.sum
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn data(flags: u32) -> PackageHeaderData {
        PackageHeaderData {
            package_flags: flags,
            gatherable_text_data_count: 1,
            gatherable_text_data_offset: 2,
            has_text_property: true,
        }
    }

    /// An entry: its path, whether it is a package, its stamp and its header flags.
    type Entry<'a> = (&'a str, bool, (u64, u64), Option<u32>);

    /// Entries in path order.
    fn walk(entries: &[Entry<'_>]) -> InventorySum {
        let mut walker = BundleWalker::default();
        for (path, package, stamp, flags) in entries {
            walker.push(path, *package, *stamp, flags.map(data).as_ref());
        }
        walker.finish()
    }

    /// The reference: each package's parts found by exact path lookup, as an inventory page does.
    fn reference(entries: &[Entry<'_>]) -> InventorySum {
        let mut sum = InventorySum::default();
        for (path, package, stamp, flags) in entries {
            if !package {
                continue;
            }
            let stem = bundle_stem(path).unwrap_or(path);
            let find = |extension: &str| {
                entries
                    .iter()
                    .find(|entry| entry.0 == format!("{stem}.{extension}"))
                    .map(|entry| entry.2)
            };
            let parts = [Some(*stamp), find("uexp"), find("ubulk"), find("uptnl")];
            sum.add(&inventory_leaf(path, &parts, flags.map(data).as_ref()));
        }
        sum
    }

    #[test]
    fn the_walker_matches_exact_lookups_across_nested_and_shared_stems() {
        let mut entries = vec![
            ("Content/A.b.uasset", true, (1, 1), Some(1)),
            ("Content/A.b.uexp", false, (2, 2), None),
            ("Content/A.ubulk", false, (3, 3), None),
            ("Content/A.uasset", true, (4, 4), None),
            ("Content/A.umap", true, (5, 5), Some(2)),
            ("Content/A.uexp", false, (6, 6), None),
            ("Content/A.uptnl", false, (7, 7), None),
            ("Content/AB.uasset", true, (8, 8), Some(3)),
            ("Content/Dir.x/C.uasset", true, (9, 9), None),
            ("Content/Orphan.uexp", false, (10, 10), None),
            ("Content/Z.UEXP", false, (11, 11), None),
            ("Content/Z.uasset", true, (12, 12), None),
        ];
        entries.sort_by(|a, b| a.0.cmp(b.0));
        assert_eq!(walk(&entries), reference(&entries));
        // Order-independent and incremental: removing a bundle's leaves and adding them back.
        let mut sum = walk(&entries);
        let with_headers = entries
            .iter()
            .map(|(path, package, stamp, flags)| (*path, *package, *stamp, flags.map(data)))
            .collect::<Vec<_>>();
        let bundle = stem_sum(
            "Content/A",
            with_headers
                .iter()
                .map(|(path, package, stamp, header)| (*path, *package, *stamp, header.as_ref())),
        );
        sum.remove(&bundle);
        let without = entries
            .iter()
            .filter(|entry| bundle_stem(entry.0) != Some("Content/A"))
            .copied()
            .collect::<Vec<_>>();
        assert_eq!(sum, walk(&without));
        sum.absorb(&bundle);
        assert_eq!(sum, walk(&entries));
    }

    #[test]
    fn digests_depend_on_every_fact_and_round_trip_their_sum() {
        let base = [("Content/A.uasset", true, (1, 1), Some(1))];
        let digest = |entries: &[Entry<'_>]| {
            walk(entries).digest(entries.iter().filter(|entry| entry.1).count() as u64)
        };
        let reference = digest(&base);
        assert_eq!(reference.len(), 64);
        for changed in [
            vec![("Content/B.uasset", true, (1, 1), Some(1))],
            vec![("Content/A.uasset", true, (2, 1), Some(1))],
            vec![("Content/A.uasset", true, (1, 2), Some(1))],
            vec![("Content/A.uasset", true, (1, 1), Some(2))],
            vec![("Content/A.uasset", true, (1, 1), None)],
            vec![
                ("Content/A.uasset", true, (1, 1), Some(1)),
                ("Content/A.uexp", false, (1, 1), None),
            ],
        ] {
            assert_ne!(digest(&changed), reference, "{changed:?}");
        }
        let sum = walk(&base);
        assert_eq!(InventorySum::from_hex(&sum.to_hex()), Some(sum));
        assert_eq!(InventorySum::from_hex("zz"), None);
        let mut wrapped = InventorySum([u64::MAX; 4]);
        let mut one = [0; 32];
        one[0] = 1;
        wrapped.add(&one);
        assert_eq!(wrapped, InventorySum::default());
        wrapped.subtract(&one);
        assert_eq!(wrapped, InventorySum([u64::MAX; 4]));
    }
}
