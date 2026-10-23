//! Ordered subject/element selections; columns are aligned to the selection, never keyed by row.
use super::columns::{Arena, Column};
use crate::Result;
use std::collections::HashMap;

pub struct Selection {
    pub rows: Vec<u32>,
    pub variables: HashMap<String, Column>,
}
impl Selection {
    pub fn new(rows: Vec<u32>) -> Self {
        Self {
            rows,
            variables: HashMap::new(),
        }
    }
    pub fn len(&self) -> usize {
        self.rows.len()
    }
    pub fn select(&self, indices: &[usize], arena: &mut Arena) -> Result<Self> {
        Ok(Self {
            rows: indices.iter().map(|index| self.rows[*index]).collect(),
            variables: self
                .variables
                .iter()
                .map(|(name, column)| Ok((name.clone(), column.select(indices, arena)?)))
                .collect::<Result<_>>()?,
        })
    }
}
