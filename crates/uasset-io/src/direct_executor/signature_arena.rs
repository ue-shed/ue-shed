//! Package and sidecar signatures as a walk lists them, held in a few large allocations.
//!
//! A walk of a large project lists close to a million entries in a few hundred thousand
//! directories. Each directory's path is stored once and each entry keeps only its file name, both
//! in shared text chunks, and each entry is one fixed-size row; so the inventory costs its
//! directories' and names' text plus 32 bytes an entry instead of a heap string (or even a whole
//! path) per entry, and freeing it hands back a few large blocks. Paths are compared as their two
//! parts, without joining them.

use std::borrow::Cow;
use std::cmp::Ordering;
use std::fmt;

use super::catalog::{EntryKind, PackageSignature};

/// Text chunks fill to this size; a longer text gets a chunk of its own.
const CHUNK_BYTES: usize = 256 * 1024;
/// Rows a block holds. Rows grow a block at a time and are never moved, so a long walk leaves no
/// outgrown row buffers behind.
const BLOCK_ROWS: usize = 4096;
/// Directories a block holds: a block takes exactly as many bytes as a block of rows. The
/// allocator commits memory for each allocation size a thread uses, so every walker thread taking
/// a new size would commit far more than the directories need.
const BLOCK_DIRECTORIES: usize =
    BLOCK_ROWS * std::mem::size_of::<Row>() / std::mem::size_of::<Directory>();
const _: () = assert!(
    BLOCK_DIRECTORIES * std::mem::size_of::<Directory>() == BLOCK_ROWS * std::mem::size_of::<Row>()
);

/// Where a directory's path is: its chunk, start and length. Aligned to 16 bytes so a block of
/// directories is exactly as large as a block of rows.
#[derive(Clone, Copy, Debug)]
#[repr(align(16))]
struct Directory {
    chunk: u32,
    start: u32,
    len: u32,
}

/// One entry: its directory, where its name is, and its signature.
#[derive(Clone, Copy, Debug)]
struct Row {
    chunk: u32,
    start: u32,
    directory: u32,
    len: u16,
    kind: EntryKind,
    size: u64,
    modified_nanos: u64,
}

/// A path held as two parts, `head` then `tail`: an entry's directory (with its trailing `/`) and
/// its file name. It orders, compares and prints as the joined path does.
#[derive(Clone, Copy, Debug)]
pub(crate) struct SplitPath<'a> {
    pub(crate) head: &'a str,
    pub(crate) tail: &'a str,
}

impl<'a> SplitPath<'a> {
    /// What follows `prefix` in the joined path, when it starts with `prefix`.
    pub(crate) fn strip_prefix(&self, prefix: &str) -> Option<Cow<'a, str>> {
        if prefix.len() >= self.head.len() {
            let (head, tail) = prefix.split_at_checked(self.head.len())?;
            (head == self.head)
                .then(|| self.tail.strip_prefix(tail).map(Cow::Borrowed))
                .flatten()
        } else {
            let rest = self.head.strip_prefix(prefix)?;
            Some(Cow::Owned(format!("{rest}{}", self.tail)))
        }
    }

    /// Orders this path against `other` as `str` orders the joined paths.
    pub(crate) fn cmp_str(&self, other: &str) -> Ordering {
        cmp_parts(
            [self.head.as_bytes(), self.tail.as_bytes()],
            [other.as_bytes(), b""],
        )
    }

    pub(crate) fn cmp_path(&self, other: &SplitPath<'_>) -> Ordering {
        cmp_parts(
            [self.head.as_bytes(), self.tail.as_bytes()],
            [other.head.as_bytes(), other.tail.as_bytes()],
        )
    }

    pub(crate) fn eq_str(&self, other: &str) -> bool {
        other.len() == self.head.len() + self.tail.len()
            && other.starts_with(self.head)
            && other.ends_with(self.tail)
    }

    /// Whether the joined path ends with `suffix`, ignoring ASCII case.
    pub(crate) fn ends_with_ignore_ascii_case(&self, suffix: &str) -> bool {
        let suffix = suffix.as_bytes();
        let tail = self.tail.as_bytes();
        if tail.len() >= suffix.len() {
            return tail[tail.len() - suffix.len()..].eq_ignore_ascii_case(suffix);
        }
        let head = self.head.as_bytes();
        let from_head = suffix.len() - tail.len();
        head.len() >= from_head
            && head[head.len() - from_head..].eq_ignore_ascii_case(&suffix[..from_head])
            && tail.eq_ignore_ascii_case(&suffix[from_head..])
    }
}

impl fmt::Display for SplitPath<'_> {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(self.head)?;
        f.write_str(self.tail)
    }
}

/// Orders two byte strings, each given as two consecutive parts, as their concatenations order.
fn cmp_parts(a: [&[u8]; 2], b: [&[u8]; 2]) -> Ordering {
    let (mut a_next, mut b_next) = (1, 1);
    let (mut a_rest, mut b_rest) = (a[0], b[0]);
    loop {
        if a_rest.is_empty() && a_next < 2 {
            a_rest = a[a_next];
            a_next += 1;
            continue;
        }
        if b_rest.is_empty() && b_next < 2 {
            b_rest = b[b_next];
            b_next += 1;
            continue;
        }
        match (a_rest.is_empty(), b_rest.is_empty()) {
            (true, true) => return Ordering::Equal,
            (true, false) => return Ordering::Less,
            (false, true) => return Ordering::Greater,
            (false, false) => {}
        }
        let common = a_rest.len().min(b_rest.len());
        match a_rest[..common].cmp(&b_rest[..common]) {
            Ordering::Equal => {
                a_rest = &a_rest[common..];
                b_rest = &b_rest[common..];
            }
            order => return order,
        }
    }
}

/// Signatures by index, each path borrowed from the arena's text as its directory and name.
/// Entries keep the order they were pushed in until [`SignatureArena::sort_by_path`], which orders
/// an index of them rather than moving any.
#[derive(Clone, Debug, Default)]
pub(crate) struct SignatureArena {
    chunks: Vec<String>,
    directories: Vec<Vec<Directory>>,
    directory_count: usize,
    blocks: Vec<Vec<Row>>,
    len: usize,
    /// Pushed entries by position, once sorted; positions are push order until then.
    order: Option<Vec<u32>>,
    /// Whether some directory path does not end with `/` or some name holds a `/`, so that paths
    /// cannot be ordered a directory at a time (see [`SignatureArena::sort_by_path`]).
    irregular: bool,
}

impl SignatureArena {
    pub(crate) fn len(&self) -> usize {
        self.len
    }

    #[cfg(test)]
    pub(crate) fn is_empty(&self) -> bool {
        self.len == 0
    }

    /// Stores `parts` joined, with every `\` written as `/`; returns its chunk and start.
    fn store(&mut self, parts: &[&str]) -> (u32, u32) {
        let len = parts.iter().map(|part| part.len()).sum::<usize>();
        let fits = self
            .chunks
            .last()
            .is_some_and(|chunk| chunk.capacity() - chunk.len() >= len);
        if !fits {
            self.chunks
                .push(String::with_capacity(CHUNK_BYTES.max(len)));
        }
        let chunk_index = self.chunks.len() - 1;
        let chunk = &mut self.chunks[chunk_index];
        let start = chunk.len();
        for part in parts {
            if part.contains('\\') {
                for (index, piece) in part.split('\\').enumerate() {
                    if index > 0 {
                        chunk.push('/');
                    }
                    chunk.push_str(piece);
                }
            } else {
                chunk.push_str(part);
            }
        }
        (index_u32(chunk_index), index_u32(start))
    }

    /// Stores a directory's path (its entries' common prefix, `/`-separated and ending in `/`)
    /// for the entries pushed with [`SignatureArena::push_named`]; returns its id.
    pub(crate) fn directory(&mut self, prefix: &str) -> u32 {
        self.irregular |= !prefix.is_empty() && !prefix.ends_with(['/', '\\']);
        let (chunk, start) = self.store(&[prefix]);
        push_block(
            &mut self.directories,
            BLOCK_DIRECTORIES,
            Directory {
                chunk,
                start,
                len: index_u32(prefix.len()),
            },
        );
        self.directory_count += 1;
        index_u32(self.directory_count - 1)
    }

    /// Appends an entry named `name` in `directory`, with every `\` in it written as `/`.
    pub(crate) fn push_named(
        &mut self,
        directory: u32,
        name: &str,
        kind: EntryKind,
        size: u64,
        modified_nanos: u64,
    ) {
        self.irregular |= name.contains(['/', '\\']);
        // No file name comes near the limit; a longer one moves its head into a directory.
        if let Ok(len) = u16::try_from(name.len()) {
            let (chunk, start) = self.store(&[name]);
            self.push_row(Row {
                chunk,
                start,
                directory,
                len,
                kind,
                size,
                modified_nanos,
            });
            return;
        }
        let mut split = name.len() - usize::from(u16::MAX);
        while !name.is_char_boundary(split) {
            split += 1;
        }
        let head = format!("{}{}", self.directory_text(directory), &name[..split]);
        let directory = self.directory(&head.replace('\\', "/"));
        self.push_named(directory, &name[split..], kind, size, modified_nanos);
    }

    fn push_row(&mut self, row: Row) {
        push_block(&mut self.blocks, BLOCK_ROWS, row);
        if let Some(order) = &mut self.order {
            order.push(index_u32(self.len));
        }
        self.len += 1;
    }

    /// Appends an entry whose path is `parts` joined, with every `\` written as `/`.
    pub(crate) fn push(&mut self, parts: &[&str], kind: EntryKind, size: u64, modified_nanos: u64) {
        let path = parts.concat().replace('\\', "/");
        let split = path.rfind('/').map_or(0, |slash| slash + 1);
        let directory = self.directory(&path[..split]);
        self.push_named(directory, &path[split..], kind, size, modified_nanos);
    }

    /// Appends a signature as it is.
    pub(crate) fn push_signature(&mut self, signature: &PackageSignature) {
        self.push(
            &[&signature.relative_path],
            signature.kind,
            signature.size,
            signature.modified_nanos,
        );
    }

    /// Moves the entries of `other` (an unsorted arena) after this unsorted arena's, without
    /// copying their text. Only the last block of each may be partly full, so a part-full block
    /// of this arena's is topped up first.
    pub(crate) fn append(&mut self, other: Self) {
        debug_assert!(self.order.is_none() && other.order.is_none());
        let shift = index_u32(self.chunks.len());
        let directory_shift = index_u32(self.directory_count);
        self.chunks.extend(other.chunks);
        let mut directories = other.directories;
        for directory in directories.iter_mut().flatten() {
            directory.chunk += shift;
        }
        append_blocks(&mut self.directories, BLOCK_DIRECTORIES, directories);
        self.directory_count += other.directory_count;
        let mut blocks = other.blocks;
        for row in blocks.iter_mut().flatten() {
            row.chunk += shift;
            row.directory += directory_shift;
        }
        append_blocks(&mut self.blocks, BLOCK_ROWS, blocks);
        self.len += other.len;
        self.irregular |= other.irregular;
    }

    fn row(&self, index: usize) -> &Row {
        let slot = self
            .order
            .as_ref()
            .map_or(index, |order| order[index] as usize);
        &self.blocks[slot / BLOCK_ROWS][slot % BLOCK_ROWS]
    }

    fn directory_text(&self, directory: u32) -> &str {
        let directory = directory as usize;
        let directory =
            self.directories[directory / BLOCK_DIRECTORIES][directory % BLOCK_DIRECTORIES];
        let start = directory.start as usize;
        &self.chunks[directory.chunk as usize][start..start + directory.len as usize]
    }

    fn row_path(&self, row: &Row) -> SplitPath<'_> {
        let start = row.start as usize;
        SplitPath {
            head: self.directory_text(row.directory),
            tail: &self.chunks[row.chunk as usize][start..start + usize::from(row.len)],
        }
    }

    /// Entry `index`'s path, as its directory and name.
    pub(crate) fn path(&self, index: usize) -> SplitPath<'_> {
        self.row_path(self.row(index))
    }

    /// Orders entry `index`'s path against `other`.
    pub(crate) fn cmp_path(&self, index: usize, other: &str) -> Ordering {
        self.path(index).cmp_str(other)
    }

    pub(crate) fn kind(&self, index: usize) -> EntryKind {
        self.row(index).kind
    }

    pub(crate) fn size(&self, index: usize) -> u64 {
        self.row(index).size
    }

    pub(crate) fn modified_nanos(&self, index: usize) -> u64 {
        self.row(index).modified_nanos
    }

    /// Entry `index` as an owned signature.
    pub(crate) fn signature(&self, index: usize) -> PackageSignature {
        let row = self.row(index);
        PackageSignature {
            relative_path: self.row_path(row).to_string(),
            kind: row.kind,
            size: row.size,
            modified_nanos: row.modified_nanos,
        }
    }

    /// Orders two rows by path; rows of one directory compare their names alone.
    fn cmp_rows(&self, a: &Row, b: &Row) -> Ordering {
        if a.directory == b.directory {
            let (a, b) = (self.row_path(a), self.row_path(b));
            return a.tail.cmp(b.tail);
        }
        self.row_path(a).cmp_path(&self.row_path(b))
    }

    /// Orders the entries by path (byte order, as `str` compares; entries with equal paths keep
    /// their order), unless they already are.
    pub(crate) fn sort_by_path(&mut self) {
        if (1..self.len).all(|index| self.cmp_rows(self.row(index - 1), self.row(index)).is_le()) {
            return;
        }
        let order = if self.irregular {
            self.order_by_comparing()
        } else {
            self.order_by_directory()
        };
        self.order = Some(order);
    }

    /// The entries' order found a directory at a time, in a few passes rather than by comparing
    /// paths: directories are sorted by path (equal paths are one directory), each directory's
    /// entries by name, and then each directory's entries are placed among its subdirectories'.
    /// Every directory path ends with `/` and no name holds one, so an entry sorts before a
    /// subdirectory's whole subtree exactly when its name sorts before the subdirectory's path
    /// relative to the entry's directory.
    fn order_by_directory(&self) -> Vec<u32> {
        let count = self.directory_count;
        let mut by_path = (0..index_u32(count)).collect::<Vec<_>>();
        by_path.sort_unstable_by(|a, b| self.directory_text(*a).cmp(self.directory_text(*b)));
        let mut ranks = vec![0_u32; count];
        // One directory of each distinct path, by rank.
        let mut distinct: Vec<u32> = Vec::with_capacity(count);
        for directory in &by_path {
            let text = self.directory_text(*directory);
            if distinct
                .last()
                .is_none_or(|last| self.directory_text(*last) != text)
            {
                distinct.push(*directory);
            }
            ranks[*directory as usize] = index_u32(distinct.len() - 1);
        }
        drop(by_path);
        // Entries by directory rank, then each directory's by name (and push order).
        let blocks = &self.blocks;
        let row = |slot: u32| {
            let slot = slot as usize;
            &blocks[slot / BLOCK_ROWS][slot % BLOCK_ROWS]
        };
        let mut keys = (0..index_u32(self.len))
            .map(|slot| u64::from(ranks[row(slot).directory as usize]) << 32 | u64::from(slot))
            .collect::<Vec<_>>();
        keys.sort_unstable();
        let name = |key: u64| self.row_path(row(key as u32)).tail;
        let mut groups = vec![0..0; distinct.len()];
        let mut start = 0;
        for group in keys.chunk_by_mut(|a, b| a >> 32 == b >> 32) {
            if group.len() > 1 {
                group.sort_unstable_by(|a, b| name(*a).cmp(name(*b)).then(a.cmp(b)));
            }
            groups[(group[0] >> 32) as usize] = start..start + group.len();
            start += group.len();
        }
        // Directories in path order: each one's subtree follows it. On reaching a directory, the
        // directories it is not inside are finished, and the directory it is in places its
        // entries that sort before it.
        let mut order = Vec::with_capacity(self.len);
        let mut open: Vec<(usize, std::ops::Range<usize>)> = Vec::new();
        for (rank, directory) in distinct.iter().enumerate() {
            let path = self.directory_text(*directory);
            while let Some((outer, rest)) = open.last_mut() {
                let outer_path = self.directory_text(distinct[*outer]);
                if let Some(relative) = path.strip_prefix(outer_path) {
                    while rest.start < rest.end && name(keys[rest.start]) < relative {
                        order.push(keys[rest.start] as u32);
                        rest.start += 1;
                    }
                    break;
                }
                order.extend(keys[rest.clone()].iter().map(|key| *key as u32));
                open.pop();
            }
            open.push((rank, groups[rank].clone()));
        }
        while let Some((_, rest)) = open.pop() {
            order.extend(keys[rest].iter().map(|key| *key as u32));
        }
        order
    }

    /// The entries' order found by comparing their paths, for any directories and names.
    fn order_by_comparing(&mut self) -> Vec<u32> {
        let mut order = match self.order.take() {
            Some(order) => order,
            None => (0..index_u32(self.len)).collect::<Vec<_>>(),
        };
        let blocks = &self.blocks;
        let row = |slot: u32| {
            let slot = slot as usize;
            &blocks[slot / BLOCK_ROWS][slot % BLOCK_ROWS]
        };
        order.sort_unstable_by(|&a, &b| self.cmp_rows(row(a), row(b)).then(a.cmp(&b)));
        order
    }

    /// Every entry as an owned signature, in order.
    #[cfg(test)]
    pub(crate) fn to_signatures(&self) -> Vec<PackageSignature> {
        (0..self.len()).map(|index| self.signature(index)).collect()
    }
}

impl FromIterator<PackageSignature> for SignatureArena {
    fn from_iter<I: IntoIterator<Item = PackageSignature>>(signatures: I) -> Self {
        let mut arena = Self::default();
        for signature in signatures {
            arena.push_signature(&signature);
        }
        arena
    }
}

impl<'a> FromIterator<&'a PackageSignature> for SignatureArena {
    fn from_iter<I: IntoIterator<Item = &'a PackageSignature>>(signatures: I) -> Self {
        let mut arena = Self::default();
        for signature in signatures {
            arena.push_signature(signature);
        }
        arena
    }
}

impl PartialEq for SignatureArena {
    fn eq(&self, other: &Self) -> bool {
        self.len() == other.len()
            && (0..self.len()).all(|index| {
                let (a, b) = (self.row(index), other.row(index));
                a.kind == b.kind
                    && a.size == b.size
                    && a.modified_nanos == b.modified_nanos
                    && self.path(index).cmp_path(&other.path(index)).is_eq()
            })
    }
}

impl Eq for SignatureArena {}

/// Appends `value` to the last of `blocks`, or to a new block of `capacity` once it is full.
fn push_block<T>(blocks: &mut Vec<Vec<T>>, capacity: usize, value: T) {
    match blocks.last_mut() {
        Some(block) if block.len() < capacity => block.push(value),
        _ => {
            let mut block = Vec::with_capacity(capacity);
            block.push(value);
            blocks.push(block);
        }
    }
}

/// Moves `other`'s blocks after `blocks`, keeping every block but the last full: a part-full
/// last block of `blocks` is topped up first.
fn append_blocks<T>(blocks: &mut Vec<Vec<T>>, capacity: usize, other: Vec<Vec<T>>) {
    for mut block in other {
        match blocks.last_mut() {
            Some(last) if last.len() < capacity => {
                let room = (capacity - last.len()).min(block.len());
                last.extend(block.drain(..room));
                if !block.is_empty() {
                    blocks.push(block);
                }
            }
            _ => blocks.push(block),
        }
    }
}

/// Chunk counts, offsets and directory counts stay far below `u32::MAX`: a chunk holds one text
/// past 256 KiB at most, and a walk lists far fewer than four billion chunks or directories.
fn index_u32(value: usize) -> u32 {
    u32::try_from(value).unwrap_or(u32::MAX)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn signature(path: &str, size: u64) -> PackageSignature {
        PackageSignature {
            relative_path: path.to_owned(),
            kind: if path.ends_with(".uasset") {
                EntryKind::Package
            } else {
                EntryKind::Sidecar
            },
            size,
            modified_nanos: size * 7,
        }
    }

    #[test]
    fn arena_round_trips_sorts_and_appends_without_losing_entries() {
        let long = format!("Content/{}.uasset", "L".repeat(CHUNK_BYTES + 10));
        let mut expected = Vec::new();
        for index in (0..20_000).rev() {
            expected.push(signature(&format!("Content/D{index:05}/A.uasset"), index));
            expected.push(signature(&format!("Content/D{index:05}/A.uexp"), index + 1));
            // A directory whose path continues a sibling file's name, and one sorting before it.
            expected.push(signature(&format!("Content/D{index:05}.x/B.uasset"), index));
            expected.push(signature(&format!("Content/D{index:05}-/C.uasset"), index));
        }
        expected.push(signature(&long, 3));
        expected.push(signature("Root.uasset", 4));
        let (left, right) = expected.split_at(expected.len() / 3);
        let mut arena = left.iter().collect::<SignatureArena>();
        arena.append(right.iter().collect());
        assert_eq!(arena.len(), expected.len());
        assert_eq!(arena.to_signatures(), expected);
        arena.sort_by_path();
        expected.sort_by(|a, b| a.relative_path.cmp(&b.relative_path));
        assert_eq!(arena.to_signatures(), expected);
        assert_eq!(arena, expected.iter().collect());
        for (index, signature) in expected.iter().enumerate().step_by(97) {
            assert!(arena.path(index).eq_str(&signature.relative_path));
            assert_eq!(
                arena.cmp_path(index, &signature.relative_path),
                Ordering::Equal
            );
            for other in [&expected[0], &expected[expected.len() - 1]] {
                assert_eq!(
                    arena.cmp_path(index, &other.relative_path),
                    signature.relative_path.cmp(&other.relative_path)
                );
            }
        }
    }

    #[test]
    fn named_entries_share_their_directory_and_use_forward_slashes() {
        let mut arena = SignatureArena::default();
        let directory = arena.directory("Content/Maps/");
        arena.push_named(directory, "B.umap", EntryKind::Package, 1, 2);
        arena.push_named(directory, "A\\X.uasset", EntryKind::Package, 3, 4);
        arena.push(&["Content/", "A\\B.uasset"], EntryKind::Package, 5, 6);
        arena.push(&["Content/", "C.uexp"], EntryKind::Sidecar, 7, 8);
        let long = "N".repeat(usize::from(u16::MAX) + 5);
        arena.push_named(directory, &long, EntryKind::Sidecar, 9, 10);
        assert_eq!(arena.path(0).to_string(), "Content/Maps/B.umap");
        assert_eq!(arena.path(1).to_string(), "Content/Maps/A/X.uasset");
        assert_eq!(arena.path(2).to_string(), "Content/A/B.uasset");
        assert_eq!(arena.path(3).to_string(), "Content/C.uexp");
        assert_eq!(arena.path(4).to_string(), format!("Content/Maps/{long}"));
        assert!(arena.path(0).ends_with_ignore_ascii_case(".UMAP"));
        assert!(!arena.path(1).ends_with_ignore_ascii_case(".umap"));
        assert_eq!(
            (arena.kind(3), arena.size(3), arena.modified_nanos(3)),
            (EntryKind::Sidecar, 7, 8)
        );
        assert!(!arena.is_empty());
    }

    #[test]
    fn directory_at_a_time_order_matches_path_order() {
        // Names that sort around their siblings' subdirectories ("B" < "B.x" < "B/" < "B0"), a
        // directory named like a file, a directory pushed twice, and the root.
        let names = ["B", "B.x", "B0", "B-", "A.uasset", "a", "C.uexp", "_"];
        let mut random = 0x9e37_79b9_7f4a_7c15_u64;
        let mut next = |bound: usize| {
            random = random
                .wrapping_mul(6_364_136_223_846_793_005)
                .wrapping_add(1_442_695_040_888_963_407);
            (random >> 33) as usize % bound
        };
        let mut directories = vec![String::new()];
        for _ in 0..300 {
            let parent = directories[next(directories.len())].clone();
            let name = ["B", "B0", "B.x", "A.uasset", "Sub", "b"][next(6)];
            directories.push(format!("{parent}{name}/"));
        }
        for irregular in [false, true] {
            let mut arena = SignatureArena::default();
            let mut expected = Vec::new();
            for round in 0..3 {
                for directory in &directories {
                    // Each round stores each directory again, as separate walkers would.
                    let id = arena.directory(directory);
                    for _ in 0..next(4) {
                        let name = format!("{}{round}", names[next(names.len())]);
                        let size = expected.len() as u64;
                        arena.push_named(id, &name, EntryKind::Package, size, 0);
                        expected.push(format!("{directory}{name}"));
                    }
                }
            }
            if irregular {
                let id = arena.directory("Odd/");
                arena.push_named(id, "Inner/Name", EntryKind::Package, 0, 0);
                expected.push("Odd/Inner/Name".to_owned());
            }
            assert_eq!(arena.irregular, irregular);
            arena.sort_by_path();
            // A stable sort: equal paths keep the order they were pushed in.
            let mut sorted = expected.iter().enumerate().collect::<Vec<_>>();
            sorted.sort_by(|a, b| a.1.cmp(b.1).then(a.0.cmp(&b.0)));
            let actual = (0..arena.len())
                .map(|index| (arena.size(index), arena.path(index).to_string()))
                .collect::<Vec<_>>();
            let wanted = sorted
                .iter()
                .map(|(index, path)| {
                    (
                        if irregular && **path == "Odd/Inner/Name" {
                            0
                        } else {
                            *index as u64
                        },
                        (*path).clone(),
                    )
                })
                .collect::<Vec<_>>();
            assert_eq!(
                actual.iter().map(|(_, path)| path).collect::<Vec<_>>(),
                wanted.iter().map(|(_, path)| path).collect::<Vec<_>>()
            );
            if !irregular {
                assert_eq!(actual, wanted);
            }
        }
    }

    #[test]
    fn split_paths_compare_as_their_joined_paths() {
        let values = ["", "A", "A/", "A/B", "A/B.uasset", "A.", "A0", "B", "AB/C"];
        for a in values {
            for split in 0..=a.len() {
                let path = SplitPath {
                    head: &a[..split],
                    tail: &a[split..],
                };
                for b in values {
                    assert_eq!(path.cmp_str(b), a.cmp(b), "{a:?} at {split} with {b:?}");
                    assert_eq!(path.eq_str(b), a == b);
                    for other_split in 0..=b.len() {
                        let other = SplitPath {
                            head: &b[..other_split],
                            tail: &b[other_split..],
                        };
                        assert_eq!(path.cmp_path(&other), a.cmp(b));
                    }
                }
                for suffix in ["", "B", "/B", "A/B", "X/A/B", ".uasset", ".UASSET"] {
                    assert_eq!(
                        path.ends_with_ignore_ascii_case(suffix),
                        a.len() >= suffix.len()
                            && a[a.len() - suffix.len()..].eq_ignore_ascii_case(suffix),
                        "{a:?} at {split} with {suffix:?}"
                    );
                }
            }
        }
    }
}
