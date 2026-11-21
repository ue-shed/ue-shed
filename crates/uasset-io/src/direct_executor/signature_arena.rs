//! Package and sidecar signatures as a walk lists them, held in a few large allocations.
//!
//! A walk of a large project lists close to a million entries. Each path lives in a shared text
//! chunk and each entry is one fixed-size row, so the inventory costs its text plus 32 bytes an
//! entry instead of a heap string per entry, and freeing it hands back a few large blocks.

use super::catalog::{EntryKind, PackageSignature};

/// Text chunks fill to this size; a longer path gets a chunk of its own.
const CHUNK_BYTES: usize = 256 * 1024;
/// Rows a block holds. Rows grow a block at a time and are never moved, so a long walk leaves no
/// outgrown row buffers behind.
const BLOCK_ROWS: usize = 4096;

/// One entry: where its path is, and its signature.
#[derive(Clone, Copy, Debug)]
struct Row {
    chunk: u32,
    start: u32,
    len: u32,
    kind: EntryKind,
    size: u64,
    modified_nanos: u64,
}

/// Signatures by index, each path borrowed from the arena's text. Entries keep the order they
/// were pushed in until [`SignatureArena::sort_by_path`], which orders an index of them rather
/// than moving any.
#[derive(Clone, Debug, Default)]
pub(crate) struct SignatureArena {
    chunks: Vec<String>,
    blocks: Vec<Vec<Row>>,
    len: usize,
    /// Pushed entries by position, once sorted; positions are push order until then.
    order: Option<Vec<u32>>,
}

impl SignatureArena {
    pub(crate) fn len(&self) -> usize {
        self.len
    }

    #[cfg(test)]
    pub(crate) fn is_empty(&self) -> bool {
        self.len == 0
    }

    /// Appends an entry whose path is `parts` joined, with every `\` written as `/`.
    pub(crate) fn push(&mut self, parts: &[&str], kind: EntryKind, size: u64, modified_nanos: u64) {
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
        let row = Row {
            chunk: index_u32(chunk_index),
            start: index_u32(start),
            len: index_u32(len),
            kind,
            size,
            modified_nanos,
        };
        if self
            .blocks
            .last()
            .is_none_or(|block| block.len() == BLOCK_ROWS)
        {
            self.blocks.push(Vec::with_capacity(BLOCK_ROWS));
        }
        if let Some(block) = self.blocks.last_mut() {
            block.push(row);
        }
        if let Some(order) = &mut self.order {
            order.push(index_u32(self.len));
        }
        self.len += 1;
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
        self.chunks.extend(other.chunks);
        for mut block in other.blocks {
            for row in &mut block {
                row.chunk += shift;
            }
            match self.blocks.last_mut() {
                Some(last) if last.len() < BLOCK_ROWS => {
                    let room = (BLOCK_ROWS - last.len()).min(block.len());
                    last.extend(block.drain(..room));
                    if !block.is_empty() {
                        self.blocks.push(block);
                    }
                }
                _ => self.blocks.push(block),
            }
        }
        self.len += other.len;
    }

    fn row(&self, index: usize) -> &Row {
        let slot = self
            .order
            .as_ref()
            .map_or(index, |order| order[index] as usize);
        &self.blocks[slot / BLOCK_ROWS][slot % BLOCK_ROWS]
    }

    pub(crate) fn path(&self, index: usize) -> &str {
        row_path(&self.chunks, self.row(index))
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
            relative_path: row_path(&self.chunks, row).to_owned(),
            kind: row.kind,
            size: row.size,
            modified_nanos: row.modified_nanos,
        }
    }

    /// Orders the entries by path (byte order, as `str` compares; entries with equal paths keep
    /// their order), unless they already are.
    pub(crate) fn sort_by_path(&mut self) {
        if (1..self.len).all(|index| self.path(index - 1) <= self.path(index)) {
            return;
        }
        let (chunks, blocks) = (&self.chunks, &self.blocks);
        let path = |slot: u32| {
            let slot = slot as usize;
            row_path(chunks, &blocks[slot / BLOCK_ROWS][slot % BLOCK_ROWS])
        };
        let mut order = match self.order.take() {
            Some(order) => order,
            None => (0..index_u32(self.len)).collect::<Vec<_>>(),
        };
        order.sort_unstable_by(|&a, &b| path(a).cmp(path(b)).then(a.cmp(&b)));
        self.order = Some(order);
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
                    && self.path(index) == other.path(index)
            })
    }
}

impl Eq for SignatureArena {}

fn row_path<'a>(chunks: &'a [String], row: &Row) -> &'a str {
    let start = row.start as usize;
    &chunks[row.chunk as usize][start..start + row.len as usize]
}

/// Chunk counts and offsets stay far below `u32::MAX`: a chunk holds one path past 256 KiB at
/// most, and a walk lists far fewer than four billion chunks.
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
        }
        expected.push(signature(&long, 3));
        let (left, right) = expected.split_at(expected.len() / 3);
        let mut arena = left.iter().collect::<SignatureArena>();
        arena.append(right.iter().collect());
        assert_eq!(arena.len(), expected.len());
        assert_eq!(arena.to_signatures(), expected);
        arena.sort_by_path();
        expected.sort_by(|a, b| a.relative_path.cmp(&b.relative_path));
        assert_eq!(arena.to_signatures(), expected);
        assert_eq!(arena, expected.iter().collect());
    }

    #[test]
    fn pushed_parts_join_and_use_forward_slashes() {
        let mut arena = SignatureArena::default();
        arena.push(&["Content/", "A\\B.uasset"], EntryKind::Package, 1, 2);
        arena.push(&["Content/", "C.uexp"], EntryKind::Sidecar, 3, 4);
        assert_eq!(arena.path(0), "Content/A/B.uasset");
        assert_eq!(arena.path(1), "Content/C.uexp");
        assert_eq!(
            (arena.kind(1), arena.size(1), arena.modified_nanos(1)),
            (EntryKind::Sidecar, 3, 4)
        );
        assert!(!arena.is_empty());
    }
}
