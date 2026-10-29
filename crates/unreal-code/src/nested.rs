//! `#define` wrappers around text macros (5.x): the prepass finds them across the engine's and
//! the project's source, and the main pass expands their calls.
//!
//! A wrapper defined in a `.cpp` applies only to that file; one defined in a header applies to
//! every file. Two header wrappers with the same name are both excluded, because Unreal has no
//! include graph to tell which one a call means.

use serde::{Deserialize, Serialize};

use crate::wide::{
    BACKSLASH, CLOSE, COMMA, OPEN, QUOTE, Wide, ends_with_ignore_case, equals_ignore_case, narrow,
    trim, wide,
};
use crate::{CodeDiagnostic, DiagnosticCode};

#[derive(Clone, Debug)]
pub(crate) struct NestedWrapper {
    pub(crate) name: Wide,
    pub(crate) nested: String,
    pub(crate) file: String,
    pub(crate) content: Wide,
    pub(crate) line_start: usize,
    pub(crate) line_count: usize,
    pub(crate) excluded: bool,
}

/// A wrapper as callers keep it between scans, for example the engine's, cached per engine build.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WrapperMacro {
    /// The wrapper's name, such as `METASOUND_PARAM`.
    pub name: String,
    /// The text macro its body holds: `LOCTEXT`, `NSLOCTEXT`, `UI_COMMAND`, and so on.
    pub nested: String,
    /// The file that defines it, relative to the gather's base like every other path.
    pub file: String,
    /// The definition from its opening bracket, continuation lines joined with `\n`.
    pub content: String,
    pub line_start: u32,
    pub line_count: u32,
}

impl NestedWrapper {
    pub(crate) fn applies_to(&self, file: &str) -> bool {
        !self.file.to_ascii_lowercase().ends_with(".cpp") || self.file.eq_ignore_ascii_case(file)
    }

    pub(crate) fn public(&self) -> WrapperMacro {
        WrapperMacro {
            name: narrow(&self.name),
            nested: self.nested.clone(),
            file: self.file.clone(),
            content: narrow(&self.content),
            line_start: self.line_start as u32,
            line_count: self.line_count as u32,
        }
    }

    pub(crate) fn from_public(wrapper: &WrapperMacro) -> Self {
        Self {
            name: wide(&wrapper.name),
            nested: wrapper.nested.clone(),
            file: wrapper.file.clone(),
            content: wide(&wrapper.content),
            line_start: wrapper.line_start as usize,
            line_count: wrapper.line_count as usize,
            excluded: false,
        }
    }
}

fn same(left: &NestedWrapper, right: &NestedWrapper) -> bool {
    equals_ignore_case(&left.name, &right.name)
        && left.nested.eq_ignore_ascii_case(&right.nested)
        && left.file.eq_ignore_ascii_case(&right.file)
        && left.line_start == right.line_start
}

/// `PrunePrepassResults`: sort by name, drop exact repeats, and exclude same-named header pairs.
/// Unreal's sort is not stable; this one is, so ties keep the order files were scanned in.
pub(crate) fn prune(wrappers: &mut Vec<NestedWrapper>, diagnostics: &mut Vec<CodeDiagnostic>) {
    wrappers.sort_by(|left, right| {
        let fold = |name: &Wide| -> Wide {
            name.iter()
                .map(|&unit| {
                    if (65..=90).contains(&unit) {
                        unit + 32
                    } else {
                        unit
                    }
                })
                .collect()
        };
        fold(&left.name).cmp(&fold(&right.name))
    });
    wrappers.dedup_by(|right, left| same(left, right));
    for index in 1..wrappers.len() {
        let (left, right) = (&wrappers[index - 1], &wrappers[index]);
        if equals_ignore_case(&left.name, &right.name)
            && left.nested.eq_ignore_ascii_case(&right.nested)
        {
            let header = |file: &str| ends_with_ignore_case(&wide(file), &wide(".h"));
            if header(&left.file) || header(&right.file) {
                diagnostics.push(CodeDiagnostic::new(
					&left.file,
					Some(left.line_start as u32),
					DiagnosticCode::WrapperDuplicate,
					format!(
						"{} is defined in two headers ({} line {} and {} line {}); the gather uses neither.",
						narrow(&left.name),
						left.file,
						left.line_start,
						right.file,
						right.line_start
					),
				));
                wrappers[index - 1].excluded = true;
                wrappers[index].excluded = true;
            }
        }
    }
}

/// Wrappers Unreal can never gather. A body holding `NSLOCTEXT` also holds `LOCTEXT` (and
/// `UI_COMMAND_EXT` holds `UI_COMMAND`), so the prepass registers the wrapper twice under one name.
/// At every call both descriptors match the same characters and each defers to the other as the
/// "longer" token, so neither ever parses. The scan reproduces that; this says so once per name.
pub(crate) fn report_twins(wrappers: &[NestedWrapper], diagnostics: &mut Vec<CodeDiagnostic>) {
    let is_cpp = |wrapper: &NestedWrapper| wrapper.file.to_ascii_lowercase().ends_with(".cpp");
    let mut reported: Vec<&Wide> = Vec::new();
    for (index, wrapper) in wrappers.iter().enumerate() {
        if wrapper.excluded || reported.contains(&&wrapper.name) {
            continue;
        }
        let twins: Vec<&str> = wrappers[index + 1..]
            .iter()
            .filter(|other| {
                !other.excluded
                    && other.name == wrapper.name
                    && (other.file.eq_ignore_ascii_case(&wrapper.file)
                        || (!is_cpp(other) && !is_cpp(wrapper)))
            })
            .map(|other| other.nested.as_str())
            .collect();
        if twins.is_empty() {
            continue;
        }
        reported.push(&wrapper.name);
        diagnostics.push(CodeDiagnostic::new(
            &wrapper.file,
            Some(wrapper.line_start as u32),
            DiagnosticCode::WrapperUnsupported,
            format!(
                "Unreal never gathers calls of {}: its body matches both {} and {}, and the two \
                 expansions defer to each other.",
                narrow(&wrapper.name),
                wrapper.nested,
                twins.join(" and ")
            ),
        ));
    }
}

/// `FindMatching` from depth one: where the bracket that closes the call is.
pub(crate) fn find_matching(text: &[u16]) -> Option<usize> {
    let mut depth = 1i32;
    for (position, &unit) in text.iter().enumerate() {
        if unit == 0 {
            break;
        }
        if unit == OPEN {
            depth += 1;
        } else if unit == CLOSE {
            depth -= 1;
            if depth == 0 {
                return Some(position);
            }
        }
    }
    None
}

/// `FNestedMacroDescriptor::TryParseArgs`: splits on commas outside quotes, turns each argument
/// that starts with a quote or `#` into one literal (dropping quotes, keeping stringified names),
/// and quotes every argument.
pub(crate) fn rebuild_arguments(params: &[u16]) -> Wide {
    let mut pieces: Vec<Wide> = Vec::new();
    let mut collect = Wide::new();
    let mut in_quote = false;
    for (index, &unit) in params.iter().enumerate() {
        if unit == 0 {
            break;
        }
        let previous = if index == 0 { unit } else { params[index - 1] };
        if unit == QUOTE && previous != BACKSLASH {
            in_quote = !in_quote;
        } else if unit == COMMA && !in_quote {
            pieces.push(std::mem::take(&mut collect));
            continue;
        }
        collect.push(unit);
    }
    pieces.push(collect);
    let mut rebuilt: Vec<Wide> = Vec::new();
    for piece in pieces {
        let piece = trim(&piece);
        let body: Wide = if piece.first() == Some(&QUOTE) || piece.first() == Some(&(b'#' as u16)) {
            let mut body = Wide::new();
            let mut in_quote = false;
            let mut stringifying = false;
            for (index, &unit) in piece.iter().enumerate() {
                let previous = if index == 0 { unit } else { piece[index - 1] };
                if unit == QUOTE && previous != BACKSLASH {
                    in_quote = !in_quote;
                    continue;
                }
                if unit == b'#' as u16 && !in_quote {
                    stringifying = true;
                    continue;
                }
                if stringifying {
                    let is_quote = unit == QUOTE;
                    if is_quote {
                        in_quote = true;
                    }
                    if is_quote || unit == b' ' as u16 {
                        stringifying = false;
                        continue;
                    }
                }
                if stringifying || in_quote {
                    body.push(unit);
                }
            }
            body
        } else {
            piece.to_vec()
        };
        let mut quoted = vec![QUOTE];
        quoted.extend(body);
        quoted.push(QUOTE);
        rebuilt.push(quoted);
    }
    rebuilt.join(&wide(", ")[..])
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rebuilds_stringified_and_literal_arguments() {
        let rebuilt = rebuild_arguments(&wide("#Volume \"DisplayName\", \"Volume\""));
        assert_eq!(narrow(&rebuilt), "\"VolumeDisplayName\", \"Volume\"");
    }

    #[test]
    fn finds_the_closing_bracket() {
        assert_eq!(find_matching(&wide("a, f(b)), c")), Some(7));
        assert_eq!(find_matching(&wide("a, f(b")), None);
    }
}
