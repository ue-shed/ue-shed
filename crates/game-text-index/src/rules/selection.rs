//! Subject selections are bitsets; only expanded element relations retain repeated rows.
use super::columns::{Arena, Bits, Column};
use crate::Result;
use std::collections::HashMap;
pub struct Rows {
    pub mask: Bits,
    expanded: Vec<u32>,
    len: usize,
}
impl Rows {
    fn new(rows: Vec<u32>) -> Self {
        if rows.windows(2).all(|pair| pair[0] < pair[1]) {
            let mut mask = Bits::new(rows.last().map_or(0, |row| *row as usize + 1));
            for row in &rows {
                mask.set(*row as usize);
            }
            Self {
                mask,
                len: rows.len(),
                expanded: Vec::new(),
            }
        } else {
            Self {
                mask: Bits::default(),
                len: rows.len(),
                expanded: rows,
            }
        }
    }
    pub fn iter(&self) -> impl Iterator<Item = u32> + '_ {
        self.mask.ones().chain(self.expanded.iter().copied())
    }
}
pub struct Selection {
    pub rows: Rows,
    pub variables: HashMap<String, Column>,
}
impl Selection {
    pub fn new(rows: Vec<u32>) -> Self {
        Self {
            rows: Rows::new(rows),
            variables: HashMap::new(),
        }
    }
    pub fn len(&self) -> usize {
        self.rows.len
    }
    pub fn select(&self, indices: &[usize], arena: &mut Arena) -> Result<Self> {
        let rows =
            if self.rows.expanded.is_empty() && indices.windows(2).all(|pair| pair[0] < pair[1]) {
                let mut compact = Bits::new(self.len());
                for index in indices {
                    compact.set(*index);
                }
                Rows {
                    mask: self.rows.mask.deposit(&compact),
                    len: indices.len(),
                    expanded: Vec::new(),
                }
            } else {
                let rows = self.rows.iter().collect::<Vec<_>>();
                Rows::new(indices.iter().map(|index| rows[*index]).collect())
            };
        Ok(Self {
            rows,
            variables: self
                .variables
                .iter()
                .map(|(name, column)| Ok((name.clone(), column.select(indices, arena)?)))
                .collect::<Result<_>>()?,
        })
    }
    pub fn from_mask(mask: Bits) -> Self {
        Self {
            rows: Rows {
                len: mask.count(),
                mask,
                expanded: Vec::new(),
            },
            variables: HashMap::new(),
        }
    }
    pub fn select_bits(&self, selected: &Bits, arena: &mut Arena) -> Result<Self> {
        if self.variables.is_empty() && self.rows.expanded.is_empty() {
            return Ok(Self::from_mask(self.rows.mask.deposit(selected)));
        }
        self.select(
            &selected.ones().map(|row| row as usize).collect::<Vec<_>>(),
            arena,
        )
    }
}
