//! The rule program contract: the IR hosts send in `findings_evaluate`, and the engine compiles.
//! Rust owns it; the host's TypeScript types are generated from it (see `contract_tests`).
//!
//! Every literal is `{"lit": …}`, so `Expr` is a plain externally tagged enum and each operator's
//! arity is part of its type. The JSON reader's nesting limit bounds a document at 127 levels,
//! as a typed error before the stack is at risk; the default catalogue document nests 29.
use super::compiler::Op;
use indexmap::IndexMap;
use serde::de::{Deserializer, Error as _, SeqAccess, Visitor};
use serde::{Deserialize, Serialize};
use serde_json::Value;
#[cfg(test)]
use ts_rs::TS;

macro_rules! expressions {
    (
        unary { $($unary:ident = $unary_name:literal),* $(,)? }
        binary { $($binary:ident = $binary_name:literal),* $(,)? }
        ternary { $($ternary:ident = $ternary_name:literal),* $(,)? }
        quaternary { $($quaternary:ident = $quaternary_name:literal),* $(,)? }
        variadic { $($variadic:ident = $variadic_name:literal),* $(,)? }
        binding { $($binding:ident = $binding_name:literal),* $(,)? }
        sort { $($sort:ident = $sort_name:literal),* $(,)? }
        named { $($named:ident = $named_name:literal),* $(,)? }
    ) => {
        /// One rule expression.
        #[derive(Clone, Debug, Deserialize)]
        #[cfg_attr(test, derive(TS))]
        pub enum Expr {
            /// A constant JSON value.
            #[serde(rename = "lit")]
            Lit(#[cfg_attr(test, ts(type = "JsonValue"))] Value),
            #[serde(rename = "list")]
            List(Vec<Expr>),
            /// Fields in authored order; evidence keeps that order.
            #[serde(rename = "object")]
            Object(#[cfg_attr(test, ts(type = "{ [key: string]: Expr }"))] IndexMap<String, Expr>),
            #[serde(rename = "field")]
            Field(String),
            #[serde(rename = "param")]
            Param(String),
            #[serde(rename = "var")]
            Var(String),
            #[serde(rename = "finding")]
            Finding(String),
            /// A rule ID and a path into that rule's evidence.
            #[serde(rename = "findingField")]
            FindingField((String, String)),
            #[serde(rename = "occurrences")]
            Occurrences(#[cfg_attr(test, ts(type = "[]"))] NoArguments),
            $(#[serde(rename = $unary_name)] $unary(Box<Expr>),)*
            $(#[serde(rename = $binary_name)] $binary(Box<[Expr; 2]>),)*
            $(#[serde(rename = $ternary_name)] $ternary(Box<[Expr; 3]>),)*
            $(#[serde(rename = $quaternary_name)] $quaternary(Box<[Expr; 4]>),)*
            $(#[serde(rename = $variadic_name)] $variadic(Vec<Expr>),)*
            $(
                #[serde(rename = $binding_name)]
                $binding(
                    #[cfg_attr(test, ts(type = "readonly [Expr, Expr] | readonly [Expr, Expr, string]"))] Binding,
                ),
            )*
            $(
                #[serde(rename = $sort_name)]
                $sort(#[cfg_attr(test, ts(type = "readonly [Expr] | readonly [Expr, Expr]"))] Sort),
            )*
            $(
                #[serde(rename = $named_name)]
                $named(#[cfg_attr(test, ts(type = "{ [argument: string]: Expr }"))] Named),
            )*
        }
        impl Expr {
            /// The compiled operation and its arguments, for every operator form.
            pub(super) fn form(&self) -> Form<'_> {
                match self {
                    Self::Lit(value) => Form::Lit(value),
                    Self::Field(name) => Form::Field(name),
                    Self::Param(name) => Form::Param(name),
                    Self::Var(name) => Form::Var(name),
                    Self::Finding(rule) => Form::Finding(rule),
                    Self::FindingField((rule, path)) => Form::FindingField(rule, path),
                    Self::Occurrences(_) => Form::Occurrences,
                    Self::Object(fields) => Form::Object(fields),
                    Self::List(values) => Form::Apply(Op::List, values),
                    $(Self::$unary(value) => Form::Apply(Op::$unary, std::slice::from_ref(value)),)*
                    $(Self::$binary(values) => Form::Apply(Op::$binary, &values[..]),)*
                    $(Self::$ternary(values) => Form::Apply(Op::$ternary, &values[..]),)*
                    $(Self::$quaternary(values) => Form::Apply(Op::$quaternary, &values[..]),)*
                    $(Self::$variadic(values) => Form::Apply(Op::$variadic, values),)*
                    $(Self::$binding(binding) => Form::Bind(
                        Op::$binding(binding.name.as_deref().unwrap_or("item").into()),
                        &binding.arguments[..],
                        binding.name.as_deref().unwrap_or("item"),
                    ),)*
                    $(Self::$sort(sort) => Form::Bind(Op::$sort, &sort.arguments, "item"),)*
                    $(Self::$named(named) => Form::Named(Op::$named, &named.0),)*
                }
            }
        }
    };
}
expressions! {
    unary {
        Not = "not",
        IsNull = "isNull",
        Utf16Length = "utf16Length",
        CodePoints = "codePoints",
        VisibleLength = "visibleLength",
        VisibleWords = "visibleWords",
        InteriorLineBreaks = "interiorLineBreaks",
        Trim = "trim",
        Lower = "lower",
        NormalizeLineEndings = "normalizeLineEndings",
        Count = "count",
        Flatten = "flatten",
        Distinct = "distinct",
        First = "first",
        SortByStart = "sortByStart",
        FormatArgumentNames = "formatArgumentNames",
        FormatArgumentOrder = "formatArgumentOrder",
        FormatModifiers = "formatModifiers",
        FormatIssues = "formatIssues",
        FormatCompiled = "formatCompiled",
        RichTextCounts = "richTextCounts",
        RichTextTagBalance = "richTextTagBalance",
        UnrealWhitespace = "unrealWhitespace",
        UnrealUnsafeWhitespace = "unrealUnsafeWhitespace",
        FormatBraceBalance = "formatBraceBalance",
        MaxOf = "maxOf",
    }
    binary {
        Get = "get",
        Eq = "eq",
        Ne = "ne",
        Lt = "lt",
        Le = "le",
        Gt = "gt",
        Ge = "ge",
        In = "in",
        Sub = "sub",
        Div = "div",
        Round = "round",
        StartsWith = "startsWith",
        EndsWith = "endsWith",
        Contains = "contains",
        CountOccurrences = "countOccurrences",
        FindAll = "findAll",
        AnyChar = "anyChar",
        AllChars = "allChars",
        RemoveClass = "removeClass",
        LeadingClass = "leadingClass",
        TrailingClass = "trailingClass",
        Take = "take",
        Drop = "drop",
        Minus = "minus",
        Zip = "zip",
        MatchesRole = "matchesRole",
        PathHasPrefix = "pathHasPrefix",
        FormatPattern = "formatPattern",
        RichTextValid = "richTextValid",
        CompareRichTextTags = "compareRichTextTags",
        WithoutOptionalArgumentTags = "withoutOptionalArgumentTags",
    }
    ternary {
        If = "if",
        Slice = "slice",
        TrimClass = "trimClass",
        Runs = "runs",
        RegexMatches = "regexMatches",
        RegexTest = "regexTest",
        TermMatches = "termMatches",
        RegexReplace = "regexReplace",
    }
    quaternary {
        TermListMatches = "termListMatches",
        FormatRenameArgument = "formatRenameArgument",
    }
    variadic {
        And = "and",
        Or = "or",
        Coalesce = "coalesce",
        Add = "add",
        Mul = "mul",
        Min = "min",
        Max = "max",
        Concat = "concat",
        ConcatLists = "concatLists",
    }
    binding {
        Filter = "filter",
        Map = "map",
        FlatMap = "flatMap",
        Any = "any",
        All = "all",
    }
    sort {
        SortCodeUnit = "sortCodeUnit",
        SortLocale = "sortLocale",
    }
    named {
        GroupCount = "groupCount",
        GroupRank = "groupRank",
        GroupTake = "groupTake",
        GroupTally = "groupTally",
        ExistsOther = "existsOther",
        CorpusCount = "corpusCount",
    }
}

/// How the compiler lowers one expression.
pub(super) enum Form<'a> {
    Lit(&'a Value),
    Field(&'a str),
    Param(&'a str),
    Var(&'a str),
    Finding(&'a str),
    FindingField(&'a str, &'a str),
    Occurrences,
    Object(&'a IndexMap<String, Expr>),
    Apply(Op, &'a [Expr]),
    /// A list operator: its second argument sees the element as the named variable.
    Bind(Op, &'a [Expr], &'a str),
    /// An aggregate: arguments by name, which the compiler checks and orders per operator.
    Named(Op, &'a IndexMap<String, Expr>),
}

/// An aggregate's arguments by name (Phase 2 specification §3).
#[derive(Clone, Debug, Deserialize)]
pub struct Named(pub IndexMap<String, Expr>);

/// `occurrences` takes an empty argument list.
#[derive(Clone, Debug)]
pub struct NoArguments;
impl<'de> Deserialize<'de> for NoArguments {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        <[(); 0]>::deserialize(deserializer).map(|_| Self)
    }
}

/// A list operator's list and body, and the element's variable name (default `item`).
#[derive(Clone, Debug)]
pub struct Binding {
    arguments: Box<[Expr; 2]>,
    name: Option<String>,
}
impl<'de> Deserialize<'de> for Binding {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        struct Arguments;
        impl<'de> Visitor<'de> for Arguments {
            type Value = Binding;
            fn expecting(&self, formatter: &mut std::fmt::Formatter) -> std::fmt::Result {
                formatter.write_str("a list, a body, and an optional variable name")
            }
            fn visit_seq<A: SeqAccess<'de>>(self, mut items: A) -> Result<Binding, A::Error> {
                let list = items
                    .next_element()?
                    .ok_or_else(|| A::Error::invalid_length(0, &self))?;
                let body = items
                    .next_element()?
                    .ok_or_else(|| A::Error::invalid_length(1, &self))?;
                let name = items.next_element()?;
                if items.next_element::<serde::de::IgnoredAny>()?.is_some() {
                    return Err(A::Error::invalid_length(4, &self));
                }
                Ok(Binding {
                    arguments: Box::new([list, body]),
                    name,
                })
            }
        }
        deserializer.deserialize_seq(Arguments)
    }
}

/// A sort's list and optional key expression, which sees each element as `item`.
#[derive(Clone, Debug)]
pub struct Sort {
    arguments: Vec<Expr>,
}
impl<'de> Deserialize<'de> for Sort {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        let arguments = Vec::<Expr>::deserialize(deserializer)?;
        if !(1..=2).contains(&arguments.len()) {
            return Err(D::Error::invalid_length(
                arguments.len(),
                &"a list and an optional key",
            ));
        }
        Ok(Self { arguments })
    }
}

/// Where a rule applies, as authored.
#[derive(Clone, Debug, Default, Deserialize, Serialize)]
#[cfg_attr(test, derive(TS))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Scope {
    #[cfg_attr(test, ts(optional))]
    pub roles: Option<Vec<String>>,
    #[cfg_attr(test, ts(optional))]
    pub cultures: Option<Vec<String>>,
    #[cfg_attr(test, ts(optional))]
    pub path_prefixes: Option<Vec<String>>,
}
#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[cfg_attr(test, derive(TS))]
#[serde(rename_all = "snake_case")]
pub enum MatcherKind {
    LocationKind,
    ObjectPath,
    Row,
    PropertyPath,
    StringTableEntry,
    ClassPath,
}
#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[cfg_attr(test, derive(TS))]
#[serde(rename_all = "snake_case")]
pub enum MatchOperator {
    Exact,
    Prefix,
}
#[derive(Clone, Debug, Deserialize, Serialize)]
#[cfg_attr(test, derive(TS))]
#[serde(deny_unknown_fields)]
pub struct RoleMatcher {
    pub kind: MatcherKind,
    #[cfg_attr(test, ts(optional))]
    pub operator: Option<MatchOperator>,
    pub value: String,
}
#[derive(Clone, Debug, Deserialize, Serialize)]
#[cfg_attr(test, derive(TS))]
#[serde(deny_unknown_fields)]
pub struct RoleScope {
    pub matchers: Vec<RoleMatcher>,
}
/// A named authored role matched against saved occurrence locations.
#[derive(Clone, Debug, Deserialize, Serialize)]
#[cfg_attr(test, derive(TS))]
#[serde(deny_unknown_fields)]
pub struct Role {
    pub id: String,
    #[cfg_attr(test, ts(optional))]
    pub description: Option<String>,
    pub scopes: Vec<RoleScope>,
}
#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq, Hash)]
#[cfg_attr(test, derive(TS))]
#[serde(rename_all = "snake_case")]
pub enum Subject {
    Line,
    LineCulture,
    UnitSource,
}
/// Which policy a rule comes from.
#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[cfg_attr(test, derive(TS))]
#[serde(rename_all = "snake_case")]
pub enum Family {
    Builtin,
    Policy,
    Custom,
    Source,
}
#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[cfg_attr(test, derive(TS))]
#[serde(rename_all = "snake_case")]
pub enum Severity {
    Blocking,
    Normal,
    Low,
}
/// One named predicate, with expression evidence and the host's finding metadata.
#[derive(Clone, Debug, Deserialize)]
#[cfg_attr(test, derive(TS))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Rule {
    pub id: String,
    #[cfg_attr(test, ts(optional))]
    pub rule_id: Option<String>,
    pub kind: String,
    pub label: String,
    pub subject: Subject,
    pub family: Family,
    #[cfg_attr(test, ts(optional))]
    pub enabled: Option<bool>,
    pub severity: Severity,
    #[serde(default)]
    #[cfg_attr(test, ts(optional, type = "{ [key: string]: JsonValue }"))]
    pub params: serde_json::Map<String, Value>,
    #[cfg_attr(test, ts(optional))]
    pub scope: Option<Scope>,
    #[cfg_attr(test, ts(optional))]
    pub role: Option<String>,
    /// Named expressions, inlined where `var` reads them.
    #[serde(default, rename = "let")]
    #[cfg_attr(test, ts(optional, type = "{ [key: string]: Expr }"))]
    pub bindings: IndexMap<String, Expr>,
    #[cfg_attr(test, ts(optional))]
    pub each: Option<Expr>,
    #[cfg_attr(test, ts(optional))]
    pub each_as: Option<String>,
    pub when: Expr,
    pub actual: Expr,
    pub expectation: Expr,
    #[cfg_attr(test, ts(optional))]
    pub fix: Option<Expr>,
    #[cfg_attr(test, ts(optional))]
    pub affected: Option<Expr>,
    #[cfg_attr(test, ts(optional))]
    pub translation_origin: Option<Expr>,
    #[cfg_attr(test, ts(optional))]
    pub extra: Option<Expr>,
    pub recovery: Expr,
    #[cfg_attr(test, ts(optional))]
    pub counts: Option<bool>,
}
/// The internal v4 rule document. Authored files use versions 1–3; the host translates them.
#[derive(Debug, Deserialize)]
#[cfg_attr(test, derive(TS))]
#[cfg_attr(test, ts(rename = "RuleDocumentV4"))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Document {
    #[cfg_attr(test, ts(type = "4"))]
    pub schema_version: u32,
    pub roles: Vec<Role>,
    pub rules: Vec<Rule>,
}
