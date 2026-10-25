//! Typed rule expressions, Unreal grammar, and deterministic finding evaluation.
mod collation;
mod columns;
mod compiler;
mod evaluator;
mod grammar;
pub(crate) mod ir;
mod kernel;
mod memo;
mod occurrences;
mod out;
mod plural_tables;
mod regex;
pub(crate) mod replies;
mod selection;
mod stages;
mod subjects;
mod subjects_columns;
mod text;
mod tuple;
mod value;
mod vector;
pub use collation::HostCollator;
pub use compiler::{Program, Rule, Subject, check, compile};
pub use evaluator::{
    Affected, DIAGNOSTIC_CODES, Diagnostic, Emission, Evaluation, Relation, SubjectRows,
};
pub use grammar::format_pattern;
pub use subjects::NativeSubjects;
/// Parse JSON evidence while preserving every UTF-16 code unit.
pub fn parse_json(text: &str) -> crate::Result<serde_json::Value> {
    crate::json_value::parse(text)
}
mod identity;
pub use identity::{javascript_json, localization_identity, source_identity};
mod findings;
mod findings_order;
pub(crate) mod findings_query;
mod findings_read;
mod findings_rows;
pub(crate) use columns::Children;
pub(crate) use findings::FindingsLayer;
pub(crate) use findings_query::Acceptance;
pub(crate) use findings_rows::FindingRows;
pub(crate) use occurrences::OccurrenceData;
pub(crate) use subjects::UnitSource;

#[cfg(test)]
mod timing;
