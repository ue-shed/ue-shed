//! A query's `where` (Phase 4 §6): the shapes Browse writes in the rule IR, compiled to the row
//! tests today's kernels run. Each conjunct is one cached row set.
use crate::Result;
use crate::engine_asset_types::AssetTypes;
use crate::engine_match::{Kind, Projection, TranslationRows};
use crate::engine_places::{Places, Prefix};
use crate::engine_query::{EngineQuery, audience, mask};
use crate::engine_types::{
    AUDIENCES, FACT_SHIFT, FACTS, ORIGINS, PROBLEMS, REVIEWS, STATES, invalid,
};
use crate::join_policy::characters;
use crate::require;
use crate::rules::FindingRows;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::HashSet;
use std::sync::Arc;
use std::sync::atomic::AtomicBool;
#[cfg(test)]
use ts_rs::TS;

/// What a facet mark constrains. Counting a facet drops its marks, as the counts' tabs drop
/// `capability`, `withoutNotes` and `kinds`.
#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[cfg_attr(test, derive(TS))]
#[cfg_attr(test, ts(rename = "QueryFacet"))]
#[serde(rename_all = "camelCase")]
pub enum Facet {
    Problem,
    Fact,
    Finding,
    Folder,
    Asset,
    Origin,
    Audience,
    AssetType,
    /// The source-editing capability a place must have.
    Capability,
    /// Places without translator notes.
    WithoutNotes,
    /// The origin kinds a place must have.
    Kinds,
}

/// A field a test reads: of the row, of one of its cultures, or of one of its places.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
pub(crate) enum Field {
    Problems,
    Facts,
    Origins,
    Editing,
    Notes,
    Audience,
    Namespace,
    TranslationKey,
    AssetTypes,
    Sources,
    Paths,
    Files,
    Findings,
    KeyChanged,
    Id,
    State,
    NotSynced,
    Review,
}

/// What an expression is evaluated over.
#[derive(Clone, Copy, PartialEq, Eq)]
enum Within {
    Line,
    Unit,
    Culture,
    Place,
}

/// The values a field holds.
enum Values {
    Labels(&'static [&'static str]),
    Bool,
    /// Strings; `empty` allows the empty string.
    Text {
        empty: bool,
        max: u32,
    },
    /// A gathered `[namespace, key]` with a key.
    Key,
}

struct Spec {
    field: Field,
    name: &'static str,
    list: bool,
    values: Values,
    within: &'static [Within],
}

const ROW: &[Within] = &[Within::Line, Within::Unit];
const ROW_OR_PLACE: &[Within] = &[Within::Line, Within::Unit, Within::Place];
const LINE: &[Within] = &[Within::Line];
const CULTURE: &[Within] = &[Within::Culture];
const TEXT: Values = Values::Text {
    empty: false,
    max: 32767,
};

const FIELDS: [Spec; 18] = [
    Spec {
        field: Field::Problems,
        name: "problems",
        list: true,
        values: Values::Labels(&PROBLEMS),
        within: ROW,
    },
    Spec {
        field: Field::Facts,
        name: "facts",
        list: true,
        values: Values::Labels(&FACTS),
        within: ROW,
    },
    Spec {
        field: Field::Origins,
        name: "origins",
        list: true,
        values: Values::Labels(&ORIGINS),
        within: ROW_OR_PLACE,
    },
    Spec {
        field: Field::Editing,
        name: "editing",
        list: true,
        values: Values::Labels(&["editable", "read_only"]),
        within: ROW_OR_PLACE,
    },
    Spec {
        field: Field::Notes,
        name: "notes",
        list: false,
        values: Values::Bool,
        within: ROW_OR_PLACE,
    },
    Spec {
        field: Field::Audience,
        name: "audience",
        list: false,
        values: Values::Labels(&AUDIENCES),
        within: ROW,
    },
    Spec {
        field: Field::Namespace,
        name: "namespace",
        list: false,
        values: Values::Text {
            empty: true,
            max: 1024,
        },
        within: ROW,
    },
    Spec {
        field: Field::TranslationKey,
        name: "translationKey",
        list: false,
        values: Values::Key,
        within: ROW,
    },
    Spec {
        field: Field::AssetTypes,
        name: "assetTypes",
        list: true,
        values: Values::Text {
            empty: false,
            max: 1024,
        },
        within: ROW,
    },
    Spec {
        field: Field::Sources,
        name: "sources",
        list: true,
        values: TEXT,
        within: ROW,
    },
    Spec {
        field: Field::Paths,
        name: "paths",
        list: true,
        values: Values::Text {
            empty: false,
            max: 512,
        },
        within: ROW_OR_PLACE,
    },
    Spec {
        field: Field::Files,
        name: "files",
        list: true,
        values: Values::Text {
            empty: false,
            max: 1024,
        },
        within: ROW_OR_PLACE,
    },
    Spec {
        field: Field::Findings,
        name: "findings",
        list: true,
        values: Values::Text {
            empty: false,
            max: 256,
        },
        within: ROW,
    },
    Spec {
        field: Field::KeyChanged,
        name: "keyChanged",
        list: false,
        values: Values::Bool,
        within: LINE,
    },
    Spec {
        field: Field::Id,
        name: "id",
        list: false,
        values: TEXT,
        within: LINE,
    },
    Spec {
        field: Field::State,
        name: "state",
        list: false,
        values: Values::Labels(&STATES),
        within: CULTURE,
    },
    Spec {
        field: Field::NotSynced,
        name: "notSynced",
        list: false,
        values: Values::Bool,
        within: CULTURE,
    },
    Spec {
        field: Field::Review,
        name: "review",
        list: true,
        values: Values::Labels(&REVIEWS),
        within: CULTURE,
    },
];

/// Expressions in one `where`, and values in one test.
const MAX_NODES: usize = 1024;
const MAX_VALUES: usize = 5000;

/// A parsed `where`, in the shapes the compiler runs.
#[derive(Clone, Debug, Serialize)]
pub(crate) enum Node {
    Const(bool),
    And(Vec<Node>),
    Or(Vec<Node>),
    Not(Box<Node>),
    /// A scalar field is one of the values; a list field holds one of them.
    Is(Field, Vec<Value>),
    /// The paths hold one under one of the prefixes.
    Under(Vec<String>),
    AnyCulture(Box<Node>),
    EveryCulture(Box<Node>),
    AnyPlace(Box<Node>),
    Facet(Facet, Box<Node>),
}

fn operator(value: &Value) -> Option<(&str, &Value)> {
    let object = value.as_object()?;
    if object.len() != 1 {
        return None;
    }
    object
        .iter()
        .next()
        .map(|(name, value)| (name.as_str(), value))
}

fn arguments<'a, const N: usize>(value: &'a Value, op: &str) -> Result<[&'a Value; N]> {
    value
        .as_array()
        .and_then(|items| <&[Value; N]>::try_from(items.as_slice()).ok())
        .map(|items| items.each_ref())
        .ok_or_else(|| invalid(&format!("{op} takes {N} arguments.")))
}

fn literal<'a>(value: &'a Value, op: &str) -> Result<&'a Value> {
    match operator(value) {
        Some(("lit", value)) => Ok(value),
        _ => Err(invalid(&format!("{op} compares a field with a literal."))),
    }
}

fn is_var(value: &Value, name: &str) -> bool {
    matches!(operator(value), Some(("var", Value::String(var))) if var == name)
}

fn refused(op: &str) -> crate::Error {
    invalid(&format!("A query's where cannot use {op}."))
}

#[derive(Default)]
struct Parser {
    nodes: usize,
}
impl Parser {
    fn field(&self, value: &Value, within: Within) -> Result<&'static Spec> {
        let Some(("field", Value::String(name))) = operator(value) else {
            return Err(invalid("A where test reads a field."));
        };
        let spec = FIELDS
            .iter()
            .find(|spec| spec.name == name)
            .ok_or_else(|| invalid(&format!("A query has no field {name}.")))?;
        require(
            spec.within.contains(&within),
            invalid(&match within {
                Within::Line => format!("{name} is not a field of a line."),
                Within::Unit => format!("{name} is a field of a line, and needs a target."),
                Within::Culture => format!("{name} is not a field of a line's culture."),
                Within::Place => format!("{name} is not a field of a place."),
            }),
        )?;
        Ok(spec)
    }
    fn values(&self, spec: &Spec, values: &[Value]) -> Result<Vec<Value>> {
        require(
            !values.is_empty() && values.len() <= MAX_VALUES,
            invalid(&format!(
                "A {} test names between 1 and {MAX_VALUES} values.",
                spec.name
            )),
        )?;
        for value in values {
            let valid = match (&spec.values, value) {
                (Values::Labels(labels), Value::String(value)) => labels.contains(&value.as_str()),
                (Values::Bool, Value::Bool(_)) => true,
                (Values::Text { empty, max }, Value::String(value)) => {
                    (*empty || !value.is_empty()) && characters(value) <= *max
                }
                (Values::Key, Value::Array(pair)) => matches!(
                    pair.as_slice(),
                    [Value::String(namespace), Value::String(key)]
                        if !key.is_empty() && characters(namespace) <= 32767 && characters(key) <= 32767
                ),
                _ => false,
            };
            require(
                valid,
                invalid(&format!("Invalid {} value {value}.", spec.name)),
            )?;
        }
        Ok(values.to_vec())
    }
    /// One expression. `conjunctive` is whether it is ANDed into its scope, where a facet mark
    /// may stand.
    fn node(&mut self, value: &Value, within: Within, conjunctive: bool) -> Result<Node> {
        self.nodes += 1;
        require(
            self.nodes <= MAX_NODES,
            invalid("A query's where has too many expressions."),
        )?;
        let Some((op, argument)) = operator(value) else {
            return Err(invalid(
                "A where expression is an object naming one operator.",
            ));
        };
        Ok(match op {
            "lit" => Node::Const(
                argument
                    .as_bool()
                    .ok_or_else(|| invalid("A where literal is true or false."))?,
            ),
            "and" | "or" => {
                let items = argument
                    .as_array()
                    .ok_or_else(|| invalid(&format!("{op} takes a list.")))?;
                let nodes = items
                    .iter()
                    .map(|item| self.node(item, within, conjunctive && op == "and"))
                    .collect::<Result<Vec<_>>>()?;
                if op == "and" {
                    Node::And(nodes)
                } else {
                    Node::Or(nodes)
                }
            }
            "not" => Node::Not(Box::new(self.node(argument, within, false)?)),
            "in" | "eq" => {
                let [field, values] = arguments(argument, op)?;
                let spec = self.field(field, within)?;
                require(
                    !spec.list,
                    invalid(&format!("{} is a list: test it with any.", spec.name)),
                )?;
                let values = literal(values, op)?;
                let values = if op == "in" {
                    values
                        .as_array()
                        .ok_or_else(|| invalid("in takes a list literal."))?
                        .as_slice()
                } else {
                    std::slice::from_ref(values)
                };
                Node::Is(spec.field, self.values(spec, values)?)
            }
            "any" => {
                let items = argument
                    .as_array()
                    .filter(|items| (2..=3).contains(&items.len()))
                    .ok_or_else(|| invalid("any takes a list, a body and an optional name."))?;
                let name = match items.get(2) {
                    None => "item",
                    Some(Value::String(name)) => name.as_str(),
                    Some(_) => return Err(invalid("any names its element with a string.")),
                };
                let spec = self.field(&items[0], within)?;
                require(spec.list, invalid(&format!("{} is not a list.", spec.name)))?;
                self.element(spec, &items[1], name)?
            }
            "anyCulture" | "everyCulture" => {
                require(
                    within == Within::Line,
                    invalid(&format!(
                        "{op} tests a line's cultures: it needs a target, outside other quantifiers."
                    )),
                )?;
                let body = Box::new(self.node(argument, Within::Culture, false)?);
                if op == "anyCulture" {
                    Node::AnyCulture(body)
                } else {
                    Node::EveryCulture(body)
                }
            }
            "anyPlace" => {
                require(
                    matches!(within, Within::Line | Within::Unit),
                    invalid("anyPlace tests a row's places, outside other quantifiers."),
                )?;
                Node::AnyPlace(Box::new(self.node(argument, Within::Place, conjunctive)?))
            }
            "facet" => {
                require(
                    conjunctive && within != Within::Culture,
                    invalid("A facet mark must be ANDed into the where or a place's test."),
                )?;
                let [facet, body] = arguments(argument, op)?;
                let facet = serde_json::from_value::<Facet>(facet.clone())
                    .map_err(|_| invalid(&format!("Unknown facet {facet}.")))?;
                Node::Facet(facet, Box::new(self.node(body, within, true)?))
            }
            _ => return Err(refused(op)),
        })
    }
    /// The body of `any` over a list field: membership, or for paths a prefix.
    fn element(&mut self, spec: &Spec, body: &Value, name: &str) -> Result<Node> {
        let prefix = |value: &Value| -> Result<Option<String>> {
            let Some(("pathHasPrefix", arguments)) = operator(value) else {
                return Ok(None);
            };
            let [path, prefix] = self::arguments(arguments, "pathHasPrefix")?;
            require(
                is_var(path, name),
                refused("pathHasPrefix of another value"),
            )?;
            let prefix = literal(prefix, "pathHasPrefix")?;
            match prefix {
                Value::String(value) if !value.is_empty() && characters(value) <= 512 => {
                    Ok(Some(value.clone()))
                }
                _ => Err(invalid("A path prefix is a nonempty string.")),
            }
        };
        if spec.field == Field::Paths {
            let prefixes = match operator(body) {
                Some(("or", Value::Array(items))) => items
                    .iter()
                    .map(|item| prefix(item)?.ok_or_else(|| refused("this test of paths")))
                    .collect::<Result<Vec<_>>>()?,
                _ => vec![prefix(body)?.ok_or_else(|| refused("this test of paths"))?],
            };
            require(
                !prefixes.is_empty() && prefixes.len() <= 50,
                invalid("A paths test names between 1 and 50 prefixes."),
            )?;
            return Ok(Node::Under(prefixes));
        }
        let Some((op @ ("in" | "eq"), arguments)) = operator(body) else {
            return Err(refused(&format!("this test of {}", spec.name)));
        };
        let [element, values] = self::arguments(arguments, op)?;
        require(
            is_var(element, name),
            refused(&format!("this test of {}", spec.name)),
        )?;
        let values = literal(values, op)?;
        let values = if op == "in" {
            values
                .as_array()
                .ok_or_else(|| invalid("in takes a list literal."))?
                .as_slice()
        } else {
            std::slice::from_ref(values)
        };
        Ok(Node::Is(spec.field, self.values(spec, values)?))
    }
}

impl Node {
    /// Parses a `where` over lines (with a target) or units.
    pub fn parse(value: &Value, lines: bool) -> Result<Self> {
        Parser::default().node(value, if lines { Within::Line } else { Within::Unit }, true)
    }
    /// The expression with the marks of `dropped` holding, and every other mark removed.
    pub fn without(&self, dropped: &[Facet]) -> Self {
        let each = |nodes: &[Node]| nodes.iter().map(|node| node.without(dropped)).collect();
        match self {
            Self::And(nodes) => Self::And(each(nodes)),
            Self::Or(nodes) => Self::Or(each(nodes)),
            Self::Not(node) => Self::Not(Box::new(node.without(dropped))),
            Self::AnyCulture(node) => Self::AnyCulture(Box::new(node.without(dropped))),
            Self::EveryCulture(node) => Self::EveryCulture(Box::new(node.without(dropped))),
            Self::AnyPlace(node) => Self::AnyPlace(Box::new(node.without(dropped))),
            Self::Facet(facet, _) if dropped.contains(facet) => Self::Const(true),
            Self::Facet(_, node) => node.without(dropped),
            Self::Const(_) | Self::Is(..) | Self::Under(_) => self.clone(),
        }
    }
    /// The conjuncts, each cached as one row set; `true` has none.
    pub fn conjuncts(self) -> Vec<Self> {
        match self {
            Self::And(nodes) => nodes.into_iter().flat_map(Self::conjuncts).collect(),
            Self::Facet(_, node) => node.conjuncts(),
            Self::Const(true) => Vec::new(),
            node => vec![node],
        }
    }
    fn any(&self, test: &impl Fn(&Self) -> bool) -> bool {
        test(self)
            || match self {
                Self::And(nodes) | Self::Or(nodes) => nodes.iter().any(|node| node.any(test)),
                Self::Not(node)
                | Self::AnyCulture(node)
                | Self::EveryCulture(node)
                | Self::AnyPlace(node)
                | Self::Facet(_, node) => node.any(test),
                Self::Const(_) | Self::Is(..) | Self::Under(_) => false,
            }
    }
    /// Whether a test reads `field`.
    pub fn mentions(&self, field: Field) -> bool {
        self.any(&|node| matches!(node, Self::Is(read, _) if *read == field))
    }
    /// Whether the rows depend on the culture scope: problems and culture quantifiers read it.
    pub fn reads_scope(&self) -> bool {
        self.any(&|node| {
            matches!(
                node,
                Self::AnyCulture(_) | Self::EveryCulture(_) | Self::Is(Field::Problems, _)
            )
        })
    }
    /// Whether the rows depend on the findings layer: problems and findings read it.
    pub fn reads_findings(&self) -> bool {
        self.any(&|node| matches!(node, Self::Is(Field::Problems | Field::Findings, _)))
    }
}

fn strings(values: &[Value]) -> Vec<String> {
    values
        .iter()
        .filter_map(|value| value.as_str().map(str::to_owned))
        .collect()
}

/// A boolean field's mask: bit 0 for false, bit 1 for true.
fn bools(values: &[Value]) -> u32 {
    values
        .iter()
        .filter_map(Value::as_bool)
        .fold(0, |bits, value| bits | (1 << u32::from(value)))
}
fn bit(value: bool) -> u32 {
    1 << u32::from(value)
}

/// What a compiled test reads.
pub(crate) struct Context<'a> {
    pub query: &'a EngineQuery,
    pub projection: &'a Projection,
    pub places: &'a Places,
    /// The culture scope's cultures; empty without a target.
    pub scope: &'a [usize],
    pub localized: bool,
    pub findings: Option<&'a FindingRows>,
    pub cancelled: &'a AtomicBool,
}

/// Where a test is evaluated.
#[derive(Clone, Copy)]
pub(crate) enum At {
    Row(Kind, usize),
    /// A line without saved places, standing as its own place: read-only, with its own fields.
    Fallback(usize),
    /// A line and one culture of its scope.
    Culture(usize, usize),
}

/// A compiled test.
pub(crate) enum Test {
    Const(bool),
    And(Vec<Test>),
    Or(Vec<Test>),
    Not(Box<Test>),
    Problems(Arc<[u32]>, u32),
    Facts(u32),
    Origins(u32),
    Editing(u32),
    Notes(u32),
    Audience(u32),
    Namespace(HashSet<u32>),
    Keys(TranslationRows),
    AssetTypes(Arc<AssetTypes>, Vec<bool>),
    Sources(HashSet<u32>),
    Under(Vec<Prefix>),
    Files(HashSet<u32>),
    /// The named rules' positions in the findings layer; none without one.
    Findings(Vec<usize>),
    KeyChanged(u32),
    Ids(HashSet<usize>),
    State(u32),
    NotSynced(u32),
    Review(u32),
    Cultures {
        every: bool,
        body: Box<Test>,
    },
    Place(Box<Test>),
}

impl Test {
    pub fn compile(node: &Node, c: &Context) -> Result<Self> {
        let each = |nodes: &[Node]| {
            nodes
                .iter()
                .map(|node| Self::compile(node, c))
                .collect::<Result<Vec<_>>>()
        };
        Ok(match node {
            Node::Const(value) => Self::Const(*value),
            Node::And(nodes) => Self::And(each(nodes)?),
            Node::Or(nodes) => Self::Or(each(nodes)?),
            Node::Not(node) => Self::Not(Box::new(Self::compile(node, c)?)),
            Node::Facet(_, node) => Self::compile(node, c)?,
            Node::AnyCulture(node) => Self::Cultures {
                every: false,
                body: Box::new(Self::compile(node, c)?),
            },
            Node::EveryCulture(node) => Self::Cultures {
                every: true,
                body: Box::new(Self::compile(node, c)?),
            },
            Node::AnyPlace(node) => Self::Place(Box::new(Self::compile(node, c)?)),
            Node::Under(prefixes) => Self::Under(
                prefixes
                    .iter()
                    .map(|prefix| c.places.prefix(prefix))
                    .collect::<Result<_>>()?,
            ),
            Node::Is(field, values) => {
                let text = strings(values);
                match field {
                    Field::Problems => {
                        let scope = if c.localized { c.scope } else { &[] };
                        Self::Problems(
                            c.query
                                .problem_column(c.localized, scope, c.findings, c.cancelled)?,
                            mask(&PROBLEMS, &text),
                        )
                    }
                    Field::Facts => Self::Facts(mask(&FACTS, &text)),
                    Field::Origins => Self::Origins(mask(&ORIGINS, &text)),
                    Field::Editing => Self::Editing(mask(&["editable", "read_only"], &text)),
                    Field::Notes => Self::Notes(bools(values)),
                    Field::Audience => Self::Audience(mask(&AUDIENCES, &text)),
                    Field::Namespace => Self::Namespace(c.places.labels(&text, false)),
                    Field::TranslationKey => {
                        let keys = values
                            .iter()
                            .filter_map(|pair| {
                                Some((pair[0].as_str()?.to_owned(), pair[1].as_str()?.to_owned()))
                            })
                            .collect::<Vec<_>>();
                        Self::Keys(c.projection.translation_rows(
                            c.query,
                            c.places,
                            &keys,
                            c.cancelled,
                        )?)
                    }
                    Field::AssetTypes => {
                        let types = AssetTypes::open(c.query, c.cancelled)?;
                        let wanted = types.wanted(&text);
                        Self::AssetTypes(types, wanted)
                    }
                    // Each value is looked up in the dictionary once; rows then compare IDs.
                    Field::Sources => Self::Sources(c.query.source_ids(&text)?),
                    Field::Paths => return Err("Paths are tested by prefix.".into()),
                    Field::Files => Self::Files(c.places.labels(&text, true)),
                    // A saved pill can name a rule the project has since dropped: no row has it.
                    Field::Findings => Self::Findings(
                        c.findings
                            .map(|findings| {
                                text.iter()
                                    .filter_map(|id| findings.rule(id))
                                    .collect::<Vec<_>>()
                            })
                            .unwrap_or_default(),
                    ),
                    Field::KeyChanged => Self::KeyChanged(bools(values)),
                    Field::Id => {
                        let mut picked = HashSet::new();
                        for id in &text {
                            picked.extend(c.query.find_id("line", id)?);
                        }
                        Self::Ids(picked)
                    }
                    Field::State => Self::State(mask(&STATES, &text)),
                    Field::NotSynced => Self::NotSynced(bools(values)),
                    Field::Review => Self::Review(mask(&REVIEWS, &text)),
                }
            }
        })
    }

    pub fn holds(&self, c: &Context, at: At) -> Result<bool> {
        let p = c.projection;
        match self {
            Self::Const(value) => return Ok(*value),
            Self::And(tests) => {
                for test in tests {
                    if !test.holds(c, at)? {
                        return Ok(false);
                    }
                }
                return Ok(true);
            }
            Self::Or(tests) => {
                for test in tests {
                    if test.holds(c, at)? {
                        return Ok(true);
                    }
                }
                return Ok(false);
            }
            Self::Not(test) => return Ok(!test.holds(c, at)?),
            Self::Cultures { every, body } => {
                let At::Row(Kind::Line, row) = at else {
                    return Err("A culture test outside a line.".into());
                };
                for ci in c.scope {
                    if body.holds(c, At::Culture(row, *ci))? != *every {
                        return Ok(!every);
                    }
                }
                return Ok(*every);
            }
            Self::Place(body) => {
                return match at {
                    At::Row(Kind::Raw, _) => body.holds(c, at),
                    // A line with saved places has a place that meets the test when one of its
                    // visible slices does.
                    At::Row(Kind::Line, row) if p.starts[row] != p.starts[row + 1] => {
                        for slice in p.starts[row] as usize..p.starts[row + 1] as usize {
                            if p.slice.visible[slice] != 0
                                && body.holds(c, At::Row(Kind::Slice, slice))?
                            {
                                return Ok(true);
                            }
                        }
                        Ok(false)
                    }
                    At::Row(Kind::Line, row) => body.holds(c, At::Fallback(row)),
                    _ => Err("A place test outside a row.".into()),
                };
            }
            Self::State(_) | Self::NotSynced(_) | Self::Review(_) => {
                let At::Culture(row, ci) = at else {
                    return Err("A culture field outside a culture test.".into());
                };
                let culture = &p.cultures[ci];
                return Ok(match self {
                    Self::State(mask) => (1 << culture.state[row]) & mask != 0,
                    Self::NotSynced(mask) => bit(culture.facts[row] & 8 != 0) & mask != 0,
                    Self::Review(mask) => p.review(c.query, row, ci)? & mask != 0,
                    _ => unreachable!("matched above"),
                });
            }
            _ => {}
        }
        let (kind, row, fallback) = match at {
            At::Row(kind, row) => (kind, row, false),
            At::Fallback(row) => (Kind::Line, row, true),
            At::Culture(..) => return Err("A row field inside a culture test.".into()),
        };
        let line = matches!(kind, Kind::Line);
        let rows = p.rows(kind);
        Ok(match self {
            Self::Problems(column, mask) => column[row] & mask != 0,
            Self::Facts(mask) => {
                (if line {
                    p.flags[row]
                } else {
                    rows.signals[row]
                } >> FACT_SHIFT)
                    & mask
                    != 0
            }
            Self::Origins(mask) => {
                (if line {
                    p.origins[row]
                } else {
                    rows.origins[row]
                }) & mask
                    != 0
            }
            // A line without saved places can only be read.
            Self::Editing(mask) => {
                (if fallback {
                    2
                } else if line {
                    p.editing[row]
                } else {
                    rows.editing[row]
                }) & mask
                    != 0
            }
            Self::Notes(mask) => {
                bit((if line { p.notes[row] } else { rows.notes[row] }) != 0) & mask != 0
            }
            Self::Audience(mask) => {
                let value = audience(if line {
                    p.audience[row]
                } else {
                    rows.audience[row]
                });
                AUDIENCES
                    .iter()
                    .position(|label| *label == value)
                    .is_some_and(|bit| mask & (1 << bit) != 0)
            }
            Self::Namespace(labels) => p
                .namespace(c.places, kind, row)?
                .is_some_and(|value| labels.contains(&value)),
            Self::Keys(keys) => match kind {
                Kind::Line => keys.lines.contains(&(row as u32)),
                Kind::Slice => keys.lines.contains(&p.slice_line[row]),
                Kind::Raw => keys.raw.contains(&(row as u32)),
            },
            Self::AssetTypes(types, wanted) => {
                types.each(p, kind, row, &mut |kind| wanted[kind as usize])?
            }
            // A unit with conflicting sources has each of them.
            Self::Sources(ids) => {
                if line {
                    ids.contains(&p.source[row])
                } else {
                    rows.sources(row).iter().any(|id| ids.contains(id))
                }
            }
            Self::Under(prefixes) => {
                for prefix in prefixes {
                    if p.path_matches(c.places, kind, row, prefix)? {
                        return Ok(true);
                    }
                }
                false
            }
            Self::Files(labels) => p.has_file(c.places, kind, row, labels)?,
            Self::Findings(rules) => c.findings.is_some_and(|findings| {
                rules.iter().any(|rule| findings.sets[*rule].contains(row))
            }),
            Self::KeyChanged(mask) => {
                bit(p.key_change[row] > 0 && p.key_change[row] & 1 == 0) & mask != 0
            }
            Self::Ids(picked) => picked.contains(&row),
            _ => unreachable!("handled above"),
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn parse(value: Value, lines: bool) -> Result<Node> {
        Node::parse(&value, lines)
    }

    #[test]
    fn browse_shapes_parse_and_other_expressions_are_refused_by_name() -> Result<()> {
        let valid = json!({"and":[
            {"facet":["problem",{"any":[{"field":"problems"},{"in":[{"var":"item"},{"lit":["translation"]}]}]}]},
            {"not":{"in":[{"field":"audience"},{"lit":["editor"]}]}},
            {"eq":[{"field":"keyChanged"},{"lit":true}]},
            {"anyCulture":{"or":[{"in":[{"field":"state"},{"lit":["not_synced"]}]},{"eq":[{"field":"notSynced"},{"lit":true}]}]}},
            {"anyPlace":{"and":[
                {"facet":["capability",{"any":[{"field":"editing"},{"eq":[{"var":"place"},{"lit":"editable"}]},"place"]}]},
                {"facet":["withoutNotes",{"eq":[{"field":"notes"},{"lit":false}]}]},
                {"any":[{"field":"paths"},{"or":[{"pathHasPrefix":[{"var":"item"},{"lit":"/Game/UI"}]}]}]}
            ]}},
            {"in":[{"field":"translationKey"},{"lit":[["UI","Title"]]}]},
            {"in":[{"field":"id"},{"lit":["line:K"]}]}
        ]});
        let node = parse(valid, true)?;
        assert!(node.mentions(Field::KeyChanged));
        assert!(node.reads_scope() && node.reads_findings());
        let kept = node.without(&[Facet::Capability]).conjuncts();
        assert_eq!(kept.len(), 7);
        let place = serde_json::to_string(&kept[4])?;
        assert!(!place.contains("Facet") && !place.contains("Editing") && place.contains("Notes"));
        for (value, lines, message) in [
            (
                json!({"utf16Length":[{"field":"source"}]}),
                true,
                "cannot use utf16Length",
            ),
            (json!({"anyCulture":{"lit":true}}), false, "needs a target"),
            (
                json!({"eq":[{"field":"keyChanged"},{"lit":true}]}),
                false,
                "needs a target",
            ),
            (
                json!({"in":[{"field":"problems"},{"lit":["finding"]}]}),
                true,
                "is a list",
            ),
            (
                json!({"any":[{"field":"problems"},{"in":[{"var":"item"},{"lit":["shared"]}]}]}),
                true,
                "Invalid problems value",
            ),
            (
                json!({"not":{"facet":["origin",{"lit":true}]}}),
                true,
                "facet mark",
            ),
            (
                json!({"in":[{"field":"translationKey"},{"lit":[["UI",""]]}]}),
                true,
                "Invalid translationKey",
            ),
            (
                json!({"anyPlace":{"in":[{"field":"audience"},{"lit":["player"]}]}}),
                true,
                "not a field of a place",
            ),
            (
                json!({"in":[{"field":"sources"},{"lit":[]}]}),
                true,
                "is a list",
            ),
            (
                json!({"any":[{"field":"sources"},{"in":[{"var":"item"},{"lit":[]}]}]}),
                true,
                "between 1",
            ),
        ] {
            let error = parse(value.clone(), lines)
                .err()
                .ok_or(format!("{value}"))?;
            assert_eq!(error.code, crate::ErrorCode::InvalidInput);
            assert!(error.to_string().contains(message), "{value}: {error}");
        }
        Ok(())
    }
}
