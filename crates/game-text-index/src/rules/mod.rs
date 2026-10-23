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
pub use subjects::NativeSubjects;
