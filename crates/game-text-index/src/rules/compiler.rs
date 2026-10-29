use super::replies::{RuleProblem, RuleProblemCode, RulesCheck};
use crate::{Error, ErrorCode, Result, require};
use serde_json::Value;
use std::collections::{HashMap, HashSet};
use std::sync::Arc;

pub type NodeId = usize;

/// A rule-authored constant (`lit`, params), typed once at compile time.
#[derive(Clone, Debug, PartialEq, Eq, Hash)]
pub enum Literal {
    Null,
    Bool(bool),
    Int(i64),
    /// Finite `f64` bits; `-0` is normalised to `0`.
    Num(u64),
    Str(Arc<str>),
    List(Arc<[Literal]>),
    Object(Arc<[(Arc<str>, Literal)]>),
}
impl Literal {
    fn read(value: &Value) -> Result<Self> {
        Ok(match value {
            Value::Null => Self::Null,
            Value::Bool(value) => Self::Bool(*value),
            Value::Number(number) => {
                if let Some(value) = number.as_i64() {
                    Self::Int(value)
                } else if let Some(value) = number.as_u64() {
                    Self::Int(value.try_into()?)
                } else {
                    match number.as_f64() {
                        Some(value) if value.is_finite() => {
                            Self::Num(if value == 0.0 { 0f64 } else { value }.to_bits())
                        }
                        _ => Self::Null,
                    }
                }
            }
            Value::String(value) => Self::Str(value.as_str().into()),
            Value::Array(values) => Self::List(
                values
                    .iter()
                    .map(Self::read)
                    .collect::<Result<Vec<_>>>()?
                    .into(),
            ),
            Value::Object(values) => Self::Object(
                values
                    .iter()
                    .map(|(name, value)| Ok((name.as_str().into(), Self::read(value)?)))
                    .collect::<Result<Vec<_>>>()?
                    .into(),
            ),
        })
    }
}

macro_rules! operations {
    ($($variant:ident = $name:literal),* $(,)?) => {
        /// A compiled operation. Payloads are resolved at compile time; dispatch never
        /// compares operation names.
        #[derive(Clone, Debug, PartialEq, Eq, Hash)]
        pub enum Op {
            Lit(Literal),
            Field(Arc<str>),
            Var(Arc<str>),
            Finding(Arc<str>),
            FindingField(Arc<str>, Arc<str>),
            Object(Arc<[Arc<str>]>),
            Filter(Arc<str>),
            Map(Arc<str>),
            FlatMap(Arc<str>),
            Any(Arc<str>),
            All(Arc<str>),
            $($variant,)*
        }
        impl Op {
            /// The authored operation name, for profiles and errors.
            pub fn name(&self) -> &'static str {
                match self {
                    Self::Lit(_) => "lit",
                    Self::Field(_) => "field",
                    Self::Var(_) => "var",
                    Self::Finding(_) => "finding",
                    Self::FindingField(..) => "findingField",
                    Self::Object(_) => "object",
                    Self::Filter(_) => "filter",
                    Self::Map(_) => "map",
                    Self::FlatMap(_) => "flatMap",
                    Self::Any(_) => "any",
                    Self::All(_) => "all",
                    $(Self::$variant => $name,)*
                }
            }
        }
    };
}
operations! {
    Occurrences = "occurrences",
    List = "list",
    SortCodeUnit = "sortCodeUnit",
    SortLocale = "sortLocale",
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
    If = "if",
    Slice = "slice",
    TrimClass = "trimClass",
    Runs = "runs",
    RegexMatches = "regexMatches",
    RegexTest = "regexTest",
    TermMatches = "termMatches",
    TermListMatches = "termListMatches",
    FormatRenameArgument = "formatRenameArgument",
    And = "and",
    Or = "or",
    Coalesce = "coalesce",
    Add = "add",
    Mul = "mul",
    Min = "min",
    Max = "max",
    Concat = "concat",
    ConcatLists = "concatLists",
    MaxOf = "maxOf",
    RegexReplace = "regexReplace",
    GroupCount = "groupCount",
    GroupRank = "groupRank",
    GroupTake = "groupTake",
    GroupTally = "groupTally",
    ExistsOther = "existsOther",
    CorpusCount = "corpusCount",
}
/// An aggregate's arguments in compiled order: name, whether it is required, and whether it sees
/// the aggregate's own element as `item` instead of the subject row. `among` defaults to true.
fn aggregate_arguments(op: &Op) -> &'static [(&'static str, bool, bool)] {
    match op {
        Op::GroupCount => &[("by", true, false), ("among", false, false)],
        Op::GroupRank => &[
            ("by", true, false),
            ("among", false, false),
            ("order", true, false),
        ],
        Op::GroupTake => &[
            ("by", true, false),
            ("among", false, false),
            ("order", true, false),
            ("value", true, false),
            ("n", true, false),
        ],
        Op::GroupTally => &[
            ("by", true, false),
            ("among", false, false),
            ("value", true, false),
            ("display", true, false),
        ],
        Op::ExistsOther => &[
            ("by", true, true),
            ("among", false, false),
            ("over", true, false),
            ("differing", true, true),
        ],
        Op::CorpusCount => &[
            ("key", true, false),
            ("among", false, true),
            ("by", true, true),
            ("relation", true, false),
        ],
        _ => &[],
    }
}
impl Op {
    /// Reads rows other than the current one (Phase 2 specification §3).
    pub fn is_aggregate(&self) -> bool {
        matches!(
            self,
            Self::GroupCount
                | Self::GroupRank
                | Self::GroupTake
                | Self::GroupTally
                | Self::ExistsOther
                | Self::CorpusCount
        )
    }
    /// The rule a `finding` or `findingField` reads.
    pub fn reference(&self) -> Option<&str> {
        match self {
            Self::Finding(rule) | Self::FindingField(rule, _) => Some(rule),
            _ => None,
        }
    }
    /// The element variable a list operator binds for its body.
    pub fn binding(&self) -> Option<&str> {
        match self {
            Self::Filter(name)
            | Self::Map(name)
            | Self::FlatMap(name)
            | Self::Any(name)
            | Self::All(name) => Some(name),
            Self::SortCodeUnit | Self::SortLocale => Some("item"),
            _ => None,
        }
    }
}

use super::ir::Form;
pub use super::ir::{Document, Expr, MatchOperator, MatcherKind, Role, Rule, Subject};
use indexmap::IndexMap;

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Type {
    Null,
    Bool,
    Int,
    Number,
    String,
    List(Box<Self>),
    Object,
    Occurrence,
    Any,
}
impl Type {
    fn accepts(&self, other: &Self) -> bool {
        self == other
            || matches!(other, Self::Null | Self::Any)
            || matches!(self, Self::Any)
            || (*self == Self::Number && *other == Self::Int)
    }
}
#[derive(Debug)]
pub struct Node {
    pub op: Op,
    pub args: Vec<NodeId>,
    pub result: Type,
}
#[derive(Debug)]
pub struct CompiledRule {
    pub rule: Rule,
    pub ordinal: usize,
    pub each: Option<NodeId>,
    pub when: NodeId,
    pub actual: NodeId,
    pub expectation: NodeId,
    pub fix: Option<NodeId>,
    pub affected: Option<NodeId>,
    pub translation_origin: Option<NodeId>,
    pub extra: Option<NodeId>,
    pub shadowed: Option<NodeId>,
    pub recovery: NodeId,
}
pub struct Program {
    pub nodes: Vec<Node>,
    pub rules: Vec<CompiledRule>,
    pub roles: HashMap<String, Role>,
    /// The document's role IDs, in its order.
    pub document_roles: Vec<String>,
    pub(crate) diagnostic_patterns: [NodeId; 2],
    pub(crate) node_last_consumer: Vec<[usize; 3]>,
    pub(crate) rule_last_reader: Vec<usize>,
}
fn invalid(message: impl Into<String>) -> Error {
    Error::new(ErrorCode::InvalidInput, message)
}
fn literal_type(value: &Value) -> Type {
    match value {
        Value::Null => Type::Null,
        Value::Bool(_) => Type::Bool,
        Value::Number(number) => {
            if number.is_i64() || number.is_u64() {
                Type::Int
            } else {
                Type::Number
            }
        }
        Value::String(_) => Type::String,
        Value::Array(values) => {
            Type::List(Box::new(values.first().map_or(Type::Any, literal_type)))
        }
        Value::Object(_) => Type::Object,
    }
}
fn field_type(subject: Subject, name: &str) -> Result<Type> {
    let line = |name: &str| -> Option<Type> {
        Some(match name {
            "lineId" | "source" | "manifestSource" | "comparisonSource" | "sourceCulture"
            | "sourceLatestOrigin" | "nativeCulture" | "originKind" => Type::String,
            "identity" => Type::Object,
            "sourceVariants" | "manifestNotes" | "manifestLocations" | "stringTables"
            | "duplicateSites" => Type::List(Box::new(Type::String)),
            "missingStringTableEntries" => Type::List(Box::new(Type::Object)),
            "comparable" | "checkable" | "gathered" | "bytecodeOnly" | "allOutside"
            | "conflicting" => Type::Bool,
            "joinPosition" => Type::Number,
            _ => return None,
        })
    };
    let value = match subject {
        Subject::Line => line(name),
        Subject::LineCulture => {
            if let Some(name) = name.strip_prefix("line.") {
                line(name)
            } else {
                Some(match name {
                    "culture" | "state" | "po" | "archive" | "archiveSource" | "latest"
                    | "latestOrigin" | "expectedSource" => Type::String,
                    "facts" | "unknownReasons" => Type::List(Box::new(Type::String)),
                    "reducedSourceChecking" | "isNative" | "isSourceCulture" => Type::Bool,
                    _ => return Err(invalid(format!("Unknown line_culture field {name}."))),
                })
            }
        }
        Subject::UnitSource => match name {
            "textUnitId" | "source" => Some(Type::String),
            _ => None,
        },
    };
    value.ok_or_else(|| invalid(format!("Unknown subject field {name}.")))
}

struct Compiler {
    nodes: Vec<Node>,
    interned: HashMap<(Op, Vec<NodeId>), NodeId>,
    active_bindings: HashSet<String>,
    variables: HashSet<String>,
}
impl Compiler {
    fn node(&mut self, op: Op, args: Vec<NodeId>, result: Type) -> Result<NodeId> {
        let key = (op, args);
        if let Some(id) = self.interned.get(&key) {
            return Ok(*id);
        }
        let id = self.nodes.len();
        self.nodes.push(Node {
            op: key.0.clone(),
            args: key.1.clone(),
            result,
        });
        self.interned.insert(key, id);
        Ok(id)
    }
    fn literal(&mut self, value: &Value) -> Result<NodeId> {
        self.node(
            Op::Lit(Literal::read(value)?),
            Vec::new(),
            literal_type(value),
        )
    }
    fn expression(&mut self, expression: &Expr, rule: &Rule) -> Result<NodeId> {
        let (op, arguments, binding) = match expression.form() {
            Form::Lit(value) => return self.literal(value),
            Form::Field(name) => {
                let result = field_type(rule.subject, name)?;
                return self.node(Op::Field(name.into()), Vec::new(), result);
            }
            Form::Param(name) => {
                let value = rule
                    .params
                    .get(name)
                    .ok_or_else(|| invalid(format!("Rule {} has no parameter {name}.", rule.id)))?;
                return self.literal(value);
            }
            Form::Var(name) => {
                if let Some(binding) = rule.bindings.get(name) {
                    require(
                        self.active_bindings.insert(name.to_owned()),
                        invalid("Cyclic let binding."),
                    )?;
                    let result = self.expression(binding, rule);
                    self.active_bindings.remove(name);
                    return result;
                }
                require(
                    self.variables.contains(name),
                    invalid(format!("Unknown expression variable {name}.")),
                )?;
                return self.node(Op::Var(name.into()), Vec::new(), Type::Any);
            }
            Form::Finding(name) => {
                return self.node(Op::Finding(name.into()), Vec::new(), Type::Bool);
            }
            Form::FindingField(reference, path) => {
                return self.node(
                    Op::FindingField(reference.into(), path.into()),
                    Vec::new(),
                    Type::Any,
                );
            }
            Form::Occurrences => {
                return self.node(
                    Op::Occurrences,
                    Vec::new(),
                    Type::List(Box::new(Type::Occurrence)),
                );
            }
            Form::Object(fields) => {
                let args = fields
                    .values()
                    .map(|expression| self.expression(expression, rule))
                    .collect::<Result<Vec<_>>>()?;
                let keys = fields.keys().map(|key| Arc::from(key.as_str())).collect();
                return self.node(Op::Object(keys), args, Type::Object);
            }
            Form::Apply(op, arguments) => (op, arguments, None),
            Form::Bind(op, arguments, name) => (op, arguments, Some(name)),
            Form::Named(op, fields) => return self.aggregate(op, fields, rule),
            Form::Query(name) => {
                return Err(invalid(format!(
                    "{name} is a query form; rules cannot use it yet."
                )));
            }
        };
        let mut args = Vec::with_capacity(arguments.len());
        for (index, expression) in arguments.iter().enumerate() {
            // A list operator's body sees the element as its variable.
            let bound = binding.filter(|_| index == 1);
            let existed = bound.is_some_and(|name| !self.variables.insert(name.into()));
            let argument = self.expression(expression, rule)?;
            if let Some(name) = bound
                && !existed
            {
                self.variables.remove(name);
            }
            args.push(argument);
        }
        // Rule regexes are JavaScript's; the few constructs the engine cannot run (such as a
        // lookbehind of varying length) reject the document here, not the evaluation reaching them.
        if matches!(op, Op::RegexMatches | Op::RegexTest | Op::RegexReplace)
            && let Some(Op::Lit(Literal::Str(pattern))) = args.get(1).map(|id| &self.nodes[*id].op)
        {
            super::regex::JsRegex::new(pattern, true).map_err(|cause| {
                invalid(format!(
                    "Rule {} has a regular expression the engine cannot run: {cause}.",
                    rule.id
                ))
            })?;
        }
        // Arity is part of each operator's IR type; only argument and result types remain.
        let result = match &op {
            // Aggregates take named arguments and are typed in `aggregate`.
            Op::GroupCount
            | Op::GroupRank
            | Op::GroupTake
            | Op::GroupTally
            | Op::ExistsOther
            | Op::CorpusCount => {
                return Err(invalid(format!("{} takes named arguments.", op.name())));
            }
            Op::List => Type::List(Box::new(
                args.first()
                    .map_or(Type::Any, |id| self.nodes[*id].result.clone()),
            )),
            Op::And | Op::Or | Op::Not => {
                self.arguments(&args, &Type::Bool)?;
                Type::Bool
            }
            Op::Eq | Op::Ne | Op::In | Op::IsNull => Type::Bool,
            Op::Lt | Op::Le | Op::Gt | Op::Ge => {
                for id in &args {
                    require(
                        matches!(
                            self.nodes[*id].result,
                            Type::Number | Type::Int | Type::String | Type::Any | Type::Null
                        ),
                        invalid("Comparison requires numbers or strings."),
                    )?;
                }
                Type::Bool
            }
            Op::If => {
                self.arguments(&args[..1], &Type::Bool)?;
                self.nodes[args[1]].result.clone()
            }
            Op::Coalesce => args
                .first()
                .map_or(Type::Any, |id| self.nodes[*id].result.clone()),
            Op::Add | Op::Mul | Op::Min | Op::Max | Op::Sub | Op::Div | Op::Round => {
                self.arguments(&args, &Type::Number)?;
                Type::Number
            }
            Op::Utf16Length
            | Op::CodePoints
            | Op::VisibleLength
            | Op::VisibleWords
            | Op::InteriorLineBreaks
            | Op::CountOccurrences => {
                self.arguments(&args, &Type::String)?;
                Type::Int
            }
            Op::MaxOf => {
                // Element types are shallow (a mapped list is `List(Any)`); elements are checked
                // when evaluated.
                require(
                    matches!(
                        self.nodes[args[0]].result,
                        Type::List(_) | Type::Any | Type::Null
                    ),
                    invalid("maxOf requires a list."),
                )?;
                Type::Int
            }
            Op::Trim
            | Op::Lower
            | Op::NormalizeLineEndings
            | Op::Concat
            | Op::RegexReplace
            | Op::FormatRenameArgument => {
                self.arguments(&args, &Type::String)?;
                Type::String
            }
            Op::Slice => {
                self.arguments(&args[..1], &Type::String)?;
                self.arguments(&args[1..], &Type::Number)?;
                Type::String
            }
            Op::StartsWith
            | Op::EndsWith
            | Op::Contains
            | Op::UnrealUnsafeWhitespace
            | Op::RichTextValid => {
                self.arguments(&args, &Type::String)?;
                Type::Bool
            }
            Op::FindAll | Op::RegexMatches | Op::TermMatches | Op::TermListMatches => {
                Type::List(Box::new(Type::Object))
            }
            Op::AnyChar | Op::AllChars | Op::RegexTest | Op::Any(_) | Op::All(_) => Type::Bool,
            Op::FormatCompiled => Type::Bool,
            Op::RemoveClass
            | Op::LeadingClass
            | Op::TrailingClass
            | Op::TrimClass
            | Op::WithoutOptionalArgumentTags => Type::String,
            Op::Runs | Op::Count => Type::Int,
            Op::Filter(_)
            | Op::Map(_)
            | Op::FlatMap(_)
            | Op::Flatten
            | Op::Distinct
            | Op::SortByStart
            | Op::SortCodeUnit
            | Op::SortLocale
            | Op::Take
            | Op::Drop
            | Op::Minus
            | Op::Zip
            | Op::ConcatLists
            | Op::FormatArgumentNames
            | Op::FormatArgumentOrder
            | Op::FormatModifiers
            | Op::FormatIssues => Type::List(Box::new(Type::Any)),
            Op::First => Type::Any,
            Op::Get => {
                self.arguments(&args[1..], &Type::String)?;
                Type::Any
            }
            Op::MatchesRole | Op::PathHasPrefix => Type::Bool,
            Op::FormatPattern => {
                self.arguments(&args, &Type::String)?;
                Type::Object
            }
            Op::RichTextCounts
            | Op::RichTextTagBalance
            | Op::UnrealWhitespace
            | Op::FormatBraceBalance
            | Op::CompareRichTextTags => {
                self.arguments(&args, &Type::String)?;
                Type::Object
            }
            Op::Lit(_)
            | Op::Field(_)
            | Op::Var(_)
            | Op::Finding(_)
            | Op::FindingField(..)
            | Op::Object(_)
            | Op::Occurrences => {
                return Err("Leaf operations are lowered before their arguments.".into());
            }
        };
        self.node(op, args, result)
    }
    /// An aggregate (Phase 2 specification §3), its named arguments in compiled order.
    fn aggregate(
        &mut self,
        op: Op,
        fields: &IndexMap<String, Expr>,
        rule: &Rule,
    ) -> Result<NodeId> {
        let name = op.name();
        let corpus = op == Op::CorpusCount;
        // Group aggregates are per subject row. A corpus count's key may be an element's, as in
        // the census over a line's occurrences; its table never is.
        require(
            corpus || self.variables.is_empty(),
            invalid(format!(
                "Rule {}: {name} can't be inside a list operator's body.",
                rule.id
            )),
        )?;
        let signature = aggregate_arguments(&op);
        if let Some(unknown) = fields
            .keys()
            .find(|key| !signature.iter().any(|(known, ..)| known == key))
        {
            return Err(invalid(format!(
                "Rule {}: {name} has no argument {unknown}.",
                rule.id
            )));
        }
        let mut args = Vec::with_capacity(signature.len());
        for (argument, required, bound) in signature {
            let Some(expression) = fields.get(*argument) else {
                require(
                    !required,
                    invalid(format!("Rule {}: {name} needs {argument}.", rule.id)),
                )?;
                args.push(self.literal(&Value::Bool(true))?);
                continue;
            };
            if !bound {
                args.push(self.expression(expression, rule)?);
                continue;
            }
            // Only the aggregate's own element is in scope.
            let outer = std::mem::replace(&mut self.variables, HashSet::from(["item".to_owned()]));
            let id = self.expression(expression, rule);
            self.variables = outer;
            let id = id?;
            if corpus {
                self.corpus_only(id, rule)?;
            }
            args.push(id);
        }
        let literal = |compiler: &Self, index: usize| match &compiler.nodes[args[index]].op {
            Op::Lit(literal) => Some(literal.clone()),
            _ => None,
        };
        let result = match op {
            Op::GroupCount | Op::GroupRank | Op::CorpusCount => Type::Int,
            Op::GroupTake => {
                require(
                    matches!(literal(self, 4), Some(Literal::Int(n)) if n >= 0),
                    invalid(format!(
                        "Rule {}: groupTake needs a whole-number n.",
                        rule.id
                    )),
                )?;
                Type::List(Box::new(self.nodes[args[3]].result.clone()))
            }
            Op::GroupTally => Type::List(Box::new(Type::Object)),
            Op::ExistsOther => Type::Bool,
            _ => return Err(invalid(format!("{name} is not an aggregate."))),
        };
        if corpus {
            require(
                matches!(literal(self, 3), Some(Literal::Str(relation)) if &*relation == "corpus_occurrence"),
                invalid(format!(
                    "Rule {}: corpusCount's relation must be \"corpus_occurrence\".",
                    rule.id
                )),
            )?;
        }
        self.node(op, args, result)
    }
    /// A corpus count's table reads only the corpus row: no subject field, occurrence list,
    /// finding or other aggregate.
    fn corpus_only(&self, id: NodeId, rule: &Rule) -> Result<()> {
        let mut pending = vec![id];
        while let Some(id) = pending.pop() {
            let node = &self.nodes[id];
            require(
                !matches!(
                    node.op,
                    Op::Field(_) | Op::Occurrences | Op::Finding(_) | Op::FindingField(..)
                ) && !node.op.is_aggregate(),
                invalid(format!(
                    "Rule {}: corpusCount's by and among read only item, not {}.",
                    rule.id,
                    node.op.name()
                )),
            )?;
            pending.extend(&node.args);
        }
        Ok(())
    }
    fn arguments(&self, args: &[NodeId], expected: &Type) -> Result<()> {
        for id in args {
            require(
                expected.accepts(&self.nodes[*id].result),
                invalid(format!(
                    "Expected {expected:?}, got {:?}.",
                    self.nodes[*id].result
                )),
            )?;
        }
        Ok(())
    }
}

/// The rule being compiled, and what a failure there is about.
struct Fault {
    rule_id: Option<String>,
    code: RuleProblemCode,
}
impl Fault {
    fn at(&mut self, rule_id: Option<&str>, code: RuleProblemCode) {
        self.rule_id = rule_id.map(str::to_owned);
        self.code = code;
    }
}
/// Compiles a document to report its first problem, with the rule at fault, rather than run it.
pub fn check(json: &str) -> RulesCheck {
    let mut fault = Fault {
        rule_id: None,
        code: RuleProblemCode::InvalidStructure,
    };
    let problem = compile_tracked(json, &mut fault)
        .err()
        .map(|error| RuleProblem {
            rule_id: fault.rule_id,
            code: fault.code,
            message: error.to_string(),
        });
    RulesCheck { problem }
}
pub fn compile(json: &str) -> Result<Program> {
    compile_tracked(
        json,
        &mut Fault {
            rule_id: None,
            code: RuleProblemCode::InvalidStructure,
        },
    )
}
/// A v4 document with its rules still JSON, to find the rule that doesn't decode.
#[derive(serde::Deserialize)]
struct Unread {
    rules: Vec<Value>,
}
/// The first rule of a document that doesn't decode, by ID: an unknown operation or a malformed
/// form. Each is decoded from text, as the document was, so a deep rule needs no more stack.
fn undecoded_rule(json: &str) -> Option<String> {
    let unread = crate::json_value::parse_as::<Unread>(json).ok()?;
    unread
        .rules
        .iter()
        .find(|rule| {
            serde_json::to_string(rule)
                .map_or(true, |text| serde_json::from_str::<Rule>(&text).is_err())
        })
        .and_then(|rule| rule.get("id")?.as_str().map(str::to_owned))
}
fn compile_tracked(json: &str, fault: &mut Fault) -> Result<Program> {
    // The WTF-8-aware reader keeps lone UTF-16 units; its nesting limit (127) bounds the IR.
    let document: Document = crate::json_value::parse_as(json).map_err(|cause| {
        if let Some(id) = undecoded_rule(json) {
            fault.at(Some(&id), RuleProblemCode::InvalidExpression);
        }
        Error::with_source(ErrorCode::InvalidInput, "Invalid v4 rule document.", cause)
    })?;
    require(
        document.schema_version == 4,
        invalid("The evaluator requires an internal v4 document."),
    )?;
    let mut roles = HashMap::new();
    let document_roles = document.roles.iter().map(|role| role.id.clone()).collect();
    for role in document.roles {
        require(
            roles.insert(role.id.clone(), role).is_none(),
            invalid("Duplicate role ID."),
        )?;
    }
    let subjects = document
        .rules
        .iter()
        .map(|rule| (rule.id.clone(), rule.subject))
        .collect::<HashMap<_, _>>();
    require(
        subjects.len() == document.rules.len(),
        invalid("Duplicate rule ID."),
    )?;
    let mut compiler = Compiler {
        nodes: Vec::new(),
        interned: HashMap::new(),
        active_bindings: HashSet::new(),
        variables: HashSet::new(),
    };
    let mut compiled = Vec::new();
    for (ordinal, rule) in document.rules.into_iter().enumerate() {
        fault.at(Some(&rule.id), RuleProblemCode::InvalidStructure);
        require(
            rule.role
                .as_ref()
                .is_none_or(|role| roles.contains_key(role)),
            invalid("Unknown rule role."),
        )?;
        if rule.enabled == Some(false) {
            continue;
        }
        if let Some(ids) = rule.scope.as_ref().and_then(|scope| scope.roles.as_ref()) {
            require(
                ids.iter().all(|id| roles.contains_key(id)),
                invalid("Unknown scope role."),
            )?;
        }
        fault.at(Some(&rule.id), RuleProblemCode::InvalidExpression);
        let each = rule
            .each
            .as_ref()
            .map(|each| compiler.expression(each, &rule))
            .transpose()?;
        if each.is_some() {
            compiler
                .variables
                .insert(rule.each_as.clone().unwrap_or("item".into()));
        }
        let mut optional = |value: &Option<Expr>| {
            value
                .as_ref()
                .map(|value| compiler.expression(value, &rule))
                .transpose()
        };
        let fix = optional(&rule.fix)?;
        let affected = optional(&rule.affected)?;
        let translation_origin = optional(&rule.translation_origin)?;
        let extra = optional(&rule.extra)?;
        let shadowed = optional(&rule.shadowed)?;
        if let Some(shadowed) = shadowed {
            compiler.arguments(&[shadowed], &Type::Bool)?;
        }
        let when = compiler.expression(&rule.when, &rule)?;
        compiler.arguments(&[when], &Type::Bool)?;
        let actual = compiler.expression(&rule.actual, &rule)?;
        let expectation = compiler.expression(&rule.expectation, &rule)?;
        compiler.arguments(&[actual, expectation], &Type::Object)?;
        let recovery = compiler.expression(&rule.recovery, &rule)?;
        compiler.arguments(&[recovery], &Type::String)?;
        compiler.variables.clear();
        compiled.push(CompiledRule {
            rule,
            ordinal,
            each,
            when,
            actual,
            expectation,
            fix,
            affected,
            translation_origin,
            extra,
            shadowed,
            recovery,
        });
    }
    let mut order = Vec::new();
    let mut visiting = HashSet::new();
    let mut visited = HashSet::new();
    #[allow(clippy::too_many_arguments)]
    fn visit(
        index: usize,
        rules: &[CompiledRule],
        nodes: &[Node],
        subjects: &HashMap<String, Subject>,
        visiting: &mut HashSet<usize>,
        visited: &mut HashSet<usize>,
        order: &mut Vec<usize>,
        fault: &mut Fault,
    ) -> Result<()> {
        if visited.contains(&index) {
            return Ok(());
        }
        let rule = &rules[index];
        if !visiting.insert(index) {
            fault.at(Some(&rule.rule.id), RuleProblemCode::RuleCycle);
            return Err(invalid(format!(
                "rule_cycle: rule {} reads its own findings through finding.",
                rule.rule.id
            )));
        }
        let mut node_ids = vec![rule.when, rule.actual, rule.expectation, rule.recovery];
        node_ids.extend(
            [
                rule.each,
                rule.fix,
                rule.affected,
                rule.translation_origin,
                rule.extra,
                rule.shadowed,
            ]
            .into_iter()
            .flatten(),
        );
        let mut seen = HashSet::new();
        while let Some(id) = node_ids.pop() {
            if !seen.insert(id) {
                continue;
            }
            let node = &nodes[id];
            node_ids.extend_from_slice(&node.args);
            if let Some(reference) = node.op.reference() {
                if subjects
                    .get(reference)
                    .is_some_and(|subject| *subject != rule.rule.subject)
                {
                    fault.at(Some(&rule.rule.id), RuleProblemCode::InvalidExpression);
                    return Err(invalid(format!(
                        "Rule {} reads the findings of {reference}, a rule of another subject.",
                        rule.rule.id
                    )));
                }
                if let Some(dependency) = rules.iter().position(|rule| rule.rule.id == reference) {
                    visit(
                        dependency, rules, nodes, subjects, visiting, visited, order, fault,
                    )?;
                }
            }
        }
        visiting.remove(&index);
        visited.insert(index);
        order.push(index);
        Ok(())
    }
    for index in 0..compiled.len() {
        visit(
            index,
            &compiled,
            &compiler.nodes,
            &subjects,
            &mut visiting,
            &mut visited,
            &mut order,
            fault,
        )?;
    }
    fault.at(None, RuleProblemCode::InvalidStructure);
    let mut compiled: Vec<Option<CompiledRule>> = compiled.into_iter().map(Some).collect();
    let rules: Vec<CompiledRule> = order
        .into_iter()
        .filter_map(|index| compiled[index].take())
        .collect();
    // Diagnostics are independent of rule selection and share the same grammar DAG nodes.
    let mut field = |name: &str| compiler.node(Op::Field(name.into()), Vec::new(), Type::String);
    let culture = field("culture")?;
    let source = field("line.comparisonSource")?;
    let latest = field("latest")?;
    let diagnostic_patterns = [
        compiler.node(Op::FormatPattern, vec![source, culture], Type::Object)?,
        compiler.node(Op::FormatPattern, vec![latest, culture], Type::Object)?,
    ];
    let mut node_last_consumer = vec![[0; 3]; compiler.nodes.len()];
    let mut rule_last_reader =
        vec![0; rules.iter().map(|rule| rule.ordinal + 1).max().unwrap_or(0)];
    for (subject_index, subject) in [Subject::Line, Subject::LineCulture, Subject::UnitSource]
        .into_iter()
        .enumerate()
    {
        let subject_rules = rules
            .iter()
            .filter(|rule| rule.rule.subject == subject)
            .collect::<Vec<_>>();
        for (execution, rule) in subject_rules.iter().enumerate() {
            rule_last_reader[rule.ordinal] = execution;
        }
        for (execution, rule) in subject_rules.iter().enumerate() {
            let mut stack = vec![rule.when, rule.actual, rule.expectation, rule.recovery];
            stack.extend(
                [
                    rule.each,
                    rule.fix,
                    rule.affected,
                    rule.translation_origin,
                    rule.extra,
                    rule.shadowed,
                ]
                .into_iter()
                .flatten(),
            );
            let mut seen = HashSet::new();
            while let Some(id) = stack.pop() {
                if !seen.insert(id) {
                    continue;
                }
                node_last_consumer[id][subject_index] =
                    node_last_consumer[id][subject_index].max(execution);
                let node = &compiler.nodes[id];
                stack.extend_from_slice(&node.args);
                if let Some(reference) = node.op.reference()
                    && let Some(target) = rules.iter().find(|rule| rule.rule.id == reference)
                {
                    rule_last_reader[target.ordinal] =
                        rule_last_reader[target.ordinal].max(execution);
                }
            }
        }
        if subject == Subject::LineCulture {
            let mut stack = diagnostic_patterns.to_vec();
            let mut seen = HashSet::new();
            while let Some(id) = stack.pop() {
                if seen.insert(id) {
                    node_last_consumer[id][subject_index] =
                        node_last_consumer[id][subject_index].max(subject_rules.len());
                    stack.extend_from_slice(&compiler.nodes[id].args);
                }
            }
        }
    }
    Ok(Program {
        node_last_consumer,
        rule_last_reader,
        nodes: compiler.nodes,
        rules,
        roles,
        document_roles,
        diagnostic_patterns,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::process::Command;

    /// A one-rule document around `when`, plus extra rule fields as JSON members.
    fn document(when: &str, extra: &str) -> String {
        format!(
            r#"{{"schemaVersion":4,"roles":[],"rules":[{{"id":"a","kind":"a","label":"A","subject":"line","family":"builtin","severity":"low","when":{when},"actual":{{"object":{{}}}},"expectation":{{"object":{{}}}},"recovery":{{"lit":"Review it."}}{extra}}}]}}"#
        )
    }
    fn rejected(text: &str) -> bool {
        compile(text).is_err_and(|error| error.code == ErrorCode::InvalidInput)
    }

    #[test]
    fn literals_are_explicit_and_arity_is_part_of_the_type() -> Result<()> {
        compile(&document(r#"{"lit":true}"#, ""))?;
        assert!(rejected(&document("true", "")));
        assert!(rejected(&document(r#"{"eq":[{"lit":1}]}"#, "")));
        assert!(rejected(&document(
            r#"{"eq":[{"lit":1},{"lit":1},{"lit":1}]}"#,
            ""
        )));
        assert!(rejected(&document(r#"{"unknown":[]}"#, "")));
        assert!(rejected(&document(r#"{"not":{"lit":true},"and":[]}"#, "")));
        Ok(())
    }

    #[test]
    fn rejects_missing_parameters_duplicate_ids_unknown_roles_and_cycles() -> Result<()> {
        assert!(rejected(&document(r#"{"param":"missing"}"#, "")));
        let rule = document(r#"{"lit":true}"#, "");
        let rule = &rule[rule.find(r#"{"id""#).ok_or("Missing rule.")?..rule.len() - 2];
        assert!(rejected(&format!(
            r#"{{"schemaVersion":4,"roles":[],"rules":[{rule},{rule}]}}"#
        )));
        assert!(rejected(&document(
            r#"{"lit":true}"#,
            r#","role":"missing""#
        )));
        let cycle = compile(&document(r#"{"finding":"a"}"#, "")).err();
        assert!(cycle.is_some_and(|error| error.to_string().contains("rule_cycle")));
        Ok(())
    }

    #[test]
    fn a_check_names_the_rule_at_fault_and_what_is_wrong() -> Result<()> {
        let problem =
            |json: &str| serde_json::to_value(check(json)).map(|value| value["problem"].clone());
        assert_eq!(problem(&document(r#"{"lit":true}"#, ""))?, Value::Null);
        assert_eq!(
            problem(&document(r#"{"finding":"a"}"#, ""))?,
            serde_json::json!({"ruleId":"a","code":"rule_cycle","message":"rule_cycle: rule a reads its own findings through finding."})
        );
        for expression in [r#"{"unknown":[]}"#, r#"{"param":"missing"}"#] {
            let problem = problem(&document(expression, ""))?;
            assert_eq!(problem["ruleId"], "a");
            assert_eq!(problem["code"], "invalid_expression");
        }
        let broken = problem("{")?;
        assert_eq!(broken["code"], "invalid_structure");
        assert!(broken.get("ruleId").is_none());
        Ok(())
    }

    #[test]
    fn rejects_a_literal_regex_the_engine_cannot_run() -> Result<()> {
        let test = |pattern: &str| {
            document(
                &format!(
                    r#"{{"regexTest":[{{"field":"source"}},{{"lit":"{pattern}"}},{{"lit":"u"}}]}}"#
                ),
                "",
            )
        };
        compile(&test("(?<=a)b"))?;
        let varying = compile(&test("(?<=a+)b")).err();
        assert!(varying.is_some_and(|error| {
            error.code == ErrorCode::InvalidInput
                && error
                    .to_string()
                    .contains("Rule a has a regular expression")
        }));
        Ok(())
    }

    #[test]
    fn nesting_is_bounded_by_the_reader_as_a_typed_error() -> Result<()> {
        // The document, its rule list and the rule are three levels; each `not` adds one.
        let nested = |levels: usize| {
            document(
                &format!(
                    "{}{}{}",
                    r#"{"not":"#.repeat(levels - 4),
                    r#"{"lit":true}"#,
                    "}".repeat(levels - 4)
                ),
                "",
            )
        };
        let (at_limit, past_limit) = (nested(127), nested(128));
        // A small stack proves the limit is reached before the stack is.
        std::thread::Builder::new()
            .stack_size(1 << 20)
            .spawn(move || -> Result<()> {
                compile(&at_limit)?;
                assert!(rejected(&past_limit));
                Ok(())
            })?
            .join()
            .map_err(|_| "The nesting test thread panicked.")?
    }
    #[test]
    fn compiles_the_typescript_catalogue_and_shares_subexpressions() -> Result<()> {
        let output = Command::new("node").args(["--import", "tsx", "--input-type=module", "-e", "import {effectiveRuleDocument} from './packages/game-text/src/rules/effective.ts'; import {STARTER_CHECK_RULES} from './packages/game-text/src/starter-rules.ts'; process.stdout.write(JSON.stringify(effectiveRuleDocument(STARTER_CHECK_RULES)));"])
            .current_dir(std::path::Path::new(env!("CARGO_MANIFEST_DIR")).ancestors().nth(2).ok_or("Missing repository root.")?).output()?;
        require(
            output.status.success(),
            std::str::from_utf8(&output.stderr)?,
        )?;
        let program = compile(std::str::from_utf8(&output.stdout)?)?;
        // Every built-in but segment_separator, which needs a separator.
        assert_eq!(program.rules.len(), 25);
        assert_eq!(
            program
                .nodes
                .iter()
                .filter(|node| node.op == Op::FormatPattern)
                .count(),
            2
        );
        Ok(())
    }
}
