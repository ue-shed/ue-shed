//! `ParseSourceText` and the descriptors it drives, ported from `GatherTextFromSourceCommandlet`.
//!
//! The scan keeps Unreal's shape on purpose: per-character token counters that never restart a
//! partial match, the longest-token deferral, the comment and string state machine, and argument
//! gathering that may read ahead into later lines without consuming them. Where Unreal is odd,
//! the port is odd the same way; the conformance tests against real gathers hold it there.

use crate::literal::{prepare_argument, remove_string_from_text_macro, strip_comments};
use crate::nested::{NestedWrapper, find_matching, rebuild_arguments};
use crate::string_table::{ContentRoot, TableCall, TableOp, is_none_name};
use crate::wide::{
    APOSTROPHE, BACKSLASH, CLOSE, COMMA, OPEN, QUOTE, Wide, contains, equals_ignore_case, find,
    find_unit, is_alnum, is_text_whitespace, narrow, replace, trim, trim_end, trim_start,
    until_nul, wide,
};
use crate::{DiagnosticCode, EngineLine, SourceDiagnostic};

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum Semantic {
    Namespace,
    Identifier,
    Source,
    DevNotes,
}

#[derive(Clone, Debug)]
pub(crate) enum Kind {
    Define,
    Undef,
    If,
    IfDef,
    ElIf,
    Else,
    EndIf,
    IniNamespace,
    UiCommand,
    UiCommandExt,
    Text(&'static [Semantic]),
    TableNew,
    TableFromFile(ContentRoot),
    TableEntry,
    TableNotedEntry,
    TableMeta,
    Log {
        condition: bool,
        namespace: bool,
    },
    DeclareError {
        namespace: usize,
        key: usize,
        text: usize,
    },
    WrapperPrepass,
    Wrapper(usize),
}

#[derive(Clone, Debug)]
pub(crate) struct Descriptor {
    pub(crate) token: Wide,
    pub(crate) kind: Kind,
    pub(crate) min_arguments: usize,
    cpp: bool,
    ini: bool,
    overrides_longer: bool,
}

const LOCTEXT: &[Semantic] = &[Semantic::Identifier, Semantic::Source];
const NSLOCTEXT: &[Semantic] = &[Semantic::Namespace, Semantic::Identifier, Semantic::Source];
const NOTELOCTEXT: &[Semantic] = &[Semantic::Identifier, Semantic::Source, Semantic::DevNotes];
const NSNOTELOCTEXT: &[Semantic] = &[
    Semantic::Namespace,
    Semantic::Identifier,
    Semantic::Source,
    Semantic::DevNotes,
];

impl Descriptor {
    fn preprocessor(token: &str, kind: Kind) -> Self {
        Self {
            token: wide(token),
            kind,
            min_arguments: 0,
            cpp: true,
            ini: false,
            overrides_longer: true,
        }
    }

    fn cpp(token: &str, kind: Kind, min_arguments: usize) -> Self {
        Self {
            token: wide(token),
            kind,
            min_arguments,
            cpp: true,
            ini: false,
            overrides_longer: false,
        }
    }

    pub(crate) fn text(token: &str, semantics: &'static [Semantic]) -> Self {
        Self {
            token: wide(token),
            kind: Kind::Text(semantics),
            min_arguments: semantics.len(),
            cpp: true,
            ini: true,
            overrides_longer: false,
        }
    }

    pub(crate) fn wrapper_prepass() -> Self {
        Self::cpp("#define ", Kind::WrapperPrepass, usize::MAX)
    }

    pub(crate) fn wrapper(name: &[u16], index: usize) -> Self {
        Self {
            token: name.to_vec(),
            kind: Kind::Wrapper(index),
            min_arguments: 1,
            cpp: true,
            ini: false,
            overrides_longer: false,
        }
    }

    /// The descriptor a wrapper's nested macro is parsed with.
    pub(crate) fn nested(name: &str, engine: EngineLine) -> Option<Self> {
        Some(match name {
            "LOCTEXT" => Self::text(name, LOCTEXT),
            "NSLOCTEXT" => Self::text(name, NSLOCTEXT),
            "NOTELOCTEXT" => Self::text(name, NOTELOCTEXT),
            "NSNOTELOCTEXT" => Self::text(name, NSNOTELOCTEXT),
            "UI_COMMAND" => Self::cpp(name, Kind::UiCommand, engine.ui_command_minimum()),
            "UI_COMMAND_EXT" => Self::cpp(name, Kind::UiCommandExt, 5),
            _ => return None,
        })
    }

    pub(crate) fn applies_to(&self, ini: bool) -> bool {
        if ini { self.ini } else { self.cpp }
    }

    /// Whether this descriptor can produce text, so a file without its token can be skipped.
    pub(crate) fn produces_text(&self) -> bool {
        !matches!(
            self.kind,
            Kind::Define
                | Kind::Undef
                | Kind::If
                | Kind::IfDef
                | Kind::ElIf
                | Kind::Else
                | Kind::EndIf
                | Kind::IniNamespace
                | Kind::WrapperPrepass
        )
    }
}

/// The main pass's descriptors, in `GetParsables` order (the order breaks ties between tokens).
pub(crate) fn main_descriptors(engine: EngineLine) -> Vec<Descriptor> {
    let mut list = vec![
        Descriptor::preprocessor("#define ", Kind::Define),
        Descriptor::preprocessor("#undef ", Kind::Undef),
        Descriptor::preprocessor("#if ", Kind::If),
        Descriptor::preprocessor("#ifdef ", Kind::IfDef),
        Descriptor::preprocessor("#elif ", Kind::ElIf),
        Descriptor::preprocessor("#else", Kind::Else),
        Descriptor::preprocessor("#endif", Kind::EndIf),
        Descriptor::cpp("UI_COMMAND", Kind::UiCommand, engine.ui_command_minimum()),
        Descriptor::cpp("UI_COMMAND_EXT", Kind::UiCommandExt, 5),
    ];
    if engine == EngineLine::Ue5_8 {
        list.push(Descriptor::text("NSNOTELOCTEXT", NSNOTELOCTEXT));
        list.push(Descriptor::text("NOTELOCTEXT", NOTELOCTEXT));
    }
    list.push(Descriptor::text("NSLOCTEXT", NSLOCTEXT));
    list.push(Descriptor::text("LOCTEXT", LOCTEXT));
    list.push(Descriptor::cpp("LOCTABLE_NEW", Kind::TableNew, 2));
    list.push(Descriptor::cpp(
        "LOCTABLE_FROMFILE_ENGINE",
        Kind::TableFromFile(ContentRoot::Engine),
        3,
    ));
    list.push(Descriptor::cpp(
        "LOCTABLE_FROMFILE_GAME",
        Kind::TableFromFile(ContentRoot::Game),
        3,
    ));
    list.push(Descriptor::cpp("LOCTABLE_SETSTRING", Kind::TableEntry, 3));
    if engine == EngineLine::Ue5_8 {
        list.push(Descriptor::cpp(
            "LOCTABLE_SETNOTESTRING",
            Kind::TableNotedEntry,
            4,
        ));
    }
    list.push(Descriptor::cpp("LOCTABLE_SETMETA", Kind::TableMeta, 4));
    if engine != EngineLine::Ue4_27 {
        for (name, condition, namespace) in [
            ("UE_LOGFMT_LOC", false, false),
            ("UE_LOGFMT_LOC_EX", false, false),
            ("UE_LOGFMT_NSLOC", false, true),
            ("UE_LOGFMT_NSLOC_EX", false, true),
            ("UE_CLOGFMT_LOC", true, false),
            ("UE_CLOGFMT_LOC_EX", true, false),
            ("UE_CLOGFMT_NSLOC", true, true),
            ("UE_CLOGFMT_NSLOC_EX", true, true),
        ] {
            let minimum = 4 + usize::from(condition) + usize::from(namespace);
            list.push(Descriptor::cpp(
                name,
                Kind::Log {
                    condition,
                    namespace,
                },
                minimum,
            ));
        }
    }
    if engine == EngineLine::Ue5_8 {
        list.push(Descriptor::cpp(
            "UE_DECLARE_ERROR",
            Kind::DeclareError {
                namespace: 1,
                key: 3,
                text: 4,
            },
            5,
        ));
        list.push(Descriptor::cpp(
            "UE_DECLARE_ERROR_CONTEXT",
            Kind::DeclareError {
                namespace: 1,
                key: 2,
                text: 3,
            },
            4,
        ));
    }
    let mut ini = Descriptor::preprocessor("[", Kind::IniNamespace);
    ini.cpp = false;
    ini.ini = true;
    list.push(ini);
    list
}

/// A place before it is resolved against the gather settings.
pub(crate) struct Found {
    pub(crate) line: u32,
    pub(crate) macro_name: Wide,
    pub(crate) wrapper: Option<Wide>,
    pub(crate) namespace: Wide,
    pub(crate) key: Wide,
    pub(crate) source: Wide,
    pub(crate) dev_notes: Wide,
    pub(crate) editor_only: bool,
}

/// Everything one file's scan produces.
#[derive(Default)]
pub(crate) struct Sink {
    pub(crate) found: Vec<Found>,
    pub(crate) tables: Vec<TableCall>,
    pub(crate) diagnostics: Vec<SourceDiagnostic>,
    pub(crate) wrappers: Vec<NestedWrapper>,
}

/// `FSourceFileParseContext`'s per-file state. Unreal copies it for look-ahead and for a
/// wrapper's nested macro, while results still land in the shared sink.
#[derive(Clone, Default)]
pub(crate) struct State {
    line_index: usize,
    line_number: usize,
    namespace: Wide,
    namespace_line: Option<usize>,
    raw_closing: Wide,
    excluded: bool,
    end_line: bool,
    block_comment: bool,
    line_comment: bool,
    string_literal: bool,
    starting_line: usize,
    blocks: Vec<Wide>,
    wrapper: Option<Wide>,
}

impl State {
    fn editor_only(&self) -> bool {
        self.blocks
            .iter()
            .any(|block| block == &wide("WITH_EDITOR") || block == &wide("WITH_EDITORONLY_DATA"))
    }

    fn quiet(&self) -> bool {
        self.block_comment || self.line_comment || self.string_literal
    }

    /// Where a `LOCTEXT_NAMESPACE` still open at the end of the file was defined.
    pub(crate) fn namespace_line(&self) -> Option<usize> {
        self.namespace_line
    }
}

#[derive(Default)]
struct Arguments {
    done: Vec<Wide>,
    current: Wide,
    double_quotes: bool,
    single_quotes: bool,
}

impl Arguments {
    /// `FMacroArgumentGatherer::Gather`: a literal that continues one ending in `"` joins it.
    fn gather(&mut self, piece: &[u16]) -> bool {
        if piece.is_empty() {
            return false;
        }
        let trimmed = trim_end(piece);
        if self.current.is_empty() {
            self.current = trimmed.to_vec();
            return true;
        }
        let mut piece = piece;
        if trimmed.first() == Some(&QUOTE) && self.current.last() == Some(&QUOTE) {
            piece = &piece[1..];
            self.current.pop();
        }
        self.current.extend_from_slice(piece);
        let end = trim_end(&self.current).len();
        self.current.truncate(end);
        true
    }

    fn end_argument(&mut self) -> bool {
        if self.current.is_empty() || self.double_quotes {
            return false;
        }
        self.done.push(std::mem::take(&mut self.current));
        true
    }
}

pub(crate) struct Scanner<'a> {
    pub(crate) engine: EngineLine,
    pub(crate) file: &'a str,
    pub(crate) ini: bool,
    pub(crate) lines: Vec<&'a [u16]>,
    pub(crate) descriptors: &'a [Descriptor],
    pub(crate) wrappers: &'a [NestedWrapper],
    /// `(line, count)` of this file's wrapper definitions, skipped by the main pass.
    pub(crate) handled: Vec<(usize, usize)>,
    pub(crate) prepass: bool,
    pub(crate) platform: Option<String>,
}

fn at(text: &[u16], index: usize) -> u16 {
    text.get(index).copied().unwrap_or(0)
}

impl Scanner<'_> {
    fn line_text(&self, state: &State) -> &[u16] {
        self.lines
            .get(state.line_number.wrapping_sub(1))
            .map_or(&[][..], |line| until_nul(trim_end(line)))
    }

    fn warn(&self, sink: &mut Sink, state: &State, code: DiagnosticCode, message: String) {
        sink.diagnostics.push(SourceDiagnostic::new(
            self.file,
            Some(state.line_number as u32),
            code,
            message,
        ));
    }

    /// `ParseSourceText`.
    pub(crate) fn run(&self, sink: &mut Sink) -> State {
        let mut state = State::default();
        let parsables: Vec<&Descriptor> = self
            .descriptors
            .iter()
            .filter(|descriptor| descriptor.applies_to(self.ini))
            .filter(|descriptor| match descriptor.kind {
                Kind::Wrapper(index) => self.wrappers[index].applies_to(self.file),
                _ => true,
            })
            .collect();
        if parsables.is_empty() {
            return state;
        }
        let mut counters = vec![0usize; parsables.len()];
        let (line_comment, block_start, block_end): (&[u16], &[u16], &[u16]) = if self.ini {
            (&[b';' as u16], &[], &[])
        } else {
            (
                &[b'/' as u16, b'/' as u16],
                &[b'/' as u16, b'*' as u16],
                &[b'*' as u16, b'/' as u16],
            )
        };
        while state.line_index < self.lines.len() {
            let line = until_nul(trim_end(self.lines[state.line_index]));
            if line.is_empty() {
                state.line_index += 1;
                continue;
            }
            state.line_number = state.line_index + 1;
            if !self.prepass
                && let Some(&(_, count)) = self
                    .handled
                    .iter()
                    .find(|(start, _)| *start == state.line_number)
            {
                state.line_index += count.saturating_sub(1) + 1;
                continue;
            }
            let mut pending: Option<usize> = None;
            let mut parse_point = 0usize;
            counters.iter_mut().for_each(|counter| *counter = 0);
            state.line_comment = false;
            state.end_line = false;
            let mut cursor = 0usize;
            while cursor < line.len() && !state.end_line {
                let unit = line[cursor];
                if !state.line_comment && !state.block_comment && !state.string_literal {
                    if line[cursor..].starts_with(line_comment) {
                        state.line_comment = true;
                        state.starting_line = state.line_number;
                        state.end_line = true;
                        cursor += line_comment.len();
                        continue;
                    } else if !block_start.is_empty() && line[cursor..].starts_with(block_start) {
                        state.block_comment = true;
                        state.starting_line = state.line_number;
                        cursor += block_start.len();
                        continue;
                    }
                }
                if !state.line_comment && !state.block_comment && !state.string_literal {
                    if unit == QUOTE {
                        if cursor == 0 {
                            state.string_literal = true;
                            state.starting_line = state.line_number;
                            cursor += 1;
                            continue;
                        }
                        let reverse = line[cursor - 1];
                        if !self.ini && reverse == u16::from(b'R') {
                            // Possibly a C++11 raw string literal: R"Delim(…)Delim".
                            state.raw_closing = vec![CLOSE];
                            let mut forward = cursor + 1;
                            let mut valid = true;
                            loop {
                                let delimiter = at(line, forward);
                                forward += 1;
                                if delimiter == OPEN {
                                    break;
                                }
                                let allowed = is_alnum(delimiter)
                                    || (self.engine != EngineLine::Ue4_27
                                        && [b'_', b'|', b'!']
                                            .iter()
                                            .any(|&c| u16::from(c) == delimiter));
                                if delimiter == 0 || !allowed {
                                    valid = false;
                                    break;
                                }
                                state.raw_closing.push(delimiter);
                            }
                            if valid {
                                state.string_literal = true;
                                state.starting_line = state.line_number;
                                cursor = forward;
                                continue;
                            }
                            state.raw_closing.clear();
                        }
                        if reverse != BACKSLASH && reverse != APOSTROPHE {
                            state.string_literal = true;
                            state.starting_line = state.line_number;
                            cursor += 1;
                            continue;
                        }
                        if escaped(line, cursor - 1)
                            || (reverse == APOSTROPHE && at(line, cursor + 1) != APOSTROPHE)
                        {
                            state.string_literal = true;
                            state.starting_line = state.line_number;
                            cursor += 1;
                            continue;
                        }
                    }
                } else if state.string_literal && unit == QUOTE {
                    if cursor == 0 && state.raw_closing.is_empty() {
                        state.string_literal = false;
                        cursor += 1;
                        continue;
                    } else if cursor > 0 {
                        if !state.raw_closing.is_empty() {
                            let length = state.raw_closing.len();
                            if cursor >= length
                                && line[cursor - length..cursor] == state.raw_closing[..]
                            {
                                state.raw_closing.clear();
                                state.string_literal = false;
                            }
                            cursor += 1;
                            continue;
                        }
                        let reverse = line[cursor - 1];
                        if reverse != BACKSLASH && reverse != APOSTROPHE {
                            state.string_literal = false;
                            cursor += 1;
                            continue;
                        }
                        if escaped(line, cursor - 1)
                            || (reverse == APOSTROPHE && at(line, cursor + 1) != APOSTROPHE)
                        {
                            state.string_literal = false;
                            cursor += 1;
                            continue;
                        }
                    }
                }
                if state.block_comment
                    && !block_end.is_empty()
                    && line[cursor..].starts_with(block_end)
                {
                    state.block_comment = false;
                    cursor += block_end.len();
                    continue;
                }
                for (index, descriptor) in parsables.iter().enumerate() {
                    let token = &descriptor.token;
                    if counters[index] == token.len() {
                        continue;
                    }
                    if unit == token[counters[index]] {
                        counters[index] += 1;
                        if counters[index] == token.len() {
                            let start = cursor + 1 - token.len();
                            if pending.is_none() || parse_point >= start {
                                pending = Some(index);
                                parse_point = start;
                            }
                        }
                    } else {
                        counters[index] = 0;
                    }
                }
                if let Some(index) = pending {
                    let descriptor = parsables[index];
                    let defer = !descriptor.overrides_longer
                        && counters.iter().enumerate().any(|(other, &count)| {
                            other != index && count >= descriptor.token.len()
                        });
                    if !defer {
                        self.try_parse(descriptor, &line[parse_point..], &mut state, sink);
                        counters.iter_mut().for_each(|counter| *counter = 0);
                        pending = None;
                    }
                }
                cursor += 1;
            }
            if state.string_literal {
                if self.ini {
                    state.string_literal = false;
                } else if cursor > 0 && state.raw_closing.is_empty() {
                    state.string_literal = at(line, cursor - 1) == BACKSLASH;
                }
                if !state.string_literal {
                    self.warn(
                        sink,
                        &state,
                        DiagnosticCode::UnterminatedString,
                        format!(
                            "A string literal is not terminated (it starts on line {}).",
                            state.starting_line
                        ),
                    );
                }
            }
            state.line_index += 1;
        }
        if state.string_literal && !state.raw_closing.is_empty() {
            sink.diagnostics.push(SourceDiagnostic::new(
                self.file,
                Some(state.starting_line as u32),
                DiagnosticCode::UnterminatedRawString,
                "A C++11 raw string literal is not terminated.".to_owned(),
            ));
        }
        state
    }

    fn try_parse(&self, descriptor: &Descriptor, text: &[u16], state: &mut State, sink: &mut Sink) {
        match &descriptor.kind {
            Kind::Define
            | Kind::Undef
            | Kind::If
            | Kind::IfDef
            | Kind::ElIf
            | Kind::Else
            | Kind::EndIf => {
                self.preprocessor(descriptor, text, state, sink);
            }
            Kind::IniNamespace => {
                if !state.excluded
                    && self.line_text(state).first() == Some(&u16::from(b'['))
                    && let Some(close) = find_unit(text, u16::from(b']')).filter(|&close| close > 1)
                {
                    state.namespace = text[1..close].to_vec();
                    state.end_line = true;
                }
            }
            Kind::UiCommand | Kind::UiCommandExt => self.ui_command(descriptor, text, state, sink),
            Kind::Text(semantics) => self.text_macro(descriptor, semantics, text, state, sink),
            Kind::TableNew
            | Kind::TableFromFile(_)
            | Kind::TableEntry
            | Kind::TableNotedEntry
            | Kind::TableMeta => self.table_macro(descriptor, text, state, sink),
            Kind::Log {
                condition,
                namespace,
            } => self.log_macro(descriptor, *condition, *namespace, text, state, sink),
            Kind::DeclareError {
                namespace,
                key,
                text: text_index,
            } => {
                self.declare_error(
                    descriptor,
                    [*namespace, *key, *text_index],
                    text,
                    state,
                    sink,
                );
            }
            Kind::WrapperPrepass => self.wrapper_prepass(state, sink),
            Kind::Wrapper(index) => self.wrapper(descriptor, *index, text, state, sink),
        }
    }

    fn preprocessor(
        &self,
        descriptor: &Descriptor,
        text: &[u16],
        state: &mut State,
        sink: &mut Sink,
    ) {
        if state.quiet() {
            return;
        }
        let rest = trim_start(text.get(descriptor.token.len()..).unwrap_or_default());
        // #else and #endif take no argument, so Unreal never strips comments after them.
        let mut rest = if matches!(descriptor.kind, Kind::Else | Kind::EndIf) {
            Wide::new()
        } else {
            strip_comments(rest, &mut state.block_comment)
        };
        let defined = wide("defined ");
        match descriptor.kind {
            Kind::Define => self.set_define(&rest, state, sink),
            Kind::Undef => self.remove_define(&rest, state, sink),
            Kind::If | Kind::ElIf => {
                if rest.starts_with(&defined) {
                    rest = trim_start(&rest[defined.len()..]).to_vec();
                }
                if matches!(descriptor.kind, Kind::ElIf) {
                    state.blocks.pop();
                }
                state.blocks.push(rest);
            }
            Kind::IfDef => state.blocks.push(rest),
            Kind::Else => {
                state.blocks.pop();
                state.blocks.push(Wide::new());
            }
            Kind::EndIf => {
                state.blocks.pop();
            }
            _ => {}
        }
        state.end_line = true;
    }

    fn set_define(&self, define: &[u16], state: &mut State, sink: &mut Sink) {
        let region = wide("LOC_DEFINE_REGION");
        let namespace = wide("LOCTEXT_NAMESPACE");
        if define == region.as_slice() {
            if state.excluded {
                self.warn(
                    sink,
                    state,
                    DiagnosticCode::RegionRedefined,
                    "LOC_DEFINE_REGION is defined twice.".to_owned(),
                );
            } else {
                state.excluded = true;
            }
        } else if !state.excluded
            && define.starts_with(&namespace)
            && define
                .get(namespace.len())
                .is_some_and(|&next| is_text_whitespace(next) || next == QUOTE)
        {
            if state.namespace_line.is_some() {
                self.warn(
                    sink,
                    state,
                    DiagnosticCode::NamespaceRedefined,
                    "LOCTEXT_NAMESPACE is defined again before #undef; the first one stays."
                        .to_owned(),
                );
            } else {
                let value = trim_start(&define[namespace.len()..]);
                match remove_string_from_text_macro(value, self.engine) {
                    Some(value) => {
                        state.namespace = value;
                        state.namespace_line = Some(state.line_number);
                    }
                    None => self.warn(
                        sink,
                        state,
                        DiagnosticCode::MissingQuotes,
                        format!("LOCTEXT_NAMESPACE {} has no closed literal.", narrow(value)),
                    ),
                }
            }
        }
    }

    fn remove_define(&self, define: &[u16], state: &mut State, sink: &mut Sink) {
        if define == wide("LOC_DEFINE_REGION").as_slice() {
            if state.excluded {
                state.excluded = false;
            } else {
                self.warn(
                    sink,
                    state,
                    DiagnosticCode::RegionNotDefined,
                    "#undef LOC_DEFINE_REGION without a #define.".to_owned(),
                );
            }
        } else if !state.excluded && define == wide("LOCTEXT_NAMESPACE").as_slice() {
            if state.namespace_line.is_none() {
                self.warn(
                    sink,
                    state,
                    DiagnosticCode::NamespaceNotDefined,
                    "#undef LOCTEXT_NAMESPACE without a #define.".to_owned(),
                );
            } else {
                state.namespace.clear();
                state.namespace_line = None;
            }
        }
    }

    /// `ParseArgsFromMacro`. On 5.x a call may continue on later lines; 4.27 reads one line.
    fn arguments(
        &self,
        descriptor: &Descriptor,
        text: &[u16],
        state: &mut State,
        sink: &mut Sink,
    ) -> Option<Vec<Wide>> {
        let remaining = trim_start(text.get(descriptor.token.len()..).unwrap_or_default());
        let open = find_unit(remaining, OPEN);
        if self.engine == EngineLine::Ue4_27 {
            return self.arguments_427(descriptor, remaining, open, state, sink);
        }
        if open.is_some_and(|open| open > 0) {
            return None;
        }
        let mut gathered = Arguments::default();
        let mut brackets: isize = if open.is_some() { 1 } else { 0 };
        if let Some(open) = open {
            self.argument_string(
                descriptor,
                remaining,
                open + 1,
                &mut brackets,
                state,
                sink,
                &mut gathered,
            )?;
        }
        if brackets > 0 {
            self.arguments_from_next_lines(descriptor, &mut gathered, &mut brackets, state, sink)?;
        }
        (!gathered.done.is_empty()).then_some(gathered.done)
    }

    fn arguments_427(
        &self,
        descriptor: &Descriptor,
        remaining: &[u16],
        open: Option<usize>,
        state: &State,
        sink: &mut Sink,
    ) -> Option<Vec<Wide>> {
        let Some(open) = open else {
            self.warn(
                sink,
                state,
                DiagnosticCode::MissingBracket,
                format!("{} has no '(' on its line.", narrow(&descriptor.token)),
            );
            return None;
        };
        if open > 0 {
            return None;
        }
        let mut arguments = Vec::new();
        let (mut double, mut single, mut escape) = (false, false, false);
        let mut brackets: isize = 1;
        let mut start = open + 1;
        let mut cursor = start;
        while brackets > 0 && at(remaining, cursor) != 0 {
            let unit = remaining[cursor];
            if escape {
                escape = false;
            } else if (double || single) && unit == BACKSLASH {
                escape = true;
            } else if double {
                double = unit != QUOTE;
            } else if single {
                single = unit != APOSTROPHE;
            } else if unit == QUOTE {
                double = true;
            } else if unit == APOSTROPHE {
                single = true;
            } else if unit == OPEN {
                brackets += 1;
            } else if unit == CLOSE {
                brackets -= 1;
                if brackets < 0 {
                    self.warn(
                        sink,
                        state,
                        DiagnosticCode::UnexpectedBracket,
                        "Unexpected ')' in the arguments.".to_owned(),
                    );
                    return None;
                }
            } else if brackets == 1 && unit == COMMA {
                arguments.push(remaining[start..cursor].to_vec());
                start = cursor + 1;
            }
            cursor += 1;
        }
        if brackets == 0 {
            arguments.push(remaining[start..cursor - 1].to_vec());
        }
        (!arguments.is_empty()).then_some(arguments)
    }

    fn parse_failed(&self, descriptor: &Descriptor, state: &State, sink: &mut Sink) -> Option<()> {
        self.warn(
            sink,
            state,
            DiagnosticCode::ArgumentParse,
            format!(
                "The arguments of {} could not be parsed.",
                narrow(&descriptor.token)
            ),
        );
        None
    }

    /// `ParseArgumentString`.
    #[allow(clippy::too_many_arguments)]
    fn argument_string(
        &self,
        descriptor: &Descriptor,
        text: &[u16],
        offset: usize,
        brackets: &mut isize,
        state: &State,
        sink: &mut Sink,
        gathered: &mut Arguments,
    ) -> Option<()> {
        let mut escape = false;
        let mut start = offset;
        let mut cursor = offset;
        while *brackets > 0 {
            let unit = at(text, cursor);
            if unit == 0 {
                if cursor > start && !gathered.gather(&text[start..cursor]) {
                    return self.parse_failed(descriptor, state, sink);
                }
                break;
            } else if escape {
                escape = false;
            } else if (gathered.double_quotes || gathered.single_quotes) && unit == BACKSLASH {
                escape = true;
                if at(text, cursor + 1) == 0 {
                    // Unreal drops the unit before the line continuation too.
                    if cursor as isize - start as isize - 1 > 0
                        && !gathered.gather(&text[start..cursor - 1])
                    {
                        return self.parse_failed(descriptor, state, sink);
                    }
                    break;
                }
            } else if gathered.double_quotes {
                if unit == QUOTE {
                    gathered.double_quotes = false;
                }
            } else if gathered.single_quotes {
                if unit == APOSTROPHE {
                    gathered.single_quotes = false;
                }
            } else if unit == QUOTE {
                gathered.double_quotes = true;
            } else if unit == APOSTROPHE {
                gathered.single_quotes = true;
            } else if unit == OPEN {
                *brackets += 1;
            } else if unit == CLOSE {
                *brackets -= 1;
                if *brackets < 0 {
                    self.warn(
                        sink,
                        state,
                        DiagnosticCode::UnexpectedBracket,
                        "Unexpected ')' in the arguments.".to_owned(),
                    );
                    return None;
                }
            } else if unit == COMMA {
                if *brackets == 1 {
                    if cursor > start && !gathered.gather(&text[start..cursor]) {
                        return self.parse_failed(descriptor, state, sink);
                    }
                    if !gathered.end_argument() {
                        return self.parse_failed(descriptor, state, sink);
                    }
                    start = cursor + 1;
                }
            } else if unit == BACKSLASH && at(text, cursor + 1) == 0 {
                if cursor as isize - start as isize - 1 > 0
                    && !gathered.gather(&text[start..cursor - 1])
                {
                    return self.parse_failed(descriptor, state, sink);
                }
                break;
            }
            if *brackets == 0 {
                if cursor > start && !gathered.gather(&text[start..cursor]) {
                    return self.parse_failed(descriptor, state, sink);
                }
                if !gathered.end_argument() {
                    return self.parse_failed(descriptor, state, sink);
                }
                break;
            }
            cursor += 1;
        }
        Some(())
    }

    /// `ParseArgsFromNextLines`: reads ahead without moving the scan, as Unreal does.
    fn arguments_from_next_lines(
        &self,
        descriptor: &Descriptor,
        gathered: &mut Arguments,
        brackets: &mut isize,
        state: &mut State,
        sink: &mut Sink,
    ) -> Option<()> {
        let mut index = state.line_number;
        while gathered.done.len() < descriptor.min_arguments || *brackets > 0 {
            let Some(raw) = self.lines.get(index) else {
                self.warn(
                    sink,
                    state,
                    DiagnosticCode::EndOfFile,
                    format!(
                        "The file ends inside the arguments of {}.",
                        narrow(&descriptor.token)
                    ),
                );
                return None;
            };
            index += 1;
            let line = strip_comments(raw, &mut state.block_comment);
            if line.is_empty() {
                continue;
            }
            let mut offset = 0;
            if *brackets == 0 {
                let Some(open) = find_unit(&line, OPEN) else {
                    self.warn(
                        sink,
                        state,
                        DiagnosticCode::MissingBracket,
                        format!(
                            "{} has no '(' on the following line.",
                            narrow(&descriptor.token)
                        ),
                    );
                    return None;
                };
                *brackets = 1;
                offset = open + 1;
            }
            self.argument_string(descriptor, &line, offset, brackets, state, sink, gathered)?;
        }
        Some(())
    }

    /// Records a place at the current line; the caller sets developer notes on it if it has any.
    fn add<'s>(
        &self,
        state: &State,
        sink: &'s mut Sink,
        macro_name: &[u16],
        namespace: Wide,
        key: Wide,
        source: Wide,
    ) -> &'s mut Found {
        sink.found.push(Found {
            line: state.line_number as u32,
            macro_name: macro_name.to_vec(),
            wrapper: state.wrapper.clone(),
            namespace,
            key,
            source,
            dev_notes: Wide::new(),
            editor_only: state.editor_only(),
        });
        let last = sink.found.len() - 1;
        &mut sink.found[last]
    }

    fn wrong_count(
        &self,
        descriptor: &Descriptor,
        expected: &str,
        got: usize,
        state: &State,
        sink: &mut Sink,
    ) {
        self.warn(
            sink,
            state,
            DiagnosticCode::ArgumentCount,
            format!(
                "{} expects {expected} arguments but has {got}.",
                narrow(&descriptor.token)
            ),
        );
    }

    fn empty_identifier(&self, descriptor: &Descriptor, state: &State, sink: &mut Sink) {
        self.warn(
            sink,
            state,
            DiagnosticCode::EmptyIdentifier,
            format!(
                "{} has an empty key and is not gathered.",
                narrow(&descriptor.token)
            ),
        );
    }

    fn ui_command(
        &self,
        descriptor: &Descriptor,
        text: &[u16],
        state: &mut State,
        sink: &mut Sink,
    ) {
        if state.excluded || state.quiet() {
            return;
        }
        let stripped = strip_comments(text, &mut state.block_comment);
        let Some(arguments) = self.arguments(descriptor, &stripped, state, sink) else {
            return;
        };
        if arguments.len() < descriptor.min_arguments {
            self.wrong_count(
                descriptor,
                &format!("at least {}", descriptor.min_arguments),
                arguments.len(),
                state,
                sink,
            );
            return;
        }
        let offset = if matches!(descriptor.kind, Kind::UiCommandExt) {
            2
        } else {
            0
        };
        let (identifier, _) = prepare_argument(trim_start(&arguments[offset]), self.engine);
        if identifier.is_empty() {
            self.empty_identifier(descriptor, state, sink);
            return;
        }
        let mut namespace = wide("UICommands");
        if state.namespace_line.is_some() && !state.namespace.is_empty() {
            namespace.push(u16::from(b'.'));
            namespace.extend_from_slice(&state.namespace);
        }
        let (source, quoted) = prepare_argument(trim_start(&arguments[offset + 1]), self.engine);
        if !quoted || source.is_empty() {
            return;
        }
        self.add(
            state,
            sink,
            &descriptor.token,
            namespace.clone(),
            identifier.clone(),
            source,
        );
        let (tooltip, quoted) = prepare_argument(trim_start(&arguments[offset + 2]), self.engine);
        if quoted && !tooltip.is_empty() {
            let mut key = identifier;
            key.extend(wide("_ToolTip"));
            self.add(state, sink, &descriptor.token, namespace, key, tooltip);
        }
    }

    fn text_macro(
        &self,
        descriptor: &Descriptor,
        semantics: &[Semantic],
        text: &[u16],
        state: &mut State,
        sink: &mut Sink,
    ) {
        if state.excluded || state.quiet() {
            return;
        }
        let stripped = strip_comments(text, &mut state.block_comment);
        let Some(arguments) = self.arguments(descriptor, &stripped, state, sink) else {
            return;
        };
        if arguments.len() != semantics.len() {
            self.wrong_count(
                descriptor,
                &semantics.len().to_string(),
                arguments.len(),
                state,
                sink,
            );
            return;
        }
        let mut namespace = (state.namespace_line.is_some() || !state.namespace.is_empty())
            .then(|| state.namespace.clone());
        let (mut identifier, mut source, mut dev_notes) = (Wide::new(), Wide::new(), Wide::new());
        for (argument, semantic) in arguments.iter().zip(semantics) {
            let (value, _) = prepare_argument(trim_start(argument), self.engine);
            match semantic {
                Semantic::Namespace => namespace = Some(value),
                Semantic::Identifier => identifier = value,
                Semantic::Source => source = value,
                Semantic::DevNotes => dev_notes = value,
            }
        }
        if identifier.is_empty() {
            self.empty_identifier(descriptor, state, sink);
            return;
        }
        if source.is_empty() {
            if self.engine != EngineLine::Ue4_27 {
                self.warn(
                    sink,
                    state,
                    DiagnosticCode::EmptySource,
                    format!(
                        "{} has empty text and is not gathered.",
                        narrow(&descriptor.token)
                    ),
                );
            }
            return;
        }
        let mut namespace = namespace.unwrap_or_else(|| {
            self.warn(
                sink,
                state,
                DiagnosticCode::NoNamespace,
                format!(
                    "{} has no namespace and none is defined; the empty namespace is used.",
                    narrow(&descriptor.token)
                ),
            );
            Wide::new()
        });
        if self.ini {
            strip_package_namespace(&mut namespace);
        }
        self.add(
            state,
            sink,
            &descriptor.token,
            namespace,
            identifier,
            source,
        )
        .dev_notes = dev_notes;
    }

    fn table_macro(
        &self,
        descriptor: &Descriptor,
        text: &[u16],
        state: &mut State,
        sink: &mut Sink,
    ) {
        if state.excluded || state.quiet() {
            return;
        }
        let stripped = strip_comments(text, &mut state.block_comment);
        let Some(arguments) = self.arguments(descriptor, &stripped, state, sink) else {
            return;
        };
        if arguments.len() != descriptor.min_arguments {
            self.wrong_count(
                descriptor,
                &descriptor.min_arguments.to_string(),
                arguments.len(),
                state,
                sink,
            );
            return;
        }
        let values: Vec<Wide> = arguments
            .iter()
            .map(|argument| prepare_argument(trim_start(argument), self.engine).0)
            .collect();
        let table = values[0].clone();
        let op = match &descriptor.kind {
            Kind::TableNew => (!is_none_name(&table)).then(|| TableOp::Register {
                table,
                namespace: values[1].clone(),
            }),
            Kind::TableFromFile(root) => {
                (!is_none_name(&table)).then(|| TableOp::RegisterFromFile {
                    table,
                    namespace: values[1].clone(),
                    path: values[2].clone(),
                    root: *root,
                    macro_name: descriptor.token.clone(),
                })
            }
            Kind::TableEntry | Kind::TableNotedEntry => {
                if is_none_name(&table) || values[1].is_empty() {
                    None
                } else if values[2].is_empty() {
                    return;
                } else {
                    Some(TableOp::Entry {
                        table,
                        key: values[1].clone(),
                        source: values[2].clone(),
                        dev_notes: values.get(3).cloned().unwrap_or_default(),
                        macro_name: descriptor.token.clone(),
                    })
                }
            }
            Kind::TableMeta => {
                if is_none_name(&table) || values[1].is_empty() || is_none_name(&values[2]) {
                    None
                } else if values[3].is_empty() {
                    return;
                } else {
                    Some(TableOp::Meta {
                        table,
                        key: values[1].clone(),
                        id: values[2].clone(),
                        value: values[3].clone(),
                    })
                }
            }
            _ => return,
        };
        match op {
            Some(op) => sink.tables.push(TableCall {
                op,
                file: self.file.to_owned(),
                line: state.line_number as u32,
                editor_only: state.editor_only(),
                platform: self.platform.clone(),
            }),
            None => self.empty_identifier(descriptor, state, sink),
        }
    }

    fn log_macro(
        &self,
        descriptor: &Descriptor,
        condition: bool,
        has_namespace: bool,
        text: &[u16],
        state: &mut State,
        sink: &mut Sink,
    ) {
        if state.excluded || state.quiet() {
            return;
        }
        let stripped = strip_comments(text, &mut state.block_comment);
        let Some(arguments) = self.arguments(descriptor, &stripped, state, sink) else {
            return;
        };
        if arguments.len() < descriptor.min_arguments {
            self.wrong_count(
                descriptor,
                &format!("at least {}", descriptor.min_arguments),
                arguments.len(),
                state,
                sink,
            );
            return;
        }
        let mut next = if condition { 3 } else { 2 };
        let mut take = || {
            let value = prepare_argument(trim_start(&arguments[next]), self.engine).0;
            next += 1;
            value
        };
        let namespace = if has_namespace {
            take()
        } else {
            state.namespace.clone()
        };
        let key = take();
        let source = take();
        if namespace.is_empty() {
            self.warn(
                sink,
                state,
                DiagnosticCode::NoNamespace,
                format!(
                    "{} has no namespace and none is defined; the empty namespace is used.",
                    narrow(&descriptor.token)
                ),
            );
        }
        if !key.is_empty() {
            self.add(state, sink, &descriptor.token, namespace, key, source);
        }
    }

    fn declare_error(
        &self,
        descriptor: &Descriptor,
        indices: [usize; 3],
        text: &[u16],
        state: &mut State,
        sink: &mut Sink,
    ) {
        if state.excluded || state.quiet() {
            return;
        }
        let stripped = strip_comments(text, &mut state.block_comment);
        let Some(arguments) = self.arguments(descriptor, &stripped, state, sink) else {
            return;
        };
        if arguments.len() < descriptor.min_arguments {
            self.wrong_count(
                descriptor,
                &format!("at least {}", descriptor.min_arguments),
                arguments.len(),
                state,
                sink,
            );
            return;
        }
        let [namespace, key, source] =
            indices.map(|index| prepare_argument(trim_start(&arguments[index]), self.engine).0);
        if namespace.is_empty() {
            self.warn(
                sink,
                state,
                DiagnosticCode::NoNamespace,
                format!(
                    "{} has an empty module and is not gathered.",
                    narrow(&descriptor.token)
                ),
            );
            return;
        }
        self.add(state, sink, &descriptor.token, namespace, key, source);
    }

    /// `FNestedMacroPrepassDescriptor::TryParse`: a `#define` whose body holds a text macro.
    fn wrapper_prepass(&self, state: &mut State, sink: &mut Sink) {
        if state.excluded || state.quiet() {
            return;
        }
        let mut lines: Vec<&[u16]> = Vec::new();
        for raw in &self.lines[state.line_index..] {
            let line = trim(raw);
            if line.is_empty() {
                continue;
            }
            lines.push(line);
            if line.last() != Some(&BACKSLASH) {
                break;
            }
        }
        let joined = lines.join(&[0x0A][..]);
        let after_define = trim_start(joined.get(wide("#define ").len()..).unwrap_or_default());
        let Some(open) = find_unit(after_define, OPEN) else {
            return;
        };
        let name = trim_end(&after_define[..open]).to_vec();
        let content = trim_start(&after_define[open..]).to_vec();
        let mut nested_names = Vec::new();
        if self.engine == EngineLine::Ue5_8 {
            nested_names.extend(["NOTELOCTEXT", "NSNOTELOCTEXT"]);
        }
        nested_names.push("LOCTEXT");
        nested_names.extend(["NSLOCTEXT", "UI_COMMAND", "UI_COMMAND_EXT"]);
        let mut advance = false;
        for nested in nested_names {
            let found = contains(&content, &wide(nested))
                && !(nested == "LOCTEXT" && contains(&content, &wide("LOCTEXT_NAMESPACE")));
            if found {
                sink.wrappers.push(NestedWrapper {
                    name: name.clone(),
                    nested: nested.to_owned(),
                    file: self.file.to_owned(),
                    content: content.clone(),
                    line_start: state.line_number,
                    line_count: lines.len(),
                    excluded: false,
                });
                advance = true;
            }
        }
        if advance {
            state.line_index += lines.len() - 1;
        }
    }

    /// `FNestedMacroDescriptor::TryParse`: a call of a wrapper found by the prepass, expanded into
    /// the text macros its body holds.
    fn wrapper(
        &self,
        descriptor: &Descriptor,
        index: usize,
        text: &[u16],
        state: &mut State,
        sink: &mut Sink,
    ) {
        if state.excluded || state.quiet() {
            return;
        }
        let wrapper = &self.wrappers[index];
        let Some(open) = find_unit(text, OPEN) else {
            return;
        };
        if !equals_ignore_case(trim_end(&text[..open]), &wrapper.name) {
            return;
        }
        // A longer name that ends in this one, such as DECLARE_<name>, is not this wrapper.
        let line_text = self.line_text(state);
        if let Some(position) = find(line_text, &wrapper.name, 0).filter(|&position| position > 0) {
            let before = line_text[position - 1];
            if !is_text_whitespace(before) && before != OPEN && before != u16::from(b'{') {
                return;
            }
        }
        let mut values_state = state.clone();
        let stripped = strip_comments(text, &mut values_state.block_comment);
        let values: Vec<Wide> = self
            .arguments(descriptor, &stripped, &mut values_state, sink)
            .unwrap_or_default()
            .iter()
            .map(|value| trim(value).to_vec())
            .collect();
        let mut definition = wrapper.name.clone();
        definition.extend_from_slice(&wrapper.content);
        let mut params_state = state.clone();
        let stripped = strip_comments(&definition, &mut params_state.block_comment);
        let params: Vec<Wide> = self
            .arguments(descriptor, &stripped, &mut params_state, sink)
            .unwrap_or_default()
            .iter()
            .map(|param| trim(param).to_vec())
            .collect();
        let mut variadic = false;
        for (position, param) in params.iter().enumerate() {
            if contains(param, &wide("##")) {
                self.warn(
                    sink,
                    state,
                    DiagnosticCode::WrapperUnsupported,
                    format!(
                        "{} concatenates with '##', which the gather does not follow.",
                        narrow(&wrapper.name)
                    ),
                );
                return;
            }
            if contains(param, &wide("...")) {
                if position + 1 != params.len() {
                    self.warn(
                        sink,
                        state,
                        DiagnosticCode::WrapperUnsupported,
                        format!(
                            "{} has '...' before its last parameter.",
                            narrow(&wrapper.name)
                        ),
                    );
                    return;
                }
                variadic = true;
            }
        }
        let enough = if variadic {
            params.len() - 1 <= values.len()
        } else {
            params.len() == values.len()
        };
        if !enough {
            self.warn(
                sink,
                state,
                DiagnosticCode::ArgumentCount,
                format!(
                    "{} expects {} arguments but has {}.",
                    narrow(&wrapper.name),
                    params.len(),
                    values.len()
                ),
            );
            return;
        }
        let mut replacements: Vec<(Wide, Wide)> = Vec::new();
        for (position, param) in params.iter().enumerate() {
            if contains(param, &wide("...")) {
                let rest: Vec<&[u16]> = values[position..].iter().map(Vec::as_slice).collect();
                replacements.push((wide("__VA_ARGS__"), rest.join(&wide(", ")[..])));
                break;
            }
            // The map's keys compare without case; a repeat replaces the whole pair in place.
            match replacements
                .iter_mut()
                .find(|(existing, _)| equals_ignore_case(existing, param))
            {
                Some(existing) => *existing = (param.clone(), values[position].clone()),
                None => replacements.push((param.clone(), values[position].clone())),
            }
        }
        // Longer parameter names first, so NAME_TEXT is replaced before NAME.
        replacements.sort_by(|left, right| right.0.len().cmp(&left.0.len()));
        let Some(inner) = Descriptor::nested(&wrapper.nested, self.engine) else {
            return;
        };
        let nested = wide(&wrapper.nested);
        let mut from = 0;
        while let Some(position) = find(&wrapper.content, &nested, from) {
            let body = wrapper
                .content
                .get(position + nested.len() + 1..)
                .unwrap_or_default();
            let Some(close) = find_matching(body) else {
                self.warn(
                    sink,
                    state,
                    DiagnosticCode::WrapperUnsupported,
                    format!(
                        "{} has no closing bracket for {}.",
                        narrow(&wrapper.name),
                        wrapper.nested
                    ),
                );
                return;
            };
            let mut params_text = body[..close].to_vec();
            for (param, value) in &replacements {
                params_text = replace(&params_text, param, value, false);
            }
            let mut call = nested.clone();
            call.push(OPEN);
            call.extend(rebuild_arguments(&params_text));
            call.push(CLOSE);
            let mut inner_state = state.clone();
            inner_state.wrapper = Some(wrapper.name.clone());
            self.try_parse(&inner, &call, &mut inner_state, sink);
            from = position + 1;
        }
    }
}

/// Whether the `\` or `'` at `index` is itself escaped by an odd run of backslashes before it.
fn escaped(line: &[u16], index: usize) -> bool {
    let mut escaped = false;
    let mut at = index;
    while at > 0 {
        at -= 1;
        if line[at] != BACKSLASH {
            break;
        }
        escaped = !escaped;
    }
    escaped
}

/// `TextNamespaceUtil::StripPackageNamespaceInline`: drops a trailing `[package]` marker.
fn strip_package_namespace(namespace: &mut Wide) {
    if namespace.last() == Some(&u16::from(b']'))
        && let Some(start) = namespace.iter().rposition(|&unit| unit == u16::from(b'['))
    {
        namespace.truncate(start);
        let end = trim_end(namespace).len();
        namespace.truncate(end);
    }
}
