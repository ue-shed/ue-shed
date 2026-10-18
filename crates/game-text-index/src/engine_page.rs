//! Page selection over cached ordered row IDs; authored values are hydrated only for the page.
use crate::engine_match::{Projection, checkpoint};
use crate::engine_places::Places;
use crate::engine_query::EngineQuery;
use crate::engine_types::*;
use crate::{Result, require};
use std::sync::{Arc, atomic::AtomicBool};

fn ranks(order: &[u32], cancelled: &AtomicBool) -> Result<Arc<[u32]>> {
    let mut ranks = vec![u32::MAX; order.len()];
    for (position, row) in order.iter().enumerate() {
        if position & 255 == 0 {
            checkpoint(cancelled)?;
        }
        let rank = ranks
            .get_mut(*row as usize)
            .ok_or("Page order row outside index")?;
        require(*rank == u32::MAX, "Duplicate page order row")?;
        *rank = u32::try_from(position)?;
    }
    checkpoint(cancelled)?;
    Ok(ranks.into())
}

fn cursor_position(rows: &[u32], ranks: &[u32], row: usize) -> usize {
    rows.binary_search_by_key(&ranks[row], |row| ranks[*row as usize])
        .map_or(0, |index| index + 1)
}

impl EngineQuery {
    pub(crate) fn listed_rows(
        &mut self,
        request: &SearchRequest,
        matched: Arc<[u32]>,
        cancelled: &AtomicBool,
    ) -> Result<Arc<[u32]>> {
        let (Some(by), Some(opened)) = (request.group, request.open_group.as_ref()) else {
            return Ok(matched);
        };
        let key = serde_json::to_string(&("group", request.matching_key()?, by, opened))?;
        if let Some(rows) = self.matched.get(&key) {
            return Ok(Arc::clone(rows));
        }
        let p = Projection::open(self, cancelled)?;
        let places = Places::open(self)?;
        let localized = request.localization.is_some();
        let scope = self.culture_scope(request.localization.as_ref())?;
        let opened = match by {
            GroupBy::Problem => PROBLEMS
                .iter()
                .position(|value| value == opened)
                .map(|id| id as u32),
            GroupBy::Origin => {
                if opened.is_empty() {
                    Some(0)
                } else {
                    ORIGINS
                        .iter()
                        .position(|value| value == opened)
                        .map(|id| id as u32 + 1)
                }
            }
            GroupBy::Audience => AUDIENCES
                .iter()
                .position(|value| value == opened)
                .map(|id| id as u32),
            _ => places
                .labels(std::slice::from_ref(opened), false)
                .iter()
                .next()
                .copied(),
        };
        let mut rows = Vec::new();
        if let Some(opened) = opened {
            for (index, row) in matched.iter().enumerate() {
                if index & 255 == 0 {
                    checkpoint(cancelled)?;
                }
                if p.group_key(&places, localized, *row as usize, &scope, by)? == opened {
                    rows.push(*row);
                }
            }
        }
        checkpoint(cancelled)?;
        let rows: Arc<[u32]> = rows.into();
        self.remember_matches(key, Arc::clone(&rows));
        Ok(rows)
    }

    pub(crate) fn after_cursor(
        &mut self,
        kind: &str,
        rows: &[u32],
        cursor: Option<&String>,
        cancelled: &AtomicBool,
    ) -> Result<usize> {
        let Some(cursor) = cursor else {
            return Ok(0);
        };
        let Some(row) = self.find_id(kind, cursor)? else {
            return Ok(0);
        };
        if !self.row_ranks.contains_key(kind) {
            let order = self.column(kind, "order")?;
            self.row_ranks
                .insert(kind.into(), ranks(&order, cancelled)?);
        }
        checkpoint(cancelled)?;
        Ok(cursor_position(rows, &self.row_ranks[kind], row))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::Ordering;

    #[test]
    fn cursor_lookup_uses_display_order_and_missing_filtered_cursors_restart() -> Result<()> {
        let cancelled = AtomicBool::new(false);
        let ranks = ranks(&[4, 1, 3, 0, 2], &cancelled)?;
        let rows = [1, 0, 2];
        assert_eq!(cursor_position(&rows, &ranks, 1), 1);
        assert_eq!(cursor_position(&rows, &ranks, 0), 2);
        assert_eq!(cursor_position(&rows, &ranks, 2), 3);
        assert_eq!(cursor_position(&rows, &ranks, 3), 0);
        assert_eq!(cursor_position(&[], &ranks, 4), 0);
        cancelled.store(true, Ordering::Relaxed);
        assert_eq!(
            super::ranks(&[0], &cancelled).unwrap_err().code,
            crate::ErrorCode::Cancelled
        );
        assert!(super::ranks(&[0, 0], &AtomicBool::new(false)).is_err());
        assert!(super::ranks(&[1], &AtomicBool::new(false)).is_err());
        Ok(())
    }
}
