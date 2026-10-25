//! A selected row and the sections of it a host shows, in one request (Phase 4 §6).
use crate::Result;
use crate::batch::{Batches, LINE};
use crate::engine::Reply;
use crate::engine_export::LINE_FIELDS;
use crate::engine_query::EngineQuery;
use crate::engine_related::RelatedRequest;
use crate::engine_types::{
    DetailSelection, FocusRequest, FocusSelection, LineAnswer, LineRequest,
    LocalizationDetailRequest, RowKind,
};
use std::sync::atomic::AtomicBool;

impl EngineQuery {
    /// Answers each section the request names: its part holds the places, detail and related
    /// rows, and the whole line follows as a `lines` batch.
    pub fn line(
        &self,
        request: &LineRequest,
        cancelled: &AtomicBool,
        reply: &mut dyn Reply,
    ) -> Result<()> {
        request.validate()?;
        let selection = DetailSelection {
            kind: match request.selection.kind {
                RowKind::Line => "line",
                RowKind::Unit => "unit",
            }
            .into(),
            id: request.selection.id.clone(),
        };
        let mut answer = LineAnswer::default();
        if let Some(places) = &request.places {
            let focus = FocusRequest {
                id: places
                    .unit
                    .clone()
                    .unwrap_or_else(|| request.selection.id.clone()),
                page_size: places.limit as usize,
                occurrence_cursor: places.after.clone(),
                localization: match (&request.target, request.selection.kind) {
                    (Some(target), RowKind::Line) => Some(FocusSelection {
                        target: target.clone(),
                        id: request.selection.id.clone(),
                    }),
                    _ => None,
                },
                findings: request.findings.clone(),
            };
            answer.places = Some(self.focus(&focus, cancelled)?);
        }
        if let (Some(detail), Some(target)) = (&request.detail, &request.target) {
            let offset = |value: Option<u32>| value.map(|value| value as usize);
            answer.detail = Some(self.localization_detail(
                &LocalizationDetailRequest {
                    target: target.clone(),
                    selection: selection.clone(),
                    culture: request.culture.clone(),
                    cultures: request.cultures.clone(),
                    culture_offset: offset(detail.culture_offset),
                    location_offset: offset(detail.location_offset),
                    po_context_offset: offset(detail.po_context_offset),
                    findings: request.findings.clone(),
                },
                cancelled,
            )?);
        }
        if let Some(related) = &request.related {
            answer.related = Some(self.related(
                &RelatedRequest {
                    target: request.target.clone(),
                    selection,
                    page_size: related.limit as usize,
                },
                cancelled,
            )?);
        }
        if request.line == Some(true) {
            let mut lines = Batches::new(&LINE, "lines", LINE.select(&LINE_FIELDS)?);
            if let Some(row) = self.find_id("line", &request.selection.id)? {
                lines.push(&self.localization_line(row, cancelled)?)?;
            }
            lines.finish(reply)?;
        }
        reply.part(crate::wtf8::view_json(&serde_json::to_value(&answer)?)?.into_bytes())?;
        Ok(())
    }
}

#[cfg(test)]
impl EngineQuery {
    /// A `line` request's part, for tests that read its sections.
    pub(crate) fn line_answer(
        &self,
        request: serde_json::Value,
        cancelled: &AtomicBool,
    ) -> Result<serde_json::Value> {
        let request: LineRequest =
            crate::engine_types::parse_request(&request.to_string(), "line")?;
        let mut gathered = crate::engine::Gathered::default();
        self.line(&request, cancelled, &mut gathered)?;
        crate::json_value::parse(std::str::from_utf8(
            gathered
                .parts
                .first()
                .ok_or("A line request has no part.")?,
        )?)
    }
}
