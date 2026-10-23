//! Typed kernel results. Kernels run in parallel against an immutable arena and describe what
//! they built; the evaluator interns each result once, serially, in a stable order.
use super::columns::{Arena, Atom, Structured};
use super::{grammar, regex, text};
use crate::Result;
use std::sync::Arc;

#[derive(Clone, Debug, PartialEq)]
pub enum Out {
    /// A value that already exists: a scalar or an interned string or structure.
    Atom(Atom),
    /// A string the kernel computed.
    Text(String),
    List(Vec<Out>),
    /// A kernel-built record. Every field is kept, `null` included, in this order.
    Record(Vec<(&'static str, Out)>),
    /// A rule-built object (`object`); its keys come from the rule.
    Fields(Vec<(Arc<str>, Out)>),
}
impl Out {
    pub const NULL: Self = Self::Atom(Atom::Null);
    pub fn is_null(&self) -> bool {
        *self == Self::NULL
    }
}
impl From<Atom> for Out {
    fn from(atom: Atom) -> Self {
        Self::Atom(atom)
    }
}
impl From<bool> for Out {
    fn from(value: bool) -> Self {
        Self::Atom(Atom::Bool(value))
    }
}
impl From<i64> for Out {
    fn from(value: i64) -> Self {
        Self::Atom(Atom::Int(value))
    }
}
impl From<usize> for Out {
    fn from(value: usize) -> Self {
        // Counts and UTF-16 offsets; `usize` beyond `i64` cannot be produced from a string.
        Self::Atom(Atom::Int(value as i64))
    }
}
impl From<u32> for Out {
    fn from(value: u32) -> Self {
        Self::Atom(Atom::Int(i64::from(value)))
    }
}
impl From<f64> for Out {
    /// JavaScript numbers: `-0` is `0` and non-finite results are `null`.
    fn from(value: f64) -> Self {
        if value.is_finite() {
            Self::Atom(Atom::Num(if value == 0.0 { 0f64 } else { value }.to_bits()))
        } else {
            Self::NULL
        }
    }
}
impl From<String> for Out {
    fn from(value: String) -> Self {
        Self::Text(value)
    }
}
impl From<&str> for Out {
    fn from(value: &str) -> Self {
        Self::Text(value.to_owned())
    }
}
impl From<&String> for Out {
    fn from(value: &String) -> Self {
        Self::Text(value.clone())
    }
}
impl<T: Into<Out>> From<Option<T>> for Out {
    fn from(value: Option<T>) -> Self {
        value.map_or(Self::NULL, Into::into)
    }
}
impl<T: Into<Out>> From<Vec<T>> for Out {
    fn from(values: Vec<T>) -> Self {
        Self::List(values.into_iter().map(Into::into).collect())
    }
}

/// `out!({"key": value, ...})` builds a record; `out!(value)` converts a value.
macro_rules! out {
    ({$($key:literal: $value:expr),* $(,)?}) => {
        $crate::rules::out::Out::Record(vec![$(($key, $crate::rules::out::Out::from($value))),*])
    };
    ($value:expr) => { $crate::rules::out::Out::from($value) };
}
pub(crate) use out;

// Rule-visible records of the typed kernel helpers. Key names and order are part of the rule
// language and of finding evidence.
impl From<text::Balance> for Out {
    fn from(balance: text::Balance) -> Self {
        out!({"opening": balance.opening, "closing": balance.closing})
    }
}
impl From<text::RichBalance> for Out {
    fn from(balance: text::RichBalance) -> Self {
        out!({"opening": balance.opening, "closing": balance.closing, "xmlClosings": balance.xml_closings})
    }
}
impl From<text::TagComparison> for Out {
    fn from(tags: text::TagComparison) -> Self {
        let changed = tags
            .changed
            .into_iter()
            .map(|(source, translation)| out!({"source": source, "translation": translation}))
            .collect::<Vec<_>>();
        out!({
            "sourceTags": tags.source_tags,
            "translationTags": tags.translation_tags,
            "missing": tags.missing,
            "added": tags.added,
            "changed": changed,
        })
    }
}
impl From<text::Whitespace> for Out {
    fn from(whitespace: text::Whitespace) -> Self {
        out!({"leading": whitespace.leading, "trailing": whitespace.trailing, "lineBreaks": whitespace.line_breaks})
    }
}
impl From<regex::Match> for Out {
    fn from(found: regex::Match) -> Self {
        out!({"match": found.text, "start": found.start, "end": found.end})
    }
}
impl From<grammar::Pattern> for Out {
    fn from(pattern: grammar::Pattern) -> Self {
        let arguments = pattern
            .arguments
            .into_iter()
            .map(|argument| out!({"name": argument.name, "start": argument.start, "end": argument.end}))
            .collect::<Vec<_>>();
        let modifiers = pattern
            .modifiers
            .into_iter()
            .map(|modifier| {
                let forms = modifier
                    .forms
                    .into_iter()
                    .map(|form| out!({"name": form.name, "value": form.value}))
                    .collect::<Vec<_>>();
                out!({
                    "name": modifier.name,
                    "argument": modifier.argument,
                    "forms": forms,
                    "start": modifier.start,
                    "end": modifier.end,
                    "depth": modifier.depth,
                })
            })
            .collect::<Vec<_>>();
        let issues = pattern
            .issues
            .into_iter()
            .map(|issue| {
                out!({
                    "code": issue.code,
                    "modifier": issue.modifier,
                    "argument": issue.argument,
                    "forms": issue.forms,
                    "position": issue.position,
                })
            })
            .collect::<Vec<_>>();
        out!({"compiled": pattern.compiled, "arguments": arguments, "modifiers": modifiers, "issues": issues})
    }
}

impl Arena {
    /// The atom `build` would return, when everything in `out` is already interned. Read-only,
    /// so kernel workers resolve repeated results in parallel and leave only new ones to `build`.
    pub fn find(&self, out: &Out) -> Option<Atom> {
        Some(match out {
            Out::Atom(atom) => *atom,
            Out::Text(text) => Atom::Str(self.find_string(text)?),
            Out::List(values) => {
                let values = values
                    .iter()
                    .map(|value| self.find(value))
                    .collect::<Option<Vec<_>>>()?;
                Atom::Val(self.find_structured(&Structured::List(values.into()))?)
            }
            Out::Record(fields) => {
                let fields = fields
                    .iter()
                    .map(|(name, value)| Some((self.find_string(name)?, self.find(value)?)))
                    .collect::<Option<Vec<_>>>()?;
                Atom::Val(self.find_structured(&Structured::Object(fields.into()))?)
            }
            Out::Fields(fields) => {
                let fields = fields
                    .iter()
                    .map(|(name, value)| Some((self.find_string(name)?, self.find(value)?)))
                    .collect::<Option<Vec<_>>>()?;
                Atom::Val(self.find_structured(&Structured::Object(fields.into()))?)
            }
        })
    }
    pub fn build(&mut self, out: Out) -> Result<Atom> {
        Ok(match out {
            Out::Atom(atom) => atom,
            Out::Text(text) => Atom::Str(self.string(&text)?),
            Out::List(values) => {
                let values = values
                    .into_iter()
                    .map(|value| self.build(value))
                    .collect::<Result<_>>()?;
                self.list(values)?
            }
            Out::Record(fields) => {
                let mut interned = Vec::with_capacity(fields.len());
                for (name, value) in fields {
                    interned.push((self.string(name)?, self.build(value)?));
                }
                Atom::Val(self.structured(Structured::Object(interned.into()))?)
            }
            Out::Fields(fields) => {
                let mut interned = Vec::with_capacity(fields.len());
                for (name, value) in fields {
                    interned.push((self.string(&name)?, self.build(value)?));
                }
                Atom::Val(self.structured(Structured::Object(interned.into()))?)
            }
        })
    }
}
