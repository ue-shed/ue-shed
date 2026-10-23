//! Typed rule expressions, Unreal grammar, and deterministic finding evaluation.
mod collation;
mod compiler;
mod evaluator;
mod grammar;
mod plural_tables;
mod regex;
mod subjects;
mod text;
pub use collation::HostCollator;
pub use compiler::{Program, Rule, Subject, compile};
pub use evaluator::{Emission, Evaluation, Relation, SubjectRows};
pub use grammar::format_pattern;
pub use subjects::NativeSubjects;
/// Parse JSON evidence while preserving every UTF-16 code unit.
pub fn parse_json(text: &str) -> crate::Result<serde_json::Value> {
    crate::json_value::parse(text)
}
mod identity;
pub use identity::{javascript_json, localization_identity, source_identity};
mod findings;
mod findings_read;
pub(crate) use findings::FindingsLayer;
