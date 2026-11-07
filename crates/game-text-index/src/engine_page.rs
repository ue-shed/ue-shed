//! Page selection over cached ordered row IDs; authored values are hydrated only for the page.
use crate::engine_match::{Projection, checkpoint};
use crate::engine_places::Places;
use crate::engine_query::EngineQuery;
use crate::engine_types::*;
use crate::engine_where::Field;
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
    /// The rows a rows part lists from: the matching rows, or one group's.
    pub(crate) fn listed_rows(
        &self,
        selection: &Selection,
        part: &RowsPart,
        matched: Arc<[u32]>,
        cancelled: &AtomicBool,
    ) -> Result<Arc<[u32]>> {
        let Some(GroupKey { by, key: opened }) = &part.group else {
            return Ok(matched);
        };
        let by = *by;
        #[cfg(feature = "benchmark-timings")]
        let _span = crate::benchmark_timings::Span::new("searchListedRows");
        let findings = self.request_findings(selection, cancelled)?;
        // A finding group's rows are its rule's; without the rule no row is in it.
        if by == Field::Findings {
            let set = findings
                .as_deref()
                .and_then(|findings| findings.rule(opened).map(|rule| &findings.sets[rule]));
            return Ok(matched
                .iter()
                .copied()
                .filter(|row| set.is_some_and(|set| set.contains(*row as usize)))
                .collect::<Vec<_>>()
                .into());
        }
        let p = Projection::open(self, cancelled)?;
        let places = Places::open(self)?;
        let localized = selection.localized();
        let scope = if localized {
            self.culture_scope(selection)?
        } else {
            Vec::new()
        };
        let problems = self.problem_column(localized, &scope, findings.as_deref(), cancelled)?;
        let opened = self.group_id(by, opened, &places)?;
        let mut rows = Vec::new();
        if let Some(opened) = opened {
            for (index, row) in matched.iter().enumerate() {
                if index & 255 == 0 {
                    checkpoint(cancelled)?;
                }
                let key = p.group_key(&places, localized, *row as usize, &problems, by)?;
                if key == opened {
                    rows.push(*row);
                }
            }
        }
        checkpoint(cancelled)?;
        Ok(rows.into())
    }

    /// A group key's ID under `by`, as `group_key` computes it; `None` when no row can have it.
    pub(crate) fn group_id(&self, by: Field, key: &str, places: &Places) -> Result<Option<u32>> {
        Ok(match by {
            Field::Problems => PROBLEMS
                .iter()
                .position(|value| *value == key)
                .map(|id| id as u32),
            Field::Origins => {
                if key.is_empty() {
                    Some(0)
                } else {
                    ORIGINS
                        .iter()
                        .position(|value| *value == key)
                        .map(|id| id as u32 + 1)
                }
            }
            Field::Audience => AUDIENCES
                .iter()
                .position(|value| *value == key)
                .map(|id| id as u32),
            Field::Sources => self.reader.find_string(key)?,
            Field::Findings => return Err("Finding groups are keyed by their rule.".into()),
            _ => places
                .labels(&[key.to_owned()], false)
                .iter()
                .next()
                .copied(),
        })
    }

    /// A rows part's page when nothing else needs every matching row: the rows after its cursor
    /// in display order, at most `limit` of them, and whether more follow. The walk stops once
    /// it has the page. As in `after_cursor`, a cursor whose row no longer matches restarts.
    pub(crate) fn page_rows(
        &self,
        selection: &Selection,
        part: &RowsPart,
        cancelled: &AtomicBool,
    ) -> Result<(Vec<u32>, bool)> {
        let kind = if selection.localized() { "line" } else { "raw" };
        let (set, order) = self.match_set(selection, cancelled)?;
        let start = match part.after.as_ref() {
            Some(cursor) => match self.find_id(kind, cursor)? {
                Some(row) if set.contains(row) => {
                    let ranks = self.row_ranks.get_or_try(kind.into(), || {
                        ranks(&self.column(kind, "order")?, cancelled)
                    })?;
                    ranks[row] as usize + 1
                }
                _ => 0,
            },
            None => 0,
        };
        let limit = part.limit as usize;
        let rest = order.get(start..).ok_or("Page cursor outside order")?;
        let mut rows = set.first_in_order(rest, limit.saturating_add(1), cancelled)?;
        let more = rows.len() > limit;
        rows.truncate(limit);
        Ok((rows, more))
    }

    pub(crate) fn after_cursor(
        &self,
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
        let ranks = self.row_ranks.get_or_try(kind.into(), || {
            ranks(&self.column(kind, "order")?, cancelled)
        })?;
        checkpoint(cancelled)?;
        Ok(cursor_position(rows, &ranks, row))
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
